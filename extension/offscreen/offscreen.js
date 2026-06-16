/**
 * offscreen.js — WebGaze Offscreen Document script
 *
 * Runs inside chrome-extension://…/offscreen/offscreen.html — an extension page
 * with its own CSP that freely allows fetching TensorFlow face models from tfhub.dev.
 *
 * Message protocol (all messages carry { target, type, payload }):
 *   FROM background → offscreen (target: 'offscreen'):
 *     OFFSCREEN_START          — initialise WebGazer and begin prediction
 *     OFFSCREEN_CAL_CLICK      — { x, y } record a calibration sample
 *     OFFSCREEN_STOP           — shut WebGazer down
 *
 *   FROM offscreen → background (via chrome.runtime.sendMessage):
 *     GAZE_POINT               — { x, y, ts } prediction from WebGazer
 */

'use strict';

let webgazerStarted = false;

// ---------------------------------------------------------------------------
// WebGazer lifecycle
// ---------------------------------------------------------------------------

async function startWebGazer() {
  if (webgazerStarted) return;

  if (!window.webgazer) {
    console.error('[offscreen] webgazer not available on window');
    return;
  }

  window.webgazer
    .setRegression('ridge')
    .setTracker('TFFaceMesh')
    .showPredictionPoints(false)
    .showVideoPreview(false)
    .setGazeListener((data, ts) => {
      if (!data) return;
      chrome.runtime.sendMessage({
        type: 'GAZE_POINT',
        payload: { x: Math.round(data.x), y: Math.round(data.y), ts: Date.now() },
      }).catch(() => {});
    });

  await window.webgazer.begin();
  webgazerStarted = true;
  console.log('[offscreen] WebGazer started');
}

function recordCalClick(x, y) {
  if (!webgazerStarted || !window.webgazer) {
    console.warn('[offscreen] recordCalClick called before WebGazer ready');
    return;
  }
  window.webgazer.recordScreenPosition(x, y, 'click');
}

function stopWebGazer() {
  if (!webgazerStarted || !window.webgazer) return;
  try {
    window.webgazer.end();
  } catch (err) {
    console.warn('[offscreen] webgazer.end() error:', err);
  }
  webgazerStarted = false;
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

    case 'OFFSCREEN_CLEAR_CAL':
      if (webgazerStarted && window.webgazer) {
        try { window.webgazer.clearData(); } catch (e) { /* ignore */ }
      }
      sendResponse({ ok: true });
      break;

    case 'OFFSCREEN_STOP':
      stopWebGazer();
      sendResponse({ ok: true });
      break;

    default:
      console.warn('[offscreen] Unknown message type:', type);
      sendResponse({ ok: false, error: `Unknown type: ${type}` });
  }
});

console.log('[offscreen] Offscreen document ready, waiting for OFFSCREEN_START');

// Tell background.js we're ready to receive messages.
// background.js waits for this before sending OFFSCREEN_START to avoid a
// race condition where the message arrives before this listener is registered.
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {});
