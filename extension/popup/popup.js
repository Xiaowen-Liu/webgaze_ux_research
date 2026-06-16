/**
 * popup.js — WebGaze popup controller
 *
 * Communicates with background.js via chrome.runtime.sendMessage.
 * Sends START_SESSION / STOP_SESSION / EXPORT messages.
 * Polls GET_STATE every second to keep the UI in sync.
 */

'use strict';

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const statusPill   = document.getElementById('status-pill');
const statusText   = document.getElementById('status-text');
const sessionTime  = document.getElementById('session-time');
const stats        = document.getElementById('stats');
const statPoints   = document.getElementById('stat-points');
const statPages    = document.getElementById('stat-pages');

const btnStart     = document.getElementById('btn-start');
const btnRecal     = document.getElementById('btn-recal');
const btnStop      = document.getElementById('btn-stop');

const aoiList      = document.getElementById('aoi-list');
const btnAddAoi    = document.getElementById('btn-add-aoi');

const exportSection  = document.getElementById('export-section');
const exportSummary  = document.getElementById('export-summary');
const btnDownload    = document.getElementById('btn-download');
const footerSession  = document.getElementById('footer-session-id');

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

let aois = [];         // user-defined AOIs
let lastExport = null; // last exported JSON object
let pollTimer  = null;
let startedAt  = null;
let clockTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[popup] sendMessage error:', chrome.runtime.lastError.message);
        resolve(null);
      } else {
        resolve(response);
      }
    });
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// UI rendering
// ---------------------------------------------------------------------------

function setPhaseUI(phase, state) {
  // Reset pill classes
  statusPill.className = `pill ${phase}`;

  switch (phase) {
    case 'idle':
      statusText.textContent = 'Idle';
      btnStart.style.display = '';
      btnRecal.style.display = 'none';
      btnStop.style.display  = 'none';
      stats.style.display    = 'none';
      sessionTime.style.display = 'none';
      stopClock();
      break;

    case 'calibrating':
      statusText.textContent = 'Calibrating…';
      btnStart.style.display = 'none';
      btnRecal.style.display = 'none';
      btnStop.style.display  = '';
      stats.style.display    = 'none';
      sessionTime.style.display = 'none';
      break;

    case 'tracking':
      statusText.textContent = 'Tracking';
      btnStart.style.display = 'none';
      btnRecal.style.display = '';
      btnStop.style.display  = '';
      stats.style.display    = '';
      sessionTime.style.display = '';
      if (state && state.startedAt && !clockTimer) {
        startedAt = state.startedAt;
        startClock();
      }
      if (state) {
        statPoints.textContent = state.gazePoints ? state.gazePoints.length : 0;
        statPages.textContent  = state.dwellTimes ? Object.keys(state.dwellTimes).length : 0;
      }
      break;
  }

  if (state && state.sessionId) {
    footerSession.textContent = state.sessionId;
  }
}

function startClock() {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    if (startedAt) {
      sessionTime.textContent = formatDuration(Date.now() - startedAt);
    }
  }, 1000);
}

function stopClock() {
  if (clockTimer) {
    clearInterval(clockTimer);
    clockTimer = null;
  }
  startedAt = null;
  sessionTime.textContent = '0:00';
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

async function poll() {
  const response = await send('GET_STATE');
  if (response && response.ok && response.state) {
    const { phase, startedAt: sa } = response.state;
    if (sa && !startedAt) startedAt = sa;
    setPhaseUI(phase, response.state);
  }
}

function startPolling() {
  poll();
  pollTimer = setInterval(poll, 1000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ---------------------------------------------------------------------------
// AOI management
// ---------------------------------------------------------------------------

function renderAoiList() {
  aoiList.innerHTML = '';
  if (aois.length === 0) {
    aoiList.innerHTML = '<p class="empty-hint">No AOIs defined.</p>';
    return;
  }
  for (let i = 0; i < aois.length; i++) {
    const aoi = aois[i];
    const item = document.createElement('div');
    item.className = 'aoi-item';
    item.innerHTML = `
      <span>${aoi.label} (${aoi.x},${aoi.y} ${aoi.w}×${aoi.h})</span>
      <button class="aoi-remove" data-idx="${i}" title="Remove">×</button>
    `;
    aoiList.appendChild(item);
  }
}

btnAddAoi.addEventListener('click', () => {
  const label = prompt('AOI label:');
  if (!label) return;
  const x = parseInt(prompt('X (px from left):'), 10);
  const y = parseInt(prompt('Y (px from top):'), 10);
  const w = parseInt(prompt('Width (px):'), 10);
  const h = parseInt(prompt('Height (px):'), 10);
  if ([x, y, w, h].some(isNaN)) { alert('Invalid values'); return; }
  aois.push({ label, x, y, w, h });
  renderAoiList();
});

aoiList.addEventListener('click', (e) => {
  const btn = e.target.closest('.aoi-remove');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  aois.splice(idx, 1);
  renderAoiList();
});

// ---------------------------------------------------------------------------
// Button actions
// ---------------------------------------------------------------------------

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Starting…';

  // background.js will open a full tab to request camera permission
  // (popup closes on blur so getUserMedia prompts are dismissed immediately),
  // then create the offscreen doc and show calibration on the active tab.
  const resp = await send('START_SESSION', { aois });
  if (!resp || !resp.ok) {
    alert('Failed to start session: ' + (resp && resp.error));
    btnStart.disabled = false;
    btnStart.textContent = 'Start Session';
    return;
  }

  setPhaseUI('calibrating', resp.state);
  btnStart.disabled = false;
  btnStart.textContent = 'Start Session';
  exportSection.style.display = 'none';
});

btnRecal.addEventListener('click', async () => {
  // Ask background to reset calibration; it will send SHOW_CALIBRATION
  // to the content tab and clear WebGazer's training data in offscreen.
  const resp = await send('RECALIBRATE', {});
  if (resp && resp.ok) {
    setPhaseUI('calibrating', null);
  }
});

btnStop.addEventListener('click', async () => {
  btnStop.disabled = true;
  btnStop.textContent = 'Stopping…';

  // Stop content script
  const tab = await getActiveTab();
  if (tab) {
    chrome.tabs.sendMessage(tab.id, { type: 'STOP_SESSION' }, () => {});
  }

  // Get export data before stopping background
  const exportResp = await send('EXPORT');
  if (exportResp && exportResp.ok) {
    lastExport = exportResp.data;
    showExportSummary(lastExport);
  }

  // Stop background session
  await send('STOP_SESSION');

  setPhaseUI('idle', null);
  btnStop.disabled = false;
  btnStop.textContent = 'Stop & Export';
  stopClock();
});

btnDownload.addEventListener('click', () => {
  if (!lastExport) return;
  const json = JSON.stringify(lastExport, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `webgaze-${lastExport.sessionId || Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------------------------------------------------------------------
// Export summary
// ---------------------------------------------------------------------------

function showExportSummary(data) {
  exportSection.style.display = '';
  const pages = Object.keys(data.pageSummaries || {}).length;
  const dur   = formatDuration(data.durationMs || 0);
  exportSummary.innerHTML = `
    <div>Session: <strong>${data.sessionId || '—'}</strong></div>
    <div>Duration: <strong>${dur}</strong></div>
    <div>Gaze points: <strong>${data.totalGazePoints || 0}</strong></div>
    <div>Pages tracked: <strong>${pages}</strong></div>
  `;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

renderAoiList();
startPolling();

// Clean up when popup closes
window.addEventListener('unload', stopPolling);
