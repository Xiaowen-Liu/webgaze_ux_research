/**
 * background.js — WebGaze service worker
 *
 * Architecture (content-script approach):
 *   popup.js  →  background.js  →  content.js (WebGazer lives here)
 *
 * Message API:
 *   START_SESSION        { participantId?, aois? }  → starts session  (from popup)
 *   STOP_SESSION         {}                          → tears down session  (from popup)
 *   RECALIBRATE          {}                          → reset to calibration phase  (from popup)
 *   CAL_DONE             {}                          → advances phase to tracking  (from content)
 *   GAZE_POINT           { x, y, ts, url }           → records point  (from content)
 *   TRIGGER_SCREENSHOT   { reason }                  → captures viewport  (from content)
 *   GET_STATE            {}                          → state snapshot  (from popup / content)
 *   EXPORT               {}                          → full session JSON  (from popup)
 *   OPEN_DASHBOARD       {}                          → opens dashboard tab  (from popup)
 *   RESET                {}                          → clears everything  (from popup)
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  phase: 'idle',            // 'idle' | 'calibrating' | 'tracking'
  sessionId: null,
  participantId: null,
  startedAt: null,
  activeTabId: null,        // persisted so SW restart doesn't lose the tab
  gazePoints: [],           // [{ x, y, ts, url }]  — sampled at ~10fps
  screenshots: [],          // [{ id, capturedAt, url, reason, viewportW, viewportH, dataUrl }]
  dwellTimes: {},           // { url: { aoi_label: ms } }
  aois: [],                 // [{ label, x, y, w, h }]
};

let state = { ...DEFAULT_STATE };

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function persistState() {
  await chrome.storage.local.set({ webgazeState: state });
}

// Batch persist: write at most once every 5 seconds during tracking
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistState();
  }, 5000);
}

async function loadState() {
  const result = await chrome.storage.local.get('webgazeState');
  if (result.webgazeState) {
    state = result.webgazeState;
  }
}

loadState();

// ---------------------------------------------------------------------------
// Screenshot capture
// ---------------------------------------------------------------------------

const SCREENSHOT_MIN_INTERVAL_MS = 500;
let lastScreenshotAt = 0;

async function captureScreenshot(reason = 'manual') {
  if (state.phase !== 'tracking' || !state.activeTabId) return;
  const now = Date.now();
  if (now - lastScreenshotAt < SCREENSHOT_MIN_INTERVAL_MS) return;
  lastScreenshotAt = now;

  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
    const tab = await chrome.tabs.get(state.activeTabId);

    // Ask content script for current viewport size
    let viewportW = 0, viewportH = 0;
    try {
      const dims = await chrome.tabs.sendMessage(state.activeTabId, { type: 'GET_STATE' });
      // viewport dims come separately via GET_VIEWPORT; use tab width as fallback
      viewportW = tab.width  || 0;
      viewportH = tab.height || 0;
    } catch (_) {}

    state.screenshots.push({
      id: `shot_${now}`,
      capturedAt: now,
      url: tab.url || '',
      reason,
      viewportW,
      viewportH,
      dataUrl,
    });

    schedulePersist();
  } catch (e) {
    console.warn('[background] captureVisibleTab failed:', e.message);
  }
}

// ---------------------------------------------------------------------------
// Dwell time tracking
// ---------------------------------------------------------------------------

function updateDwellTimes(gazePoint) {
  const { x, y, url } = gazePoint;
  if (!state.dwellTimes[url]) state.dwellTimes[url] = {};
  const urlDwells = state.dwellTimes[url];
  for (const aoi of state.aois) {
    if (x >= aoi.x && x <= aoi.x + aoi.w && y >= aoi.y && y <= aoi.y + aoi.h) {
      const label = aoi.label || `aoi_${aoi.x}_${aoi.y}`;
      // ~10fps → each stored point represents ~100ms
      urlDwells[label] = (urlDwells[label] || 0) + 100;
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
    // Schema version — makes future backend migration easier
    schemaVersion: '1.0',
    sessionId: state.sessionId,
    participantId: state.participantId || 'anonymous',
    startedAt: state.startedAt,
    exportedAt: Date.now(),
    durationMs: duration,
    totalGazePoints: state.gazePoints.length,
    screenshotCount: state.screenshots.length,
    aois: state.aois,
    pageSummaries,
    gazePoints: state.gazePoints,
    screenshots: state.screenshots,
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
        const tabId = tab ? tab.id : null;

        if (!tabId) {
          sendResponse({ ok: false, error: 'No active tab found' });
          return;
        }

        state = {
          ...DEFAULT_STATE,
          phase: 'calibrating',
          sessionId: `session_${Date.now()}`,
          participantId: (payload && payload.participantId) || 'anonymous',
          startedAt: Date.now(),
          activeTabId: tabId,
          aois: (payload && payload.aois) || [],
          gazePoints: [],
          screenshots: [],
          dwellTimes: {},
        };
        await persistState();

        sendResponse({ ok: true, state });

        try {
          await chrome.scripting.executeScript({
            target: { tabId: state.activeTabId },
            files: ['lib/webgazer.js'],
          });
        } catch (err) {
          console.error('[background] Failed to inject webgazer.js:', err);
          state = { ...DEFAULT_STATE };
          persistState();
          return;
        }

        chrome.tabs.sendMessage(state.activeTabId, { type: 'START_WEBGAZER' }).catch(err => {
          console.error('[background] START_WEBGAZER failed:', err);
        });
      })();
      return true;
    }

    case 'CAL_DONE': {
      state.phase = 'tracking';
      state.startedAt = Date.now();
      persistState();
      if (state.activeTabId !== null) {
        chrome.tabs.sendMessage(state.activeTabId, { type: 'CALIBRATION_COMPLETE' }).catch(() => {});
      }
      // Capture initial screenshot when tracking starts
      captureScreenshot('session_start');
      sendResponse({ ok: true, state });
      break;
    }

    case 'GAZE_POINT': {
      if (state.phase !== 'tracking') {
        sendResponse({ ok: false });
        break;
      }
      const point = {
        x: Math.round(payload.x),
        y: Math.round(payload.y),
        ts: payload.ts || Date.now(),
        url: payload.url || '',
      };
      state.gazePoints.push(point);
      updateDwellTimes(point);
      schedulePersist();
      sendResponse({ ok: true });
      break;
    }

    case 'TRIGGER_SCREENSHOT': {
      const reason = (payload && payload.reason) || 'manual';
      captureScreenshot(reason).catch(() => {});
      sendResponse({ ok: true });
      break;
    }

    case 'RECALIBRATE': {
      if (state.phase === 'idle') {
        sendResponse({ ok: false, error: 'No active session' });
        break;
      }
      state.phase = 'calibrating';
      persistState();
      if (state.activeTabId !== null) {
        chrome.tabs.sendMessage(state.activeTabId, { type: 'RECALIBRATE_WEBGAZER' }).catch(() => {});
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
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
        await persistState();

        if (state.activeTabId !== null) {
          chrome.tabs.sendMessage(state.activeTabId, { type: 'STOP_SESSION' }).catch(() => {});
        }
        state.activeTabId = null;

        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'GET_STATE': {
      sendResponse({ ok: true, state });
      break;
    }

    case 'EXPORT': {
      sendResponse({ ok: true, data: buildExport() });
      break;
    }

    case 'OPEN_DASHBOARD': {
      const url = chrome.runtime.getURL('dashboard/dashboard.html');
      chrome.tabs.create({ url }).catch(() => {});
      sendResponse({ ok: true });
      break;
    }

    case 'RESET': {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
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
// Tab navigation — capture screenshot + tag gaze URL on page change
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== state.activeTabId || state.phase !== 'tracking') return;
  if (changeInfo.status === 'complete') {
    chrome.tabs.sendMessage(tabId, {
      type: 'TAB_NAVIGATED',
      payload: { url: tab.url },
    }).catch(() => {});
    captureScreenshot('url_change');
  }
});
