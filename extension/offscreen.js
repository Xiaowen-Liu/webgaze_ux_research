/**
 * offscreen.js — WebGaze Offscreen Document script
 *
 * Runs inside chrome-extension://…/offscreen.html — an extension page with its
 * own CSP that freely allows fetching TensorFlow face models from tfhub.dev.
 *
 * Message protocol (all messages carry { target, type, payload }):
 *   FROM background → offscreen:
 *     OFFSCREEN_START          — initialise WebGazer and begin prediction
 *     OFFSCREEN_CAL_CLICK      — { x, y } record a calibration sample
 *     OFFSCREEN_CAL_DONE       — calibration complete; prediction already running
 *     OFFSCREEN_STOP           — shut WebGazer down
 *
 *   FROM offscreen → background (via chrome.runtime.sendMessage):
 *     GAZE_POINT               — { x, y, ts } prediction from WebGazer
 */

'use strict';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let webgazerReady = false;
let gazeListenerAttached = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to the background service worker.
 * offscreen → background routing works via the normal runtime channel.
 */
function sendToBackground(type, payload) {
  chrome.runtime.sendMessage({ type, payload }).catch((err) => {
    // Background may have restarted; log but don't crash.
    console.warn('[offscreen] sendMessage error:', err);
  });
}

// ---------------------------------------------------------------------------
// WebGazer lifecycle
// ---------------------------------------------------------------------------

async function startWebGazer() {
  if (webgazerReady) return;

  if (!window.webgazer) {
    console.error('[offscreen] webgazer not available — check offscreen.html script order');
    return;
  }

  try {
    // Configure before begin()
    window.webgazer
      .setRegression('ridge')
      .setTracker('TFFaceMesh')
      .showPredictionPoints(false)   // We don't show anything in offscreen page
      .showVideoPreview(false);      // Offscreen page has no visible UI

    // Attach gaze listener — fires at ~30 Hz once begin() resolves
    if (!gazeListenerAttached) {
      window.webgazer.setGazeListener((data, elapsedTime) => {
        if (!data) return;
        sendToBackground('GAZE_POINT', {
          x: Math.round(data.x),
          y: Math.round(data.y),
          ts: Date.now(),
        });
      });
      gazeListenerAttached = true;
    }

    await window.webgazer.begin();
    webgazerReady = true;
    console.log('[offscreen] WebGazer started');
  } catch (err) {
    console.error('[offscreen] WebGazer begin() failed:', err);
  }
}

function recordCalClick(x, y) {
  if (!webgazerReady || !window.webgazer) {
    console.warn('[offscreen] recordCalClick called before WebGazer ready');
    return;
  }
  window.webgazer.recordScreenPosition(x, y, 'click');
}

function stopWebGazer() {
  if (!webgazerReady || !window.webgazer) return;
  try {
    window.webgazer.end();
  } catch (err) {
    console.warn('[offscreen] webgazer.end() error:', err);
  }
  webgazerReady = false;
  gazeListenerAttached = false;
  console.log('[offscreen] WebGazer stopped');
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Filter: only handle messages targeted at this offscreen document
  if (message.target !== 'offscreen') return;

  const { type, payload } = message;

  switch (type) {
    case 'OFFSCREEN_START':
      startWebGazer()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep channel open for async response

    case 'OFFSCREEN_CAL_CLICK':
      if (payload && typeof payload.x === 'number' && typeof payload.y === 'number') {
        recordCalClick(payload.x, payload.y);
      }
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_CAL_DONE':
      // Prediction is already running from begin(); calibration phase is now
      // complete — no extra action needed in WebGazer beyond continuing to predict.
      console.log('[offscreen] Calibration done — prediction continues');
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_STOP':
      stopWebGazer();
      sendResponse({ ok: true });
      break;

    default:
      // Unknown offscreen-targeted message; log and ignore.
      console.warn('[offscreen] Unknown message type:', type);
      sendResponse({ ok: false, error: `Unknown type: ${type}` });
  }
});

console.log('[offscreen] Offscreen document ready, waiting for OFFSCREEN_START');
