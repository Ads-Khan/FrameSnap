// FrameSnap popup logic.
// Vanilla JS, no build step. Targets MV3 chrome.* APIs only.

(() => {
  "use strict";

  // ---------------------------------------------------------------------------
  // Built-in preset definitions. Order within each group is preserved.
  // ---------------------------------------------------------------------------

  const BUILTIN = {
    landscape: [
      { w: 1280, h: 720 },
      { w: 1920, h: 1080 },
      { w: 2560, h: 1440 },
      { w: 3840, h: 2160 },
    ],
    portrait: [
      { w: 720, h: 1280 },
      { w: 1080, h: 1920 },
    ],
    standard: [
      { w: 1024, h: 768 },
      { w: 1280, h: 960 },
    ],
    square: [{ w: 1080, h: 1080 }],
    mobile: [
      { w: 393, h: 852, label: "iPhone 15" },
      { w: 412, h: 915, label: "Pixel 8" },
    ],
  };

  const STORAGE_KEYS = {
    mode: "fs.mode", // "window" | "viewport"
    saved: "fs.saved", // [{id, name, w, h}]
    chromeOffset: "fs.chromeOffset", // {x, y} — last known viewport-chrome offset
  };

  const MAX_DIM = 8000;
  const MIN_CHROME_DELTA_X = 0;
  const MIN_CHROME_DELTA_Y = 0;
  // Reasonable fallback if we can't read the active tab (e.g. chrome:// pages).
  const FALLBACK_OFFSET = { x: 0, y: 88 };

  // ---------------------------------------------------------------------------
  // DOM refs
  // ---------------------------------------------------------------------------

  const $ = (sel, root = document) => root.querySelector(sel);

  const els = {
    segmented: $(".segmented"),
    options: document.querySelectorAll(".segmented-option"),
    grids: {
      landscape: $('[data-grid="landscape"]'),
      portrait: $('[data-grid="portrait"]'),
      standard: $('[data-grid="standard"]'),
      square: $('[data-grid="square"]'),
      mobile: $('[data-grid="mobile"]'),
      saved: $('[data-grid="saved"]'),
    },
    savedGroup: $("#saved-group"),
    customForm: $("#custom-form"),
    customW: $("#custom-width"),
    customH: $("#custom-height"),
    customError: $("#custom-error"),
    saveBtn: $("#save-preset"),
    centerBtn: $("#center-btn"),
    toast: $("#toast"),
    saveModal: $("#save-modal"),
    saveModalDesc: $("#save-modal-desc"),
    saveName: $("#save-name"),
    saveCancel: $("#save-cancel"),
    saveConfirm: $("#save-confirm"),
    infoBtn: $("#info-btn"),
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    mode: "window",
    saved: [],
    pendingSave: null, // {w, h}
  };

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  function storageGet(keys) {
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, (res) => resolve(res || {}));
    });
  }

  function storageSet(obj) {
    return new Promise((resolve) => {
      chrome.storage.local.set(obj, () => resolve());
    });
  }

  // ---------------------------------------------------------------------------
  // Chrome window helpers
  // ---------------------------------------------------------------------------

  function getActiveTab() {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tabs && tabs[0] ? tabs[0] : null);
      });
    });
  }

  function getWindow(windowId) {
    return new Promise((resolve, reject) => {
      chrome.windows.get(windowId, (win) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(win);
      });
    });
  }

  function updateWindow(windowId, updateInfo) {
    return new Promise((resolve, reject) => {
      chrome.windows.update(windowId, updateInfo, (win) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(win);
      });
    });
  }

  function getDisplays() {
    return new Promise((resolve, reject) => {
      chrome.system.display.getInfo((displays) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(displays || []);
      });
    });
  }

  // Picks the display that contains the window's center, falling back to
  // primary or the first display if no overlap is found.
  function pickDisplay(displays, win) {
    if (!displays.length) return null;

    const cx = win.left + win.width / 2;
    const cy = win.top + win.height / 2;

    for (const d of displays) {
      const b = d.bounds;
      if (cx >= b.left && cx <= b.left + b.width && cy >= b.top && cy <= b.top + b.height) {
        return d;
      }
    }
    return displays.find((d) => d.isPrimary) || displays[0];
  }

  // Reads window.outerWidth - innerWidth and outerHeight - innerHeight from the
  // active tab. Falls back to a cached value, then to FALLBACK_OFFSET.
  async function readChromeOffset(tab) {
    if (tab && tab.id != null) {
      try {
        const results = await new Promise((resolve, reject) => {
          chrome.scripting.executeScript(
            {
              target: { tabId: tab.id },
              func: () => ({
                x: window.outerWidth - window.innerWidth,
                y: window.outerHeight - window.innerHeight,
              }),
            },
            (out) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
              }
              resolve(out);
            }
          );
        });
        const r = results && results[0] && results[0].result;
        if (r && Number.isFinite(r.x) && Number.isFinite(r.y)) {
          const offset = {
            x: Math.max(MIN_CHROME_DELTA_X, Math.round(r.x)),
            y: Math.max(MIN_CHROME_DELTA_Y, Math.round(r.y)),
          };
          // Cache last good offset so future popups can use it on chrome:// pages.
          storageSet({ [STORAGE_KEYS.chromeOffset]: offset });
          return offset;
        }
      } catch (_e) {
        // Inaccessible tab (chrome://, web store, file:// without permission).
        // Fall through to cached/fallback below.
      }
    }
    const cached = await storageGet(STORAGE_KEYS.chromeOffset);
    return cached[STORAGE_KEYS.chromeOffset] || FALLBACK_OFFSET;
  }

  // ---------------------------------------------------------------------------
  // Resize core
  // ---------------------------------------------------------------------------

  // Resizes the active window to the given target dimensions. In viewport mode,
  // dims describe the inner viewport; in window mode, the outer window.
  async function resizeTo(targetW, targetH) {
    if (!Number.isFinite(targetW) || !Number.isFinite(targetH)) return;

    const tab = await getActiveTab();
    if (!tab || tab.windowId == null) {
      showToast("No active window", { warning: true });
      return;
    }

    const win = await getWindow(tab.windowId);
    const displays = await getDisplays();
    const display = pickDisplay(displays, win);

    let outerW = targetW;
    let outerH = targetH;
    let labelW = targetW;
    let labelH = targetH;

    if (state.mode === "viewport") {
      const offset = await readChromeOffset(tab);
      outerW = targetW + offset.x;
      outerH = targetH + offset.y;
    }

    // Clamp to screen if needed.
    let clamped = false;
    if (display) {
      const maxW = display.workArea ? display.workArea.width : display.bounds.width;
      const maxH = display.workArea ? display.workArea.height : display.bounds.height;
      if (outerW > maxW) {
        outerW = maxW;
        clamped = true;
      }
      if (outerH > maxH) {
        outerH = maxH;
        clamped = true;
      }
    }

    // Chrome enforces a minimum window size; values below 100 misbehave.
    outerW = Math.max(100, Math.round(outerW));
    outerH = Math.max(100, Math.round(outerH));

    try {
      await updateWindow(win.id, {
        width: outerW,
        height: outerH,
        state: "normal",
      });
    } catch (e) {
      showToast("Resize failed", { warning: true });
      return;
    }

    if (clamped) {
      showToast(`Exceeds screen — clamped to ${outerW}×${outerH}`, {
        warning: true,
      });
    } else {
      showToast(`Resized to ${labelW}×${labelH}`);
    }
  }

  async function centerWindow() {
    const tab = await getActiveTab();
    if (!tab || tab.windowId == null) {
      showToast("No active window", { warning: true });
      return;
    }
    const win = await getWindow(tab.windowId);
    const displays = await getDisplays();
    const display = pickDisplay(displays, win);
    if (!display) {
      showToast("No display info", { warning: true });
      return;
    }
    const area = display.workArea || display.bounds;
    const left = Math.round(area.left + (area.width - win.width) / 2);
    const top = Math.round(area.top + (area.height - win.height) / 2);

    try {
      await updateWindow(win.id, { left, top, state: "normal" });
      showToast("Centered");
    } catch (_e) {
      showToast("Center failed", { warning: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  // Computes a small proportional rectangle (24×24 box) that conveys the
  // aspect ratio of a preset.
  function shapeFor(w, h) {
    const max = 24;
    const min = 4;
    const ratio = w / h;
    let sw;
    let sh;
    if (ratio >= 1) {
      sw = max;
      sh = Math.max(min, Math.round((max / ratio) * 10) / 10);
    } else {
      sh = max;
      sw = Math.max(min, Math.round(max * ratio * 10) / 10);
    }
    return { w: sw, h: sh };
  }

  function buildShape(w, h) {
    const { w: sw, h: sh } = shapeFor(w, h);
    const wrap = document.createElement("span");
    wrap.className = "preset-shape";
    const rect = document.createElement("span");
    rect.className = "preset-shape-rect";
    rect.style.width = `${sw}px`;
    rect.style.height = `${sh}px`;
    wrap.appendChild(rect);
    return wrap;
  }

  function buildCard(preset, { deletable = false } = {}) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.appendChild(buildShape(preset.w, preset.h));

    const text = document.createElement("span");
    text.className = "preset-text";

    const dims = document.createElement("span");
    dims.className = "preset-dims";
    dims.textContent = `${preset.w} × ${preset.h}`;
    text.appendChild(dims);

    if (preset.label || preset.name) {
      const label = document.createElement("span");
      label.className = "preset-label";
      label.textContent = preset.label || preset.name;
      text.appendChild(label);
    }
    card.appendChild(text);

    card.addEventListener("click", () => {
      pressFeedback(card);
      resizeTo(preset.w, preset.h);
    });

    if (deletable) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "preset-delete";
      del.title = "Delete preset";
      del.setAttribute("aria-label", `Delete ${preset.name || "preset"}`);
      del.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteSavedPreset(preset.id);
      });
      card.appendChild(del);
    }

    return card;
  }

  function pressFeedback(el) {
    el.classList.add("is-pressed");
    setTimeout(() => el.classList.remove("is-pressed"), 110);
  }

  function renderBuiltins() {
    for (const group of Object.keys(BUILTIN)) {
      const grid = els.grids[group];
      if (!grid) continue;
      grid.replaceChildren();
      for (const p of BUILTIN[group]) {
        grid.appendChild(buildCard(p));
      }
    }
  }

  function renderSaved() {
    const grid = els.grids.saved;
    grid.replaceChildren();
    if (!state.saved.length) {
      els.savedGroup.hidden = true;
      return;
    }
    els.savedGroup.hidden = false;
    for (const p of state.saved) {
      grid.appendChild(buildCard(p, { deletable: true }));
    }
  }

  // ---------------------------------------------------------------------------
  // Mode toggle
  // ---------------------------------------------------------------------------

  function setMode(mode, { persist = true } = {}) {
    if (mode !== "window" && mode !== "viewport") return;
    state.mode = mode;
    els.segmented.dataset.active = mode;
    els.options.forEach((btn) => {
      btn.setAttribute("aria-selected", btn.dataset.mode === mode ? "true" : "false");
    });
    if (persist) storageSet({ [STORAGE_KEYS.mode]: mode });
  }

  // ---------------------------------------------------------------------------
  // Custom dimensions
  // ---------------------------------------------------------------------------

  // Returns {w, h} or null. Sets an inline error message when invalid.
  function readCustomDims() {
    const wRaw = els.customW.value.trim();
    const hRaw = els.customH.value.trim();
    if (!wRaw || !hRaw) {
      setCustomError("Enter width and height");
      return null;
    }
    const w = Number(wRaw);
    const h = Number(hRaw);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      setCustomError("Whole positive numbers only");
      return null;
    }
    if (w > MAX_DIM || h > MAX_DIM) {
      setCustomError(`Max ${MAX_DIM}px per side`);
      return null;
    }
    setCustomError("");
    return { w, h };
  }

  function setCustomError(msg) {
    els.customError.textContent = msg;
  }

  // ---------------------------------------------------------------------------
  // Saved presets
  // ---------------------------------------------------------------------------

  function makeId() {
    return "p_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  }

  async function loadSaved() {
    const out = await storageGet(STORAGE_KEYS.saved);
    const list = Array.isArray(out[STORAGE_KEYS.saved]) ? out[STORAGE_KEYS.saved] : [];
    // Filter for shape: defensively drop malformed entries.
    state.saved = list.filter(
      (p) =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        Number.isInteger(p.w) &&
        Number.isInteger(p.h)
    );
  }

  async function persistSaved() {
    await storageSet({ [STORAGE_KEYS.saved]: state.saved });
  }

  async function addSavedPreset(name, w, h) {
    state.saved.push({ id: makeId(), name, w, h });
    await persistSaved();
    renderSaved();
  }

  async function deleteSavedPreset(id) {
    state.saved = state.saved.filter((p) => p.id !== id);
    await persistSaved();
    renderSaved();
  }

  // ---------------------------------------------------------------------------
  // Save modal
  // ---------------------------------------------------------------------------

  function openSaveModal(w, h) {
    state.pendingSave = { w, h };
    els.saveModalDesc.textContent = `${w} × ${h}`;
    els.saveName.value = "";
    els.saveModal.hidden = false;
    setTimeout(() => els.saveName.focus(), 0);
  }

  function closeSaveModal() {
    state.pendingSave = null;
    els.saveModal.hidden = true;
  }

  async function confirmSave() {
    if (!state.pendingSave) return;
    const name = els.saveName.value.trim();
    if (!name) {
      els.saveName.focus();
      return;
    }
    const { w, h } = state.pendingSave;
    await addSavedPreset(name.slice(0, 40), w, h);
    closeSaveModal();
    showToast(`Saved "${name.slice(0, 40)}"`);
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let toastTimer = null;

  function showToast(message, { warning = false } = {}) {
    els.toast.textContent = message;
    els.toast.classList.toggle("is-warning", !!warning);
    els.toast.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("is-visible");
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Wire up events
  // ---------------------------------------------------------------------------

  function wire() {
    els.options.forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    els.customForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const dims = readCustomDims();
      if (!dims) return;
      resizeTo(dims.w, dims.h);
    });

    [els.customW, els.customH].forEach((input) => {
      input.addEventListener("input", () => setCustomError(""));
    });

    els.saveBtn.addEventListener("click", () => {
      const dims = readCustomDims();
      if (!dims) return;
      openSaveModal(dims.w, dims.h);
    });

    els.saveCancel.addEventListener("click", closeSaveModal);
    els.saveConfirm.addEventListener("click", confirmSave);
    els.saveName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        confirmSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeSaveModal();
      }
    });
    els.saveModal.addEventListener("click", (e) => {
      if (e.target === els.saveModal) closeSaveModal();
    });

    els.centerBtn.addEventListener("click", () => {
      pressFeedback(els.centerBtn);
      centerWindow();
    });

    els.infoBtn.addEventListener("click", () => {
      showToast("FrameSnap · v0.1.0");
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    const stored = await storageGet([STORAGE_KEYS.mode, STORAGE_KEYS.saved]);
    setMode(stored[STORAGE_KEYS.mode] === "viewport" ? "viewport" : "window", {
      persist: false,
    });
    await loadSaved();
    renderBuiltins();
    renderSaved();
    wire();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
