/**
 * background.js — WebGaze service worker
 *
 * Architecture (content-script approach):
 *   popup.js  →  background.js  →  content.js (WebGazer lives here)
 *                     ↕
 *               chrome.scripting injects webgazer.js into the active tab,
 *               then sends START_WEBGAZER. Content script runs webgazer.begin()
 *               which triggers a visible camera prompt in the real tab —
 *               this works because content scripts share the tab's browsing context.
 *
 * Message API:
 *   START_SESSION   { aois? }          → starts session, injects WebGazer  (from popup)
 *   STOP_SESSION    {}                  → tears down session  (from popup)
 *   RECALIBRATE     {}                  → reset to calibration phase  (from popup)
 *   CAL_DONE        {}                  → advances phase to tracking  (from content)
 *   GAZE_POINT      { x, y, ts, url }  → records point  (from content)
 *   GET_STATE       {}                  → state snapshot  (from popup / content)
 *   EXPORT          {}                  → full session JSON  (from popup)
 *   RESET           {}                  → clears everything  (from popup)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  phase: 'idle',          // 'idle' | 'calibrating' | 'tracking'
  sessionId: null,
  startedAt: null,
  gazePoints: [],         // [{ x, y, ts, url }]
  dwellTimes: {},         // { url: { aoi_label: ms } }
  aois: [],               // [{ label, x, y, w, h }]
  calibrationPoints: 0,
};

let state = { ...DEFAULT_STATE };
let activeTabId = null;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function persistState() {
  await chrome.storage.local.set({ webgazeState: state });
}

async function loadState() {
  const result = await chrome.storage.local.get('webgazeState');
  if (result.webgazeState) {
    state = result.webgazeState;
  }
}

// Boot: restore any saved state
loadState();

// ---------------------------------------------------------------------------
// Dwell time tracking
// ---------------------------------------------------------------------------

function updateDwellTimes(gazePoint) {
  const { x, y, url } = gazePoint;
  if (!state.dwellTimes[url]) {
    state.dwellTimes[url] = {};
  }
  const urlDwells = state.dwellTimes[url];
  for (const aoi of state.aois) {
    if (x >= aoi.x && x <= aoi.x + aoi.w && y >= aoi.y && y <= aoi.y + aoi.h) {
      const label = aoi.label || `aoi_${aoi.x}_${aoi.y}`;
      urlDwells[label] = (urlDwells[label] || 0) + 33; // ~30 fps → ~33ms per point
    }
  }
}

// ---------------------------------------------------------------------------
// Export builder
// ---------------------------------------------------------------------------

function buildExport() {
  const duration = state.startedAt ? Date.now() - state.startedAt : 0;
  const pageSummaries = {};
  for (const [url, dwells] of Object.entries(state.dwellTimes)) {
    const points = state.gazePoints.filter(p => p.url === url);
    pageSummaries[url] = { gazePointCount: points.length, dwellTimes: dwells };
  }
  return {
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    exportedAt: Date.now(),
    durationMs: duration,
    totalGazePoints: state.gazePoints.length,
    aois: state.aois,
    pageSummaries,
    gazePoints: state.gazePoints,
  };
}

// ---------------------------------------------------------------------------
// Active tab helper
// ---------------------------------------------------------------------------

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {

    case 'START_SESSION': {
      (async () => {
        if (state.phase !== 'idle') {
          sendResponse({ ok: false, error: 'Session already active' });
          return;
        }

        const tab = await getActiveTab();
        activeTabId = tab ? tab.id : null;

        if (!activeTabId) {
          sendResponse({ ok: false, error: 'No active tab found' });
          return;
        }

        state = {
          ...DEFAULT_STATE,
          phase: 'calibrating',
          sessionId: `session_${Date.now()}`,
          startedAt: Date.now(),
          aois: (payload && payload.aois) || [],
          gazePoints: [],
          dwellTimes: {},
          calibrationPoints: 0,
        };
        await persistState();

        // Respond to popup immediately
        sendResponse({ ok: true, state });

        // Inject WebGazer into the active tab then kick off calibration.
        // webgazer.begin() inside the content script triggers the camera
        // permission prompt in the visible tab — this works reliably.
        try {
          await chrome.scripting.executeScript({
            target: { tabId: activeTabId },
            files: ['lib/webgazer.js'],
          });
          console.log('[background] webgazer.js injected into tab', activeTabId);
        } catch (err) {
          console.error('[background] Failed to inject webgazer.js:', err);
          state = { ...DEFAULT_STATE };
          persistState();
          sendResponse({ ok: false, error: 'Script injection failed: ' + err.message });
          return;
        }

        // Tell content script to start WebGazer (camera + calibration)
        chrome.tabs.sendMessage(activeTabId, { type: 'START_WEBGAZER' }).catch(err => {
          console.error('[background] START_WEBGAZER failed:', err);
        });
      })();
      return true; // async
    }

    case 'CAL_DONE': {
      // Calibration sequence complete; content script transitions to tracking
      state.phase = 'tracking';
      state.startedAt = Date.now();
      persistState();
      // Tell content to start rendering the gaze dot + heatmap
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, { type: 'CALIBRATION_COMPLETE' }).catch(() => {});
      }
      sendResponse({ ok: true, state });
      break;
    }

    case 'GAZE_POINT': {
      // From content script: a WebGazer prediction arrived
      if (state.phase !== 'tracking') {
        sendResponse({ ok: false });
        break;
      }
      const point = {
        x: payload.x,
        y: payload.y,
        ts: payload.ts || Date.now(),
        url: payload.url || '',
      };
      state.gazePoints.push(point);
      updateDwellTimes(point);

      // Throttle storage writes
      if (state.gazePoints.length % 50 === 0) {
        persistState();
      }
      sendResponse({ ok: true });
      break;
    }

    case 'RECALIBRATE': {
      if (state.phase === 'idle') {
        sendResponse({ ok: false, error: 'No active session' });
        break;
      }
      state.phase = 'calibrating';
      state.calibrationPoints = 0;
      persistState();
      // Tell WebGazer in content script to clear its data and re-show calibration
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, { type: 'RECALIBRATE_WEBGAZER' }).catch(() => {});
      }
      sendResponse({ ok: true, state });
      break;
    }

    case 'STOP_SESSION': {
      (async () => {
        if (state.phase === 'idle') {
          sendResponse({ ok: false, error: 'No active session' });
          return;
        }
        state.phase = 'idle';
        await persistState();

        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, { type: 'STOP_SESSION' }).catch(() => {});
        }
        activeTabId = null;

        sendResponse({ ok: true });
      })();
      return true; // async
    }

    case 'GET_STATE': {
      sendResponse({ ok: true, state });
      break;
    }

    case 'EXPORT': {
      const exportData = buildExport();
      sendResponse({ ok: true, data: exportData });
      break;
    }

    case 'RESET': {
      state = { ...DEFAULT_STATE };
      chrome.storage.local.remove('webgazeState');
      sendResponse({ ok: true });
      break;
    }

    default:
      sendResponse({ ok: false, error: `Unknown message type: ${type}` });
  }

  return true;
});

// ---------------------------------------------------------------------------
// Tab navigation: tag gaze points with the correct URL on SPA navigation
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.phase === 'tracking' && tabId === activeTabId) {
    chrome.tabs.sendMessage(tabId, {
      type: 'TAB_NAVIGATED',
      payload: { url: tab.url },
    }).catch(() => {});
  }
});
