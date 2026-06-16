/**
 * background.js — WebGaze service worker
 *
 * Holds session state in memory and persists to chrome.storage.local so state
 * survives service-worker restarts.
 *
 * Architecture:
 *   popup.js  →  background.js  →  offscreen.js   (WebGazer lives here)
 *                     ↕                ↕
 *               content.js      sends GAZE_POINT {x,y,ts} up to background
 *          (pure renderer:      receives CAL_CLICK coords from background
 *           dot, heatmap,       calls webgazer.recordScreenPosition on CAL_CLICK
 *           calibration UI)     calls webgazer.end() on STOP
 *
 * Message routing:
 *   Messages TO offscreen: include `target: 'offscreen'` field
 *   Messages TO content: sent via chrome.tabs.sendMessage(tabId, msg)
 *   Messages from offscreen/content TO background: chrome.runtime.sendMessage(msg)
 *
 * Message API:
 *   START_SESSION   { aois? }          → ack  (from popup)
 *   STOP_SESSION    {}                  → ack  (from popup)
 *   CAL_CLICK       { x, y }           → forwards to offscreen  (from content)
 *   CAL_DONE        {}                  → advances phase  (from content)
 *   GAZE_POINT      { x, y, ts }       → records + forwards to content  (from offscreen)
 *   GET_STATE       {}                  → state snapshot  (from popup)
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
// Offscreen ready handshake
// ---------------------------------------------------------------------------
// webgazer.js is ~6 MB; the offscreen document can take several seconds to
// parse and register its onMessage listener AFTER chrome.offscreen.createDocument
// resolves. We use a promise that is resolved by the OFFSCREEN_READY message,
// so OFFSCREEN_START is never sent before the listener is in place.

let _offscreenReadyResolve = null;
let _offscreenReadyPromise = null;

function resetOffscreenReadyPromise() {
  _offscreenReadyPromise = new Promise(resolve => {
    _offscreenReadyResolve = resolve;
    // Safety timeout: resolve after 30 s regardless, so START_SESSION never hangs
    setTimeout(resolve, 30_000);
  });
}
resetOffscreenReadyPromise();

function resolveOffscreenReady() {
  if (_offscreenReadyResolve) {
    _offscreenReadyResolve();
    _offscreenReadyResolve = null;
  }
}

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
// Offscreen document management
// ---------------------------------------------------------------------------

async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'WebGazer requires camera access in extension context to avoid host page CSP restrictions on tfhub.dev model loading',
  });
}

async function closeOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  if (existingContexts.length === 0) return;
  await chrome.offscreen.closeDocument();
}

function sendToOffscreen(type, payload = {}) {
  chrome.runtime.sendMessage({ target: 'offscreen', type, payload }).catch(() => {});
}

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
    pageSummaries[url] = {
      gazePointCount: points.length,
      dwellTimes: dwells,
    };
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

  // Ignore messages targeted at offscreen (they pass through the runtime channel
  // but background should not process them)
  if (message.target === 'offscreen') return;

  switch (type) {

    case 'START_SESSION': {
      (async () => {
        if (state.phase !== 'idle') {
          sendResponse({ ok: false, error: 'Session already active' });
          return;
        }

        // Capture active tab before opening offscreen (which may shift focus)
        const tab = await getActiveTab();
        activeTabId = tab ? tab.id : null;

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

        // Reset the handshake promise before creating a new offscreen doc so
        // we don't accidentally reuse a resolved promise from a previous session.
        resetOffscreenReadyPromise();
        await ensureOffscreenDocument();
        // Wait until offscreen.js has registered its onMessage listener.
        await _offscreenReadyPromise;
        sendToOffscreen('OFFSCREEN_START');

        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, { type: 'SHOW_CALIBRATION' }).catch(() => {});
        }

        sendResponse({ ok: true, state });
      })();
      return true; // async
    }

    case 'OFFSCREEN_READY': {
      // offscreen.js signals it has loaded and registered its message listener.
      resolveOffscreenReady();
      console.log('[background] Offscreen document ready');
      sendResponse({ ok: true });
      break;
    }

    case 'RECALIBRATE': {
      // User clicked "Recalibrate" in popup: reset to calibration phase and
      // clear WebGazer's training data without tearing down the offscreen doc.
      if (state.phase === 'idle') {
        sendResponse({ ok: false, error: 'No active session' });
        break;
      }
      state.phase = 'calibrating';
      state.calibrationPoints = 0;
      await persistState();
      sendToOffscreen('OFFSCREEN_CLEAR_CAL');  // offscreen calls webgazer.clearData()
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, { type: 'SHOW_CALIBRATION' }).catch(() => {});
      }
      sendResponse({ ok: true, state });
      break;
    }

    case 'CAL_CLICK': {
      // Forwarded from content script: a calibration dot was clicked
      const { x, y } = payload || {};
      if (typeof x === 'number' && typeof y === 'number') {
        sendToOffscreen('OFFSCREEN_CAL_CLICK', { x, y });
      }
      sendResponse({ ok: true });
      break;
    }

    case 'CAL_DONE': {
      // Calibration sequence complete in content script
      state.phase = 'tracking';
      state.startedAt = Date.now();
      persistState();
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, { type: 'CALIBRATION_COMPLETE' }).catch(() => {});
      }
      sendResponse({ ok: true, state });
      break;
    }

    case 'GAZE_POINT': {
      // From offscreen document: a WebGazer prediction arrived
      if (state.phase !== 'tracking') {
        sendResponse({ ok: false });
        break;
      }

      // Attach the current tab URL if sender is offscreen (no tab URL available)
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

      // Forward coordinates to the active content tab for rendering
      if (activeTabId !== null) {
        chrome.tabs.sendMessage(activeTabId, {
          type: 'RENDER_GAZE',
          payload: { x: payload.x, y: payload.y },
        }).catch(() => {});
      }

      sendResponse({ ok: true });
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

        sendToOffscreen('OFFSCREEN_STOP');
        await closeOffscreenDocument();

        if (activeTabId !== null) {
          chrome.tabs.sendMessage(activeTabId, { type: 'STOP_SESSION' }).catch(() => {});
        }

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
// Tab navigation: notify content script about URL changes so gaze points
// are tagged with the correct URL even on SPAs.
// ---------------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && state.phase === 'tracking') {
    chrome.tabs.sendMessage(tabId, {
      type: 'TAB_NAVIGATED',
      payload: { url: tab.url },
    }).catch(() => {});

    // Update activeTabId if this is the tab that just navigated
    if (tabId === activeTabId) {
      // Tab is still the same; no change needed
    }
  }
});
