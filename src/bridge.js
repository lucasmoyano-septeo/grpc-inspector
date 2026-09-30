// Isolated-world relay: inject.js (page world) -> background service worker.
document.addEventListener('__grpc_inspector_evt', (e) => {
  if (typeof e.detail !== 'string') return;
  let evt;
  try {
    evt = JSON.parse(e.detail);
  } catch (_) {
    return;
  }
  try {
    chrome.runtime.sendMessage({ kind: 'grpc-evt', evt }).catch(() => {});
  } catch (_) {
    // extension reloaded: this content script is orphaned
  }
});
