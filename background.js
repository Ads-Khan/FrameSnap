// FrameSnap service worker.
// Currently minimal — reserved for future keyboard shortcut and command
// handling. MV3 requires a registered service worker even when idle.

chrome.runtime.onInstalled.addListener(() => {
  // Reserved for first-run setup (e.g. seed default custom presets).
});
