/**
 * content.js — WebGaze content script
 *
 * Injected into every page. Responsibilities:
 *  - Receive START_WEBGAZER → initialize WebGazer (injected by background.js
 *    via scripting.executeScript) → trigger camera prompt in visible tab
 *  - Show 9-point calibration UI; call webgazer.recordScreenPosition() directly
 *  - EMA-smooth gaze coords (α=0.22), move gaze dot, paint heatmap
 *  - Forward GAZE_POINT to background for storage
 *  - STOP_SESSION → teardown + webgazer.end()
 */

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__webgazeInjected) return;
  window.__webgazeInjected = true;

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const EMA_ALPHA = 0.22;
  const HEATMAP_RADIUS = 40;
  const HEATMAP_DECAY = 0.97; // applied each animation frame
  const CAL_POINTS = [
    { x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }, { x: 0.9, y: 0.1 },
    { x: 0.1, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 },
    { x: 0.1, y: 0.9 }, { x: 0.5, y: 0.9 }, { x: 0.9, y: 0.9 },
  ];
  const CAL_CLICKS_REQUIRED = 5; // clicks per calibration point

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let phase = 'idle'; // 'idle' | 'calibrating' | 'tracking'
  let currentUrl = location.href;
  let webgazerRunning = false;

  // Gaze smoothing (EMA)
  let smoothX = null;
  let smoothY = null;

  // Heatmap data: Float32 accumulation buffer
  let heatBuffer = null;

  // Animation frame handle
  let animFrameId = null;

  // ---------------------------------------------------------------------------
  // DOM: overlay layer
  // ---------------------------------------------------------------------------

  const overlay = document.createElement('div');
  overlay.id = 'webgaze-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const heatCanvas = document.createElement('canvas');
  heatCanvas.id = 'webgaze-heatmap';

  const dot = document.createElement('div');
  dot.id = 'webgaze-dot';

  const calOverlay = document.createElement('div');
  calOverlay.id = 'webgaze-cal-overlay';

  overlay.appendChild(heatCanvas);
  overlay.appendChild(dot);

  function mountOverlay() {
    if (!document.body.contains(overlay)) {
      document.body.appendChild(overlay);
    }
  }

  function resizeCanvas() {
    heatCanvas.width = window.innerWidth;
    heatCanvas.height = window.innerHeight;
    heatBuffer = new Float32Array(window.innerWidth * window.innerHeight);
  }

  window.addEventListener('resize', () => {
    if (phase !== 'idle') resizeCanvas();
  });

  // ---------------------------------------------------------------------------
  // Heatmap rendering
  // ---------------------------------------------------------------------------

  function addHeatPoint(x, y) {
    const W = heatCanvas.width;
    const H = heatCanvas.height;
    const r = HEATMAP_RADIUS;

    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(W - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(H - 1, Math.ceil(y + r));

    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dist = Math.sqrt((px - x) ** 2 + (py - y) ** 2);
        if (dist <= r) {
          const strength = (1 - dist / r) ** 2;
          heatBuffer[py * W + px] += strength;
        }
      }
    }
  }

  function renderHeatmap() {
    const W = heatCanvas.width;
    const H = heatCanvas.height;
    if (!W || !H) return;

    const ctx = heatCanvas.getContext('2d');
    const imgData = ctx.createImageData(W, H);

    // Find max for normalization
    let max = 0;
    for (let i = 0; i < heatBuffer.length; i++) {
      if (heatBuffer[i] > max) max = heatBuffer[i];
    }

    if (max === 0) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    for (let i = 0; i < heatBuffer.length; i++) {
      const v = heatBuffer[i] / max; // 0..1
      if (v < 0.01) continue;

      const idx = i * 4;

      // Hot→cold colour ramp: red→yellow→green→blue
      let r, g, b;
      if (v > 0.75) {
        r = 255; g = Math.round((1 - v) * 4 * 255); b = 0;
      } else if (v > 0.5) {
        r = Math.round((v - 0.5) * 4 * 255); g = 255; b = 0;
      } else if (v > 0.25) {
        r = 0; g = 255; b = Math.round((0.5 - v) * 4 * 255);
      } else {
        r = 0; g = Math.round(v * 4 * 255); b = 255;
      }

      imgData.data[idx]     = r;
      imgData.data[idx + 1] = g;
      imgData.data[idx + 2] = b;
      imgData.data[idx + 3] = Math.round(v * 180); // semi-transparent
    }

    ctx.putImageData(imgData, 0, 0);
  }

  // Decay buffer each frame to create trailing effect
  function decayHeatmap() {
    for (let i = 0; i < heatBuffer.length; i++) {
      heatBuffer[i] *= HEATMAP_DECAY;
    }
  }

  // ---------------------------------------------------------------------------
  // Animation loop (only runs during tracking)
  // ---------------------------------------------------------------------------

  function animLoop() {
    if (phase !== 'tracking') return;
    decayHeatmap();
    renderHeatmap();
    animFrameId = requestAnimationFrame(animLoop);
  }

  // ---------------------------------------------------------------------------
  // Calibration UI
  // ---------------------------------------------------------------------------

  function runCalibration() {
    return new Promise((resolve) => {
      document.body.appendChild(calOverlay);
      calOverlay.innerHTML = '';
      calOverlay.classList.add('active');

      let pointIndex = 0;
      let clickCount = 0;

      const instructions = document.createElement('div');
      instructions.id = 'webgaze-cal-instructions';
      instructions.textContent = 'Calibration: look at each dot and click it ' + CAL_CLICKS_REQUIRED + ' times';
      calOverlay.appendChild(instructions);

      const progressEl = document.createElement('div');
      progressEl.id = 'webgaze-cal-progress';
      calOverlay.appendChild(progressEl);

      function showPoint(idx) {
        // Remove old dot
        const old = calOverlay.querySelector('.webgaze-cal-dot');
        if (old) old.remove();

        if (idx >= CAL_POINTS.length) {
          // All calibration points done
          calOverlay.classList.remove('active');
          calOverlay.remove();
          resolve();
          return;
        }

        const p = CAL_POINTS[idx];
        const calDot = document.createElement('div');
        calDot.className = 'webgaze-cal-dot';
        calDot.style.left = (p.x * 100) + '%';
        calDot.style.top  = (p.y * 100) + '%';

        const ring = document.createElement('div');
        ring.className = 'webgaze-cal-ring';
        calDot.appendChild(ring);

        const counter = document.createElement('span');
        counter.className = 'webgaze-cal-counter';
        counter.textContent = CAL_CLICKS_REQUIRED;
        calDot.appendChild(counter);

        clickCount = 0;

        calDot.addEventListener('click', () => {
          clickCount++;
          counter.textContent = CAL_CLICKS_REQUIRED - clickCount;
          calDot.classList.add('clicked');
          setTimeout(() => calDot.classList.remove('clicked'), 150);

          // Record calibration point directly in WebGazer
          const px = p.x * window.innerWidth;
          const py = p.y * window.innerHeight;
          if (window.webgazer) {
            window.webgazer.recordScreenPosition(px, py, 'click');
          }

          progressEl.textContent = `Point ${idx + 1}/${CAL_POINTS.length} — ${CAL_CLICKS_REQUIRED - clickCount} clicks remaining`;

          if (clickCount >= CAL_CLICKS_REQUIRED) {
            calDot.classList.add('done');
            setTimeout(() => showPoint(idx + 1), 400);
          }
        });

        calOverlay.appendChild(calDot);
        progressEl.textContent = `Point ${idx + 1}/${CAL_POINTS.length} — click ${CAL_CLICKS_REQUIRED} times`;
      }

      showPoint(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async function showCalibration() {
    if (phase !== 'idle') return;

    mountOverlay();
    resizeCanvas();
    phase = 'calibrating';

    try {
      await runCalibration();
      // Notify background that calibration sequence is complete
      await chrome.runtime.sendMessage({ type: 'CAL_DONE' });
    } catch (err) {
      console.error('[WebGaze] showCalibration error', err);
      stopSession();
    }
  }

  function startTracking() {
    phase = 'tracking';
    dot.style.display = 'block';
    animFrameId = requestAnimationFrame(animLoop);
  }

  function renderGaze(x, y) {
    if (phase !== 'tracking') return;

    // EMA smoothing
    if (smoothX === null) { smoothX = x; smoothY = y; }
    smoothX = EMA_ALPHA * x + (1 - EMA_ALPHA) * smoothX;
    smoothY = EMA_ALPHA * y + (1 - EMA_ALPHA) * smoothY;

    // Move gaze dot
    dot.style.transform = `translate(${smoothX - 8}px, ${smoothY - 8}px)`;
    dot.style.display = 'block';

    // Paint heatmap
    addHeatPoint(smoothX, smoothY);
  }

  function stopSession() {
    phase = 'idle';

    // Stop WebGazer camera/model
    if (webgazerRunning && window.webgazer) {
      try { window.webgazer.end(); } catch (e) {}
      webgazerRunning = false;
    }

    // Stop animation loop
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }

    // Remove DOM elements
    dot.style.display = 'none';
    if (overlay.parentNode) overlay.remove();
    if (calOverlay.parentNode) calOverlay.remove();

    // Clear heatmap
    if (heatCanvas.getContext) {
      heatCanvas.getContext('2d').clearRect(0, 0, heatCanvas.width, heatCanvas.height);
    }

    smoothX = null;
    smoothY = null;
  }

  // ---------------------------------------------------------------------------
  // WebGazer initialization (called after webgazer.js is injected by background)
  // ---------------------------------------------------------------------------

  async function startWebGazer() {
    if (webgazerRunning) return;
    if (!window.webgazer) {
      console.error('[WebGaze] window.webgazer not found — was webgazer.js injected?');
      return;
    }

    mountOverlay();
    resizeCanvas();
    phase = 'calibrating';

    try {
      window.webgazer
        .setRegression('ridge')
        .setTracker('TFFacemesh')
        .showPredictionPoints(false)
        .showVideoPreview(true)
        .setGazeListener((data, ts) => {
          if (!data) return;
          const { x, y } = data;
          // Render locally
          renderGaze(x, y);
          // Send to background for storage
          if (phase === 'tracking') {
            chrome.runtime.sendMessage({
              type: 'GAZE_POINT',
              payload: { x, y, ts: ts || Date.now(), url: location.href },
            }).catch(() => {});
          }
        });

      await window.webgazer.begin();
      webgazerRunning = true;
      console.log('[WebGaze] webgazer.begin() resolved — showing calibration');

      await runCalibration();
      chrome.runtime.sendMessage({ type: 'CAL_DONE' }).catch(() => {});
    } catch (err) {
      console.error('[WebGaze] startWebGazer error', err);
      stopSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { type, payload } = message;

    switch (type) {
      case 'START_WEBGAZER':
        startWebGazer()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case 'SHOW_CALIBRATION':
        showCalibration()
          .then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e) }));
        return true;

      case 'RECALIBRATE_WEBGAZER':
        // Clear WebGazer training data and re-run calibration
        if (window.webgazer) {
          try { window.webgazer.clearData(); } catch (e) {}
        }
        phase = 'calibrating';
        runCalibration().then(() => {
          chrome.runtime.sendMessage({ type: 'CAL_DONE' }).catch(() => {});
        }).catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'CALIBRATION_COMPLETE':
        startTracking();
        sendResponse({ ok: true });
        break;

      case 'RENDER_GAZE':
        if (payload && typeof payload.x === 'number' && typeof payload.y === 'number') {
          renderGaze(payload.x, payload.y);
        }
        sendResponse({ ok: true });
        break;

      case 'STOP_SESSION':
        stopSession();
        sendResponse({ ok: true });
        break;

      case 'TAB_NAVIGATED':
        currentUrl = (payload && payload.url) || location.href;
        sendResponse({ ok: true });
        break;

      case 'GET_STATE':
        sendResponse({ ok: true, phase, url: currentUrl });
        break;

      default:
        // Ignore unknown messages silently
        break;
    }
  });

  // ---------------------------------------------------------------------------
  // Sync with background state on load
  // (e.g. if the user navigates to a new page mid-session)
  // ---------------------------------------------------------------------------

  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.ok && response.state) {
      const bgPhase = response.state.phase;
      if (bgPhase === 'tracking') {
        // Re-mount overlay and resume heatmap rendering on page navigation
        mountOverlay();
        resizeCanvas();
        phase = 'tracking';
        dot.style.display = 'none'; // will show once first RENDER_GAZE arrives
        animFrameId = requestAnimationFrame(animLoop);
      }
    }
  });

})();
