# FrameSnap

A Manifest V3 Chrome extension that resizes the browser window to preset
dimensions. Built for web testing, screenshots, and video recording.

Click the toolbar icon → click a preset → window resizes instantly.

<p align="center">
  <img src="docs/screenshot.png" alt="FrameSnap popup — Viewport mode, 1920×1080 highlighted as active" width="320" />
</p>

## Features

- **Window vs Viewport mode** — resize the outer window, or resize so the
  inner viewport hits exact target dimensions (chrome offset is computed
  from the active tab and cached for chrome:// pages).
- **Built-in presets** for Landscape (16:9), Portrait (9:16), Standard (4:3),
  Square (1:1), and common mobile devices.
- **Custom dimensions** with positive-integer validation up to 8000×8000.
- **Saved presets** — name and store custom sizes; persist across browser
  restarts via `chrome.storage.local`.
- **Center on display** — recenters the current window on the active monitor
  (multi-monitor aware via `chrome.system.display`).
- **Clamp warning** — when a target exceeds the active display, the window
  is clamped to the work area and a warning toast is shown.
- **Persists last-used mode** across popup opens.

## Install (unpacked, for development)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome (or any Chromium-based browser).
3. Enable **Developer mode** (toggle, top right).
4. Click **Load unpacked** and select the `FrameSnap/` folder.
5. Pin the FrameSnap icon from the puzzle-piece menu so it's always visible.

No `npm install`, no build step. The folder you load is the extension.

## Permissions

- `windows` — read and update the active browser window's size and position.
- `storage` — persist saved presets, last-used mode, and the cached chrome
  offset locally.
- `system.display` — read display bounds and work-area dimensions for
  clamping and centering.
- `scripting` + `activeTab` — read `outerWidth - innerWidth` and
  `outerHeight - innerHeight` from the active tab so Viewport mode can
  account for the browser chrome.

No host permissions are requested. No network calls are made.

## A note on dimensions

All values are **CSS pixels**. On a high-DPI display, the physical pixel
count will differ by `window.devicePixelRatio`. A "1920 × 1080" viewport on a
2× display occupies 3840 × 2160 physical pixels.

## File layout

```
FrameSnap/
├── manifest.json          MV3 manifest
├── popup.html             Popup markup
├── popup.css              Popup styles (dark, dense)
├── popup.js               Popup logic — resize, persistence, rendering
├── background.js          Minimal service worker (reserved for future use)
├── icons/                 16/32/48/128 px PNGs
└── README.md
```

## Browser support

Chrome / Edge / Brave / Arc / any Chromium 100+. Firefox is not yet supported
(the manifest would need adjusting and `chrome.system.display` is Chromium-only).

## License

See `LICENSE`.
