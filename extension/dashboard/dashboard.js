'use strict';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const emptyState    = document.getElementById('empty-state');
const mainContent   = document.getElementById('main-content');
const sessionLabel  = document.getElementById('session-label');
const gallery       = document.getElementById('gallery');
const viewerArea    = document.getElementById('viewer-area');
const viewerTitle   = document.getElementById('viewer-title');
const viewerFooter  = document.getElementById('viewer-footer');
const toggleHeatmap = document.getElementById('toggle-heatmap');
const toggleDots    = document.getElementById('toggle-dots');
const fileInput     = document.getElementById('file-input');
const btnLoadCurrent = document.getElementById('btn-load-current');

const infoParticipant = document.getElementById('info-participant');
const infoSession     = document.getElementById('info-session');
const infoDuration    = document.getElementById('info-duration');
const infoPoints      = document.getElementById('info-points');
const infoShots       = document.getElementById('info-shots');

// ---------------------------------------------------------------------------
// Session data
// ---------------------------------------------------------------------------

let sessionData = null;      // full export JSON
let selectedIdx = -1;        // currently selected screenshot index

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString();
}

/** Returns gaze points that belong to screenshot at index i (by timestamp window). */
function getGazePointsForShot(i) {
  if (!sessionData) return [];
  const shots = sessionData.screenshots;
  const start = shots[i].capturedAt;
  const end   = i + 1 < shots.length ? shots[i + 1].capturedAt : Infinity;
  return sessionData.gazePoints.filter(p => p.ts >= start && p.ts < end);
}

// ---------------------------------------------------------------------------
// Heatmap renderer
// ---------------------------------------------------------------------------

const HEATMAP_RADIUS = 30; // px (in original screenshot coordinates)

function drawHeatmap(canvas, gazePoints, scaleX, scaleY) {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  if (!gazePoints.length) return;

  // Accumulate into a Float32 buffer
  const buf = new Float32Array(W * H);
  const r = Math.round(HEATMAP_RADIUS * scaleX);

  for (const p of gazePoints) {
    const cx = Math.round(p.x * scaleX);
    const cy = Math.round(p.y * scaleY);
    const x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r);
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const d = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
        if (d <= r) buf[py * W + px] += (1 - d / r) ** 2;
      }
    }
  }

  let max = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > max) max = buf[i];
  if (max === 0) return;

  const imgData = ctx.createImageData(W, H);
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i] / max;
    if (v < 0.01) continue;
    const idx = i * 4;
    let r2, g, b;
    if (v > 0.75)      { r2 = 255; g = Math.round((1 - v) * 4 * 255); b = 0; }
    else if (v > 0.5)  { r2 = Math.round((v - 0.5) * 4 * 255); g = 255; b = 0; }
    else if (v > 0.25) { r2 = 0; g = 255; b = Math.round((0.5 - v) * 4 * 255); }
    else               { r2 = 0; g = Math.round(v * 4 * 255); b = 255; }
    imgData.data[idx]     = r2;
    imgData.data[idx + 1] = g;
    imgData.data[idx + 2] = b;
    imgData.data[idx + 3] = Math.round(v * 180);
  }
  ctx.putImageData(imgData, 0, 0);
}

