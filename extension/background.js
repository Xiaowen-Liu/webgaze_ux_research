/**
 * background.js — WebGaze service worker
 *
 * Holds session state in memory and persists to chrome.storage.local so state
 * survives service-worker restarts.
 *
 * Message API (chrome.runtime.sendMessage / onMessage):
 *   START_SESSION   { aois? }          → ack
 *   STOP_SESSION    {}                  → ack
 *   GAZE_POINT      { x, y, ts, url }  → ack
 *   GET_STATE       {}                  → state snapshot
 *   EXPORT          {}                  → full session JSON
 *   CALIBRATION_DONE {}                 → ack, advances phase
 *   RESET           {}                  → clears everything
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

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function persistState() {
  // Only persist lightweight summary; full gazePoints array is kept in memory
  // but also written so state survives SW restart.
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

  // Per-URL page summaries
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
// Message handlers
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {

    case 'START_SESSION': {
      if (state.phase !== 'idle') {
        sendResponse({ ok: false, error: 'Session already active' });
        break;
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
      persistState();
      sendResponse({ ok: true, state });
      break;
    }

    case 'CALIBRATION_DONE': {
      if (state.phase === 'calibrating') {
        state.phase = 'tracking';
        persistState();
      }
      sendResponse({ ok: true, state });
      break;
    }

    case 'STOP_SESSION': {
      if (state.phase === 'idle') {
        sendResponse({ ok: false, error: 'No active session' });
        break;
      }
      state.phase = 'idle';
      persistState();
      sendResponse({ ok: true, state });
      break;
    }

    case 'GAZE_POINT': {
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

      // Throttle storage writes — persist every 50 points
      if (state.gazePoints.length % 50 === 0) {
        persistState();
      }
      sendResponse({ ok: true });
      break;
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

  // Return true to keep the message channel open for async sendResponse
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
    }).catch(() => {
      // Content script may not be ready yet; ignore.
    });
  }
});
