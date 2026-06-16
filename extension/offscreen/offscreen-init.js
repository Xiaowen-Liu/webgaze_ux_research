// webgazer.begin() calls alert() when protocol !== 'https:' && window.chrome.
// Offscreen documents don't support alert() — it throws and stops execution
// before getUserMedia is ever called. Neutralise it before webgazer loads.
window.alert = function(msg) {
  console.warn('[offscreen] alert suppressed:', msg);
};