function drawDots(canvas, gazePoints, scaleX, scaleY) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255, 80, 80, 0.5)';
  for (const p of gazePoints) {
    ctx.beginPath();
    ctx.arc(p.x * scaleX, p.y * scaleY, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Viewer — renders a screenshot with heatmap/dots overlay
// ---------------------------------------------------------------------------

function renderViewer(idx) {
  selectedIdx = idx;
  const shot = sessionData.screenshots[idx];
  const gazePoints = getGazePointsForShot(idx);

  // Update gallery selection
  document.querySelectorAll('.gallery-thumb').forEach((el, i) => {
    el.classList.toggle('active', i === idx);
  });

  viewerTitle.textContent = `Screenshot ${idx + 1} — ${formatTime(shot.capturedAt)}`;
  viewerFooter.textContent =
    `${gazePoints.length} gaze points · reason: ${shot.reason || '—'} · ${shot.url || ''}`;

  // Build viewer frame
  viewerArea.innerHTML = '';
  const frame = document.createElement('div');
  frame.className = 'viewer-frame';

  const img = document.createElement('img');
  img.src = shot.dataUrl;
  img.alt = `Screenshot ${idx + 1}`;
  frame.appendChild(img);

  // Two canvas layers: heatmap + dots
  const heatCanvas = document.createElement('canvas');
  const dotCanvas  = document.createElement('canvas');
  frame.appendChild(heatCanvas);
  frame.appendChild(dotCanvas);

  viewerArea.appendChild(frame);

  img.onload = () => {
    const dispW = img.offsetWidth  || img.naturalWidth;
    const dispH = img.offsetHeight || img.naturalHeight;
    heatCanvas.width  = dispW;
    heatCanvas.height = dispH;
    dotCanvas.width   = dispW;
    dotCanvas.height  = dispH;

    // Gaze points are in viewport coordinates; scale to displayed image size
    const scaleX = dispW / (shot.viewportW || img.naturalWidth);
    const scaleY = dispH / (shot.viewportH || img.naturalHeight);

    redrawOverlays(heatCanvas, dotCanvas, gazePoints, scaleX, scaleY);
  };

  // Store refs for toggle controls
  frame._heatCanvas  = heatCanvas;
  frame._dotCanvas   = dotCanvas;
  frame._gazePoints  = gazePoints;
  frame._img         = img;
  viewerArea._frame  = frame;
}

function redrawOverlays(heatCanvas, dotCanvas, gazePoints, scaleX, scaleY) {
  if (toggleHeatmap.checked) {
    drawHeatmap(heatCanvas, gazePoints, scaleX, scaleY);
  } else {
    heatCanvas.getContext('2d').clearRect(0, 0, heatCanvas.width, heatCanvas.height);
  }
  if (toggleDots.checked) {
    drawDots(dotCanvas, gazePoints, scaleX, scaleY);
  } else {
    dotCanvas.getContext('2d').clearRect(0, 0, dotCanvas.width, dotCanvas.height);
  }
}

toggleHeatmap.addEventListener('change', () => {
  const f = viewerArea._frame;
  if (!f) return;
  const img = f._img;
  const scaleX = f._heatCanvas.width  / (sessionData.screenshots[selectedIdx].viewportW || img.naturalWidth);
  const scaleY = f._heatCanvas.height / (sessionData.screenshots[selectedIdx].viewportH || img.naturalHeight);
  redrawOverlays(f._heatCanvas, f._dotCanvas, f._gazePoints, scaleX, scaleY);
});

toggleDots.addEventListener('change', () => {
  const f = viewerArea._frame;
  if (!f) return;
  const img = f._img;
  const scaleX = f._dotCanvas.width  / (sessionData.screenshots[selectedIdx].viewportW || img.naturalWidth);
  const scaleY = f._dotCanvas.height / (sessionData.screenshots[selectedIdx].viewportH || img.naturalHeight);
  redrawOverlays(f._heatCanvas, f._dotCanvas, f._gazePoints, scaleX, scaleY);
});

// ---------------------------------------------------------------------------
// Gallery builder
// ---------------------------------------------------------------------------

function buildGallery() {
  gallery.innerHTML = '';
  if (!sessionData.screenshots || sessionData.screenshots.length === 0) {
    gallery.innerHTML = '<p style="color:var(--dim);font-size:12px;padding:8px">No screenshots in this session.</p>';
    return;
  }

  sessionData.screenshots.forEach((shot, i) => {
    const thumb = document.createElement('div');
    thumb.className = 'gallery-thumb';

    const img = document.createElement('img');
    img.src = shot.dataUrl;
    img.alt = `Screenshot ${i + 1}`;
    thumb.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'thumb-meta';
    meta.innerHTML = `
      <span>${formatTime(shot.capturedAt)}</span>
      <span class="thumb-reason">${shot.reason || ''}</span>
    `;
    thumb.appendChild(meta);

    thumb.addEventListener('click', () => renderViewer(i));
    gallery.appendChild(thumb);
  });

  // Auto-select first screenshot
  renderViewer(0);
}

// ---------------------------------------------------------------------------
// Load session data
// ---------------------------------------------------------------------------

function loadSession(data) {
  if (!data || !data.sessionId) {
    alert('Invalid session file.');
    return;
  }
  sessionData = data;

  // Fill info bar
  infoParticipant.textContent = data.participantId || 'anonymous';
  infoSession.textContent     = data.sessionId;
  infoDuration.textContent    = formatDuration(data.durationMs);
  infoPoints.textContent      = (data.totalGazePoints || 0).toLocaleString();
  infoShots.textContent       = (data.screenshotCount || (data.screenshots || []).length);

  sessionLabel.textContent = `${data.participantId || 'anonymous'} · ${data.sessionId}`;

  emptyState.style.display   = 'none';
  mainContent.style.display  = 'flex';

  buildGallery();
}

// ---------------------------------------------------------------------------
// Load from extension storage (current session)
// ---------------------------------------------------------------------------

btnLoadCurrent.addEventListener('click', () => {
  chrome.storage.local.get('webgazeState', (result) => {
    if (chrome.runtime.lastError || !result.webgazeState) {
      alert('No active session found in storage.');
      return;
    }
    const s = result.webgazeState;
    // Build an export-compatible object from raw state
    const duration = s.startedAt ? Date.now() - s.startedAt : 0;
    loadSession({
      schemaVersion: '1.0',
      sessionId:     s.sessionId  || 'unknown',
      participantId: s.participantId || 'anonymous',
      startedAt:     s.startedAt,
      exportedAt:    Date.now(),
      durationMs:    duration,
      totalGazePoints: (s.gazePoints || []).length,
      screenshotCount: (s.screenshots || []).length,
      aois:          s.aois        || [],
      pageSummaries: {},
      gazePoints:    s.gazePoints  || [],
      screenshots:   s.screenshots || [],
    });
  });
});

// ---------------------------------------------------------------------------
// Import JSON file
// ---------------------------------------------------------------------------

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      loadSession(data);
    } catch {
      alert('Could not parse JSON file.');
    }
  };
  reader.readAsText(file);
  fileInput.value = '';
});
