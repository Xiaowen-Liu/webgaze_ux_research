'use strict';

(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    stream.getTracks().forEach(t => t.stop()); // release immediately after permission granted
    chrome.runtime.sendMessage({ type: 'CAMERA_GRANTED' });
    // Tab will be closed by background.js
  } catch (err) {
    document.getElementById('spinner').style.display = 'none';
    document.getElementById('title').textContent = 'Camera Access Denied';
    document.getElementById('msg').innerHTML =
      `<span class="error">${err.name}: ${err.message}</span><br><br>
       Please allow camera access in your browser settings and try again.`;
    chrome.runtime.sendMessage({ type: 'CAMERA_DENIED', payload: { error: err.message } });
  }
})();
