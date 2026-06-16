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
  let gazeFrameCount = 0;      // for 10fps downsampling
  let accuracyCollector = null; // when non-null, gaze listener fills this array

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

  const pageBlank = document.createElement('div');
  pageBlank.id = 'webgaze-page-blank';

  const overlay = document.createElement('div');
  overlay.id = 'webgaze-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const heatCanvas = document.createElement('canvas');
  heatCanvas.id = 'webgaze-heatmap';

  const dot = document.createElement('div');
  dot.id = 'webgaze-dot';

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
  // Accuracy check — mirrors the official WebGazer calibration.html flow
  //
  // Algorithm (from precision_calculation.js):
  //   1. Tell user to stare at CENTER dot for 5 s (no clicking)
  //   2. webgazer.params.storingPoints = true  → WebGazer fills its 50-point ring buffer
  //   3. After 5 s: webgazer.getStoredPoints() → [x50, y50]
  //   4. For each of 50 points: precision = 100 - (distance_from_center / halfWindowHeight * 100)
  //   5. Average of 50 values = final accuracy %
  // ---------------------------------------------------------------------------

  const ACCURACY_SAMPLE_MS = 5000; // 5 s — matches official demo

  /** Calculates precision % using the official WebGazer formula. */
  function calculatePrecision(past50) {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = W / 2;
    const cy = H / 2;
    const halfH = H / 2;

    const x50 = past50[0];
    const y50 = past50[1];
    const n = Math.min(x50.length, y50.length);
    if (n === 0) return 0;

    let total = 0;
    for (let i = 0; i < n; i++) {
      const dx = cx - x50[i];
      const dy = cy - y50[i];
      const dist = Math.sqrt(dx * dx + dy * dy);
      const p = dist <= halfH ? Math.max(0, 100 - (dist / halfH * 100)) : 0;
      total += p;
    }
    return Math.round(total / n);
  }

  /**
   * Phase 1: show center dot + instruction modal, collect 5 s of gaze.
   * Resolves with { accuracy (0-100) }.
   */
  function runAccuracyCheck() {
    return new Promise((resolve) => {
      // pageBlank stays in DOM — just update content in-place.
      pageBlank.innerHTML = `
        <div id="webgaze-acc-modal">
          <div class="acc-modal-title">Accuracy Check</div>
          <div class="acc-modal-body">
            Please stare at the <strong>dot in the center</strong> of the screen
            for <strong>5 seconds</strong> without moving your mouse.<br><br>
            This measures how accurate your eye tracking is.
          </div>
          <button id="webgaze-acc-start">OK — Start</button>
        </div>
      `;

      pageBlank.querySelector('#webgaze-acc-start').addEventListener('click', () => {
        // Step 2 — show center dot, collect gaze for 5 s via our own listener
        pageBlank.innerHTML = '';

        const centerDot = document.createElement('div');
        centerDot.className = 'webgaze-acc-center-dot';
        pageBlank.appendChild(centerDot);

        // Start manual collection (gaze listener feeds accuracyCollector)
        accuracyCollector = [];

        const startTime = Date.now();
        const tick = setInterval(() => {
          if (Date.now() - startTime >= ACCURACY_SAMPLE_MS) {
            clearInterval(tick);

            const collected = accuracyCollector || [];
            accuracyCollector = null;

            const xs = collected.map(p => p.x);
            const ys = collected.map(p => p.y);
            const accuracy = calculatePrecision([xs, ys]);

            pageBlank.innerHTML = '';
            resolve({ accuracy });
          }
        }, 200);
      });
    });
  }

  /**
   * Phase 2: display result + Recalibrate / Continue buttons.
   * Resolves true = continue, false = recalibrate.
   */
  function showAccuracyResult(accuracy) {
    return new Promise((resolve) => {
      // pageBlank stays in DOM — just update content in-place.
      const isGood  = accuracy >= 60;
      const color   = accuracy >= 80 ? '#4ade80' : accuracy >= 60 ? '#facc15' : '#f87171';

      pageBlank.innerHTML = `
        <div id="webgaze-acc-result">
          <div class="acc-score" style="color:${color}">${accuracy}%</div>
          <div class="acc-label">Your accuracy measure is ${accuracy}%</div>
          <div class="acc-hint">${
            accuracy >= 80 ? 'Excellent — tracking will be very accurate.' :
            accuracy >= 60 ? 'Good — tracking is usable.' :
            'Low accuracy. Better lighting and head position may help.'
          }</div>
          <div class="acc-buttons">
            <button id="webgaze-acc-recal">Recalibrate</button>
            <button id="webgaze-acc-continue" ${isGood ? '' : 'class="warn"'}>
              ${isGood ? 'Confirm' : 'Continue Anyway'}
            </button>
          </div>
        </div>
      `;

      pageBlank.querySelector('#webgaze-acc-continue').addEventListener('click', () => {
        pageBlank.innerHTML = '';
        resolve(true);
      });

      pageBlank.querySelector('#webgaze-acc-recal').addEventListener('click', () => {
        pageBlank.innerHTML = '';
        resolve(false);
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Calibration UI
  // ---------------------------------------------------------------------------

  function runCalibration() {
    return new Promise((resolve) => {
      // pageBlank stays in DOM — just update content in-place.
      pageBlank.innerHTML = '';

      let pointIndex = 0;
      let clickCount = 0;

      const instructions = document.createElement('div');
      instructions.id = 'webgaze-cal-instructions';
      instructions.textContent = 'Click each dot ' + CAL_CLICKS_REQUIRED + ' times while looking at it';
      pageBlank.appendChild(instructions);

      function showPoint(idx) {
        // Remove old dot
        const old = pageBlank.querySelector('.webgaze-cal-dot');
        if (old) old.remove();

        if (idx >= CAL_POINTS.length) {
          // All calibration points done — clear content, keep pageBlank in DOM.
          pageBlank.innerHTML = '';
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
          if (clickCount >= CAL_CLICKS_REQUIRED) return;
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

          if (clickCount >= CAL_CLICKS_REQUIRED) {
            calDot.classList.add('done');
            setTimeout(() => showPoint(idx + 1), 400);
          }
        });

        pageBlank.appendChild(calDot);
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

  // ---------------------------------------------------------------------------
  // Screenshot triggers — scroll stop + DOM mutation
  // ---------------------------------------------------------------------------

  let scrollDebounceId = null;
  function onScrollSettle() {
    if (phase !== 'tracking') return;
    clearTimeout(scrollDebounceId);
    scrollDebounceId = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'TRIGGER_SCREENSHOT', payload: { reason: 'scroll' } }).catch(() => {});
    }, 300);
  }

  let mutationDebounceId = null;
  const mutationObserver = new MutationObserver((mutations) => {
    if (phase !== 'tracking') return;
    const vpArea = window.innerWidth * window.innerHeight;
    let significant = false;
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width * rect.height > vpArea * 0.1) { significant = true; break; }
      }
      if (significant) break;
    }
    if (!significant) return;
    clearTimeout(mutationDebounceId);
    mutationDebounceId = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'TRIGGER_SCREENSHOT', payload: { reason: 'dom_mutation' } }).catch(() => {});
    }, 300);
  });

  function startScreenshotTriggers() {
    window.addEventListener('scroll', onScrollSettle, { passive: true });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopScreenshotTriggers() {
    window.removeEventListener('scroll', onScrollSettle);
    mutationObserver.disconnect();
    clearTimeout(scrollDebounceId);
    clearTimeout(mutationDebounceId);
  }

  function startTracking() {
    phase = 'tracking';
    gazeFrameCount = 0;
    if (pageBlank.parentNode) pageBlank.remove();
    dot.style.display = 'block';
    animFrameId = requestAnimationFrame(animLoop);
    startScreenshotTriggers();
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

    stopScreenshotTriggers();

    // Remove DOM elements
    dot.style.display = 'none';
    if (pageBlank.parentNode) pageBlank.remove();
    if (overlay.parentNode) overlay.remove();
    if (pageBlank.parentNode) pageBlank.remove();

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
          // Feed accuracy collector if an accuracy check is running
          if (accuracyCollector !== null) accuracyCollector.push({ x, y });
          renderGaze(x, y);
          if (phase === 'tracking') {
            // Downsample to ~10fps (WebGazer runs at ~30fps, keep every 3rd frame)
            gazeFrameCount++;
            if (gazeFrameCount % 3 !== 0) return;
            chrome.runtime.sendMessage({
              type: 'GAZE_POINT',
              payload: { x, y, ts: ts || Date.now(), url: location.href },
            }).catch(() => {});
          }
        });

      await window.webgazer.begin();
      webgazerRunning = true;

      // Full calibration flow
      await showCameraCheck();
      await showInstruction('calibration');
      await runCalibration();
      await showInstruction('boundary');
      await runBoundaryStep();

      // Accuracy check loop
      let accepted = false;
      while (!accepted) {
        const { accuracy } = await runAccuracyCheck();
        accepted = await showAccuracyResult(accuracy);
        if (!accepted) {
          try { window.webgazer.clearData(); } catch (e) {}
          await runCalibration();
          await runBoundaryStep();
        }
      }

      // Tear down calibration UI immediately — reveal page before tracking starts
      pageBlank.innerHTML = '';
      if (pageBlank.parentNode) pageBlank.remove();

      chrome.runtime.sendMessage({ type: 'CAL_DONE' }).catch(() => {});
    } catch (err) {
      console.error('[WebGaze] startWebGazer error', err);
      stopSession();
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1 — Camera check
  // ---------------------------------------------------------------------------

  function showCameraCheck() {
    return new Promise((resolve) => {
      if (!document.body.contains(pageBlank)) document.body.appendChild(pageBlank);
      pageBlank.innerHTML = `
        <div id="webgaze-camera-check">
          <div id="webgaze-face-status" class="no-face">Position your face in front of the camera</div>
          <button id="webgaze-camera-continue" disabled>Continue →</button>
        </div>
      `;

      // Don't move the WebGazer video container — moving it breaks the face mesh
      // canvas coordinate mapping. Instead, float it above our overlay via z-index
      // and reposition it to screen center while the check is active.
      const wgVideo = document.getElementById('webgazerVideoContainer');
      const savedStyles = {};
      if (wgVideo) {
        savedStyles.position  = wgVideo.style.position;
        savedStyles.top       = wgVideo.style.top;
        savedStyles.left      = wgVideo.style.left;
        savedStyles.zIndex    = wgVideo.style.zIndex;
        savedStyles.transform = wgVideo.style.transform;

        // Float above our overlay, centered horizontally, slightly above screen center
        wgVideo.style.position  = 'fixed';
        wgVideo.style.top       = 'calc(50% - 180px)';
        wgVideo.style.left      = '50%';
        wgVideo.style.transform = 'translateX(-50%)';
        wgVideo.style.zIndex    = '2147483648'; // above pageBlank
      }

      const statusEl   = pageBlank.querySelector('#webgaze-face-status');
      const continueBtn = pageBlank.querySelector('#webgaze-camera-continue');

      const pollId = setInterval(async () => {
        try {
          const pred = await window.webgazer.getCurrentPrediction();
          if (pred !== null && pred !== undefined) {
            statusEl.textContent = '✓ Face detected — you\'re ready';
            statusEl.className = 'face-detected';
            continueBtn.disabled = false;
          } else {
            statusEl.textContent = 'No face detected — check lighting and camera angle';
            statusEl.className = 'no-face';
            continueBtn.disabled = true;
          }
        } catch (_) {}
      }, 400);

      continueBtn.addEventListener('click', () => {
        clearInterval(pollId);
        // Restore WebGazer video to its original position
        if (wgVideo) {
          wgVideo.style.position  = savedStyles.position  || 'fixed';
          wgVideo.style.top       = savedStyles.top       || '0px';
          wgVideo.style.left      = savedStyles.left      || '0px';
          wgVideo.style.transform = savedStyles.transform || '';
          wgVideo.style.zIndex    = savedStyles.zIndex    || '';
        }
        pageBlank.innerHTML = '';
        resolve();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Step 2 / 4 — Instruction screens
  // ---------------------------------------------------------------------------

  function showInstruction(type) {
    return new Promise((resolve) => {
      // pageBlank stays in DOM throughout the flow — just update content.
      const isCalibration = type === 'calibration';
      pageBlank.innerHTML = `
        <div id="webgaze-instruction">
          <div class="inst-svg">${isCalibration ? _calSVG() : _boundarySVG()}</div>
          <h2>${isCalibration ? '9-Point Calibration' : 'Boundary Calibration'}</h2>
          <p>${isCalibration
            ? 'Click each dot <strong>5 times</strong> while looking directly at it.<br>Always keep your eyes on the dot, not the cursor.'
            : 'Click each corner <strong>3 times</strong> while looking at it.<br>Then follow the edge with your cursor — keep your eyes on the cursor as it moves.'
          }</p>
          <button id="webgaze-inst-btn">Start</button>
        </div>
      `;

      pageBlank.querySelector('#webgaze-inst-btn').addEventListener('click', () => {
        pageBlank.innerHTML = '';
        resolve();
      });
    });
  }

  function _calSVG() {
    const pts = [
      [20,20],[50,20],[80,20],
      [20,50],[50,50],[80,50],
      [20,80],[50,80],[80,80],
    ];
    const dots = pts.map(([x, y]) => `
      <circle cx="${x}" cy="${y}" r="7" fill="#4af" opacity="0.9"/>
      <circle cx="${x}" cy="${y}" r="12" fill="none" stroke="#4af" stroke-width="1.5" opacity="0.35"/>
    `).join('');
    return `<svg viewBox="0 0 100 100" width="160" height="160" xmlns="http://www.w3.org/2000/svg">${dots}</svg>`;
  }

  function _boundarySVG() {
    return `<svg viewBox="0 0 200 140" width="260" height="182" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <marker id="wg-arr" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
          <path d="M0,0 L0,6 L7,3 z" fill="rgba(68,170,255,0.8)"/>
        </marker>
      </defs>
      <!-- Dashed perimeter -->
      <rect x="20" y="16" width="160" height="108" fill="none"
            stroke="rgba(68,170,255,0.25)" stroke-width="1.5" stroke-dasharray="5,4" rx="2"/>
      <!-- Direction arrows along edges -->
      <line x1="36" y1="12" x2="164" y2="12"
            stroke="rgba(68,170,255,0.7)" stroke-width="1.5" marker-end="url(#wg-arr)"/>
      <line x1="188" y1="32" x2="188" y2="108"
            stroke="rgba(68,170,255,0.7)" stroke-width="1.5" marker-end="url(#wg-arr)"/>
      <line x1="164" y1="128" x2="36" y2="128"
            stroke="rgba(68,170,255,0.7)" stroke-width="1.5" marker-end="url(#wg-arr)"/>
      <line x1="12" y1="108" x2="12" y2="32"
            stroke="rgba(68,170,255,0.7)" stroke-width="1.5" marker-end="url(#wg-arr)"/>
      <!-- Corner dots -->
      <circle cx="20" cy="16"  r="9" fill="#f59e0b" opacity="0.95"/>
      <circle cx="180" cy="16" r="9" fill="#f59e0b" opacity="0.95"/>
      <circle cx="180" cy="124" r="9" fill="#f59e0b" opacity="0.95"/>
      <circle cx="20" cy="124" r="9" fill="#f59e0b" opacity="0.95"/>
    </svg>`;
  }

  // ---------------------------------------------------------------------------
  // Step 5 — Boundary step
  // TL(3×) → top edge hover → TR(3×) → right edge hover →
  // BR(3×) → bottom edge hover → BL(3×) → left edge hover → TL(1× close)
  // ---------------------------------------------------------------------------

  function runBoundaryStep() {
    return new Promise((resolve) => {
      // pageBlank stays in DOM — just update content in-place.
      pageBlank.innerHTML = '';

      const instructions = document.createElement('div');
      instructions.id = 'webgaze-cal-instructions';
      instructions.textContent = 'Click each corner 3× while looking at it, then follow the edge with your cursor';
      pageBlank.appendChild(instructions);

      // Canvas for edge lines (pointer-events:none so clicks reach corner dots)
      const edgeCv = document.createElement('canvas');
      edgeCv.width  = window.innerWidth;
      edgeCv.height = window.innerHeight;
      edgeCv.style.cssText = 'position:fixed;top:0;left:0;pointer-events:none;';
      pageBlank.appendChild(edgeCv);
      const ctx = edgeCv.getContext('2d');

      const PAD = 28;
      const C = {
        TL: { x: PAD,                      y: PAD },
        TR: { x: window.innerWidth  - PAD, y: PAD },
        BR: { x: window.innerWidth  - PAD, y: window.innerHeight - PAD },
        BL: { x: PAD,                      y: window.innerHeight - PAD },
      };

      // Sequence: [cornerId, clicksRequired]
      const SEQ = [
        ['TL', 3], ['TR', 3], ['BR', 3], ['BL', 3], ['TL', 1],
      ];
      // Edges between consecutive steps (index i → i+1)
      const EDGE_PAIRS = [['TL','TR'],['TR','BR'],['BR','BL'],['BL','TL']];

      let seqIdx    = 0;
      let clickCount = 0;
      let activeEdge = -1;          // index into EDGE_PAIRS (-1 = none)
      const doneEdges = new Set();  // fully completed edges
      let curX = -9999, curY = -9999;
      let cornerEl = null;          // current active corner HTML element

      // ── Canvas drawing ──────────────────────────────────────────────────────

      function drawEdges() {
        ctx.clearRect(0, 0, edgeCv.width, edgeCv.height);

        // Completed edges — solid
        ctx.setLineDash([]);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(68,170,255,0.85)';
        for (const ei of doneEdges) {
          const [a, b] = EDGE_PAIRS[ei];
          ctx.beginPath();
          ctx.moveTo(C[a].x, C[a].y);
          ctx.lineTo(C[b].x, C[b].y);
          ctx.stroke();
        }

        // Active edge — dashed with solid progress
        if (activeEdge >= 0) {
          const [a, b] = EDGE_PAIRS[activeEdge];
          const ax = C[a].x, ay = C[a].y, bx = C[b].x, by = C[b].y;
          const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
          const t = len2 > 0
            ? Math.max(0, Math.min(1, ((curX - ax) * (bx - ax) + (curY - ay) * (by - ay)) / len2))
            : 0;

          if (t > 0) {
            ctx.setLineDash([]);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(68,170,255,0.9)';
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax + t * (bx - ax), ay + t * (by - ay));
            ctx.stroke();
          }
          if (t < 1) {
            ctx.setLineDash([8, 6]);
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(68,170,255,0.3)';
            ctx.beginPath();
            ctx.moveTo(ax + t * (bx - ax), ay + t * (by - ay));
            ctx.lineTo(bx, by);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        }
      }

      // ── Cursor tracking ──────────────────────────────────────────────────────

      function onMouseMove(e) {
        curX = e.clientX; curY = e.clientY;
        if (activeEdge >= 0) drawEdges();
      }
      document.addEventListener('mousemove', onMouseMove);

      // ── Corner element ───────────────────────────────────────────────────────

      function showCorner(idx) {
        if (cornerEl) cornerEl.remove();

        if (idx >= SEQ.length) {
          document.removeEventListener('mousemove', onMouseMove);
          pageBlank.innerHTML = '';
          resolve();
          return;
        }

        const [id, required] = SEQ[idx];
        const pos = C[id];
        const isClose = idx === SEQ.length - 1;

        cornerEl = document.createElement('div');
        cornerEl.className = 'webgaze-boundary-corner' + (isClose ? ' close' : '');
        cornerEl.style.left = pos.x + 'px';
        cornerEl.style.top  = pos.y + 'px';

        const counter = document.createElement('span');
        counter.className = 'webgaze-cal-counter';
        counter.textContent = required;
        cornerEl.appendChild(counter);
        pageBlank.appendChild(cornerEl);

        clickCount = 0;
        drawEdges();

        cornerEl.addEventListener('click', () => {
          if (clickCount >= required) return;
          clickCount++;
          if (window.webgazer) window.webgazer.recordScreenPosition(pos.x, pos.y, 'click');
          counter.textContent = required - clickCount;
          cornerEl.classList.add('clicked');
          setTimeout(() => cornerEl && cornerEl.classList.remove('clicked'), 150);

          if (clickCount >= required) {
            cornerEl.classList.add('done');

            // Seal active edge as completed
            if (activeEdge >= 0) {
              doneEdges.add(activeEdge);
              activeEdge = -1;
            }

            seqIdx++;

            // If there's an edge after this corner, activate it
            if (seqIdx < SEQ.length) {
              activeEdge = Math.min(seqIdx - 1, EDGE_PAIRS.length - 1);
            }

            setTimeout(() => showCorner(seqIdx), 350);
          }
        });
      }

      showCorner(0);
    });
  }

  // ---------------------------------------------------------------------------
  // Message listener
  // ---------------------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const { type, payload } = message;

    switch (type) {
      case 'START_WEBGAZER':
        // Respond immediately — startWebGazer() takes minutes (calibration flow)
        // and Chrome closes the message channel long before it finishes.
        sendResponse({ ok: true });
        startWebGazer().catch(err => console.error('[WebGaze] startWebGazer error', err));
        break;

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
        if (!document.body.contains(pageBlank)) document.body.appendChild(pageBlank);
        (async () => {
          await runCalibration();
          await runBoundaryStep();
          let accepted = false;
          while (!accepted) {
            const { accuracy } = await runAccuracyCheck();
            accepted = await showAccuracyResult(accuracy);
            if (!accepted) {
              try { window.webgazer.clearData(); } catch (e) {}
              await runCalibration();
              await runBoundaryStep();
            }
          }
          chrome.runtime.sendMessage({ type: 'CAL_DONE' }).catch(() => {});
        })().catch(() => {});
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
