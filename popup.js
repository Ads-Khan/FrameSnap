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
    frameEnabled: "fs.frameEnabled", // boolean
    frameGradient: "fs.frameGradient", // gradient preset id
    output: "fs.output", // "file" | "clipboard"
  };

  // Curated gradient presets for framed screenshots. Restrained, dev-tool
  // palette — one cool accent, one neutral, one warm, one organic, one deep.
  // Stops are { color, offset 0..1 }; angle is degrees clockwise from up.
  const FRAME_GRADIENTS = {
    indigo: {
      name: "Indigo",
      angle: 135,
      stops: [
        { color: "#7C7CFF", at: 0 },
        { color: "#4A4ABA", at: 1 },
      ],
    },
    graphite: {
      name: "Graphite",
      angle: 135,
      stops: [
        { color: "#3F4350", at: 0 },
        { color: "#1A1D24", at: 1 },
      ],
    },
    apricot: {
      name: "Apricot",
      angle: 135,
      stops: [
        { color: "#FFC9A0", at: 0 },
        { color: "#E89668", at: 1 },
      ],
    },
    sage: {
      name: "Sage",
      angle: 135,
      stops: [
        { color: "#B8DDC2", at: 0 },
        { color: "#6FA68A", at: 1 },
      ],
    },
    storm: {
      name: "Storm",
      angle: 135,
      stops: [
        { color: "#5C7080", at: 0 },
        { color: "#1F2A35", at: 1 },
      ],
    },
  };

  const DEFAULT_GRADIENT = "indigo";

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
    segmented: $("#mode-segmented"),
    options: document.querySelectorAll("#mode-segmented .segmented-option"),
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
    saveModalNote: $("#save-modal-note"),
    infoBtn: $("#info-btn"),
    currentDims: $("#current-dims"),
    captureBtn: $("#capture-btn"),
    searchInput: $("#search-input"),
    searchClear: $("#search-clear"),
    searchEmpty: $("#search-empty"),
    editModal: $("#edit-modal"),
    editName: $("#edit-name"),
    editWidth: $("#edit-width"),
    editHeight: $("#edit-height"),
    editError: $("#edit-modal-error"),
    editCancel: $("#edit-cancel"),
    editConfirm: $("#edit-confirm"),
    captureVisibleBtn: $("#capture-visible"),
    captureFullpageBtn: $("#capture-fullpage"),
    captureModal: $("#capture-modal"),
    captureStatus: $("#capture-status"),
    captureCancel: $("#capture-cancel"),
    frameSegmented: $("#frame-segmented"),
    frameOptions: document.querySelectorAll(
      "#frame-segmented .segmented-option"
    ),
    frameSwatches: $("#frame-swatches"),
    outputSegmented: $("#output-segmented"),
    outputOptions: document.querySelectorAll(
      "#output-segmented .segmented-option"
    ),
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    mode: "window",
    saved: [],
    pendingSave: null, // {w, h}
    editingId: null, // id of the saved preset currently being edited
    dragSourceId: null, // id of the saved preset currently being dragged
    searchQuery: "",
    capture: { active: false, cancelled: false, debuggerTarget: null },
    frame: { enabled: false, gradient: DEFAULT_GRADIENT },
    output: "file", // "file" | "clipboard"
    // Live measurements of the active window. `outer` is what `chrome.windows`
    // sees; `inner` is the page viewport (read via scripting).
    current: { outer: null, inner: null },
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

    // Refresh the live measurement strip and the active-preset highlight.
    refreshCurrent();
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

  // Search-token text that decorates each card so the filter can match by
  // dimension, label/name, or aspect-ratio family.
  const GROUP_SEARCH_TOKENS = {
    landscape: "landscape 16:9",
    portrait: "portrait 9:16",
    standard: "standard 4:3",
    square: "square 1:1",
    mobile: "mobile",
    saved: "saved",
  };

  function buildCard(preset, { deletable = false, group = "" } = {}) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.dataset.w = String(preset.w);
    card.dataset.h = String(preset.h);
    card.dataset.search = [
      `${preset.w} ${preset.h}`,
      `${preset.w}x${preset.h}`,
      `${preset.w}×${preset.h}`,
      preset.label || preset.name || "",
      GROUP_SEARCH_TOKENS[group] || "",
    ]
      .join(" ")
      .toLowerCase();

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
      // Saved cards get edit + delete action buttons and are draggable.
      card.dataset.savedId = preset.id;
      card.draggable = true;
      attachDragHandlers(card, preset.id);

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "preset-action preset-edit";
      edit.title = "Edit preset";
      edit.setAttribute("aria-label", `Edit ${preset.name || "preset"}`);
      edit.innerHTML =
        '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>';
      edit.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditModal(preset.id);
      });
      card.appendChild(edit);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "preset-action preset-delete";
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
        grid.appendChild(buildCard(p, { group }));
      }
    }
  }

  function renderSaved() {
    const grid = els.grids.saved;
    grid.replaceChildren();
    if (!state.saved.length) {
      els.savedGroup.hidden = true;
      applyFilter(state.searchQuery);
      return;
    }
    els.savedGroup.hidden = false;
    for (const p of state.saved) {
      grid.appendChild(buildCard(p, { deletable: true, group: "saved" }));
    }
    applyFilter(state.searchQuery);
  }

  // ---------------------------------------------------------------------------
  // Live window measurements + active-preset highlight
  // ---------------------------------------------------------------------------

  // Reads both outer (window) and inner (viewport) dimensions from the active
  // tab. Updates the chromeOffset cache as a side effect so resizeTo() benefits
  // even when the user is currently on a non-injectable page.
  async function getCurrentDims() {
    const tab = await getActiveTab();
    if (!tab || tab.windowId == null) return { outer: null, inner: null };

    let outer = null;
    try {
      const win = await getWindow(tab.windowId);
      outer = { w: Math.round(win.width), h: Math.round(win.height) };
    } catch (_e) {
      // No accessible window — leave outer null.
    }

    let inner = null;
    if (tab.id != null) {
      try {
        const results = await new Promise((resolve, reject) => {
          chrome.scripting.executeScript(
            {
              target: { tabId: tab.id },
              func: () => ({
                outerW: window.outerWidth,
                outerH: window.outerHeight,
                innerW: window.innerWidth,
                innerH: window.innerHeight,
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
        if (r && Number.isFinite(r.innerW) && Number.isFinite(r.innerH)) {
          inner = { w: Math.round(r.innerW), h: Math.round(r.innerH) };
          // Refresh the offset cache for free — accuracy here matters because
          // DevTools toggles change innerHeight without changing outerHeight.
          if (Number.isFinite(r.outerW) && Number.isFinite(r.outerH)) {
            const offset = {
              x: Math.max(MIN_CHROME_DELTA_X, Math.round(r.outerW - r.innerW)),
              y: Math.max(MIN_CHROME_DELTA_Y, Math.round(r.outerH - r.innerH)),
            };
            storageSet({ [STORAGE_KEYS.chromeOffset]: offset });
          }
        }
      } catch (_e) {
        // Inaccessible tab — fall through to derive from cached offset.
      }
    }

    if (!inner && outer) {
      const cached = await storageGet(STORAGE_KEYS.chromeOffset);
      const off = cached[STORAGE_KEYS.chromeOffset] || FALLBACK_OFFSET;
      inner = {
        w: Math.max(0, outer.w - off.x),
        h: Math.max(0, outer.h - off.y),
      };
    }

    return { outer, inner };
  }

  async function refreshCurrent() {
    state.current = await getCurrentDims();
    renderCurrent();
    renderActiveHighlight();
  }

  function currentDimsForMode() {
    return state.mode === "viewport" ? state.current.inner : state.current.outer;
  }

  function renderCurrent() {
    const dims = currentDimsForMode();
    if (dims && Number.isFinite(dims.w) && Number.isFinite(dims.h)) {
      els.currentDims.textContent = `${dims.w} × ${dims.h}`;
      els.currentDims.removeAttribute("data-empty");
    } else {
      els.currentDims.textContent = "—";
      els.currentDims.setAttribute("data-empty", "true");
    }
  }

  // ±1px tolerance — browsers occasionally round window dims by a pixel on
  // HiDPI displays, which would otherwise silently drop the highlight.
  const MATCH_TOLERANCE = 1;

  function renderActiveHighlight() {
    const dims = currentDimsForMode();
    document.querySelectorAll(".preset-card").forEach((card) => {
      const w = Number(card.dataset.w);
      const h = Number(card.dataset.h);
      const match =
        !!dims &&
        Number.isFinite(w) &&
        Number.isFinite(h) &&
        Math.abs(w - dims.w) <= MATCH_TOLERANCE &&
        Math.abs(h - dims.h) <= MATCH_TOLERANCE;
      card.classList.toggle("is-active", match);
      if (match) {
        card.setAttribute("aria-current", "true");
      } else {
        card.removeAttribute("aria-current");
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Duplicate-preset detection (for the save modal)
  // ---------------------------------------------------------------------------

  const GROUP_LABELS = {
    landscape: "Landscape",
    portrait: "Portrait",
    standard: "Standard",
    square: "Square",
    mobile: "Mobile",
  };

  // Returns a human-readable description of an existing preset that matches
  // (w, h), or null if none exists.
  function findMatchingPreset(w, h) {
    for (const group of Object.keys(BUILTIN)) {
      for (const p of BUILTIN[group]) {
        if (p.w === w && p.h === h) {
          const groupLabel = GROUP_LABELS[group] || group;
          return p.label
            ? `${groupLabel} · ${p.label}`
            : `${groupLabel} · ${p.w}×${p.h}`;
        }
      }
    }
    for (const p of state.saved) {
      if (p.w === w && p.h === h) {
        return `Saved · "${p.name}"`;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Search / filter
  // ---------------------------------------------------------------------------

  // Hides preset cards and group sections that don't match the query. The
  // Custom section stays visible regardless so the save-preset flow remains
  // reachable while the user is searching.
  function applyFilter(rawQuery) {
    const q = (rawQuery || "").trim().toLowerCase();
    state.searchQuery = q;
    els.searchClear.hidden = !q;

    const groups = document.querySelectorAll(".preset-group");
    let totalVisible = 0;

    groups.forEach((group) => {
      // Custom is the input/action area, not a preset. Skip filtering.
      if (group.querySelector("#custom-form")) {
        delete group.dataset.empty;
        return;
      }

      let anyVisible = false;
      group.querySelectorAll(".preset-card").forEach((card) => {
        const text = card.dataset.search || "";
        const matches = !q || text.includes(q);
        if (matches) {
          delete card.dataset.hidden;
          anyVisible = true;
        } else {
          card.dataset.hidden = "true";
        }
      });

      // Layer the search filter on top of any base hiding (e.g. the saved
      // group is `hidden` when there are zero saved presets). data-empty hides
      // via CSS without fighting the `hidden` attribute.
      if (q && !anyVisible) {
        group.dataset.empty = "true";
      } else {
        delete group.dataset.empty;
      }

      if (anyVisible) totalVisible += 1;
    });

    // "No matching presets" appears only when actively searching AND nothing
    // among built-in/saved groups matched. Custom is always visible, so we
    // don't count it.
    els.searchEmpty.hidden = !q || totalVisible > 0;
  }

  // ---------------------------------------------------------------------------
  // Edit modal (rename + adjust dims of a saved preset)
  // ---------------------------------------------------------------------------

  function openEditModal(id) {
    const preset = state.saved.find((p) => p.id === id);
    if (!preset) return;
    state.editingId = id;
    els.editName.value = preset.name;
    els.editWidth.value = String(preset.w);
    els.editHeight.value = String(preset.h);
    setEditError("");
    els.editModal.hidden = false;
    setTimeout(() => {
      els.editName.focus();
      els.editName.select();
    }, 0);
  }

  function closeEditModal() {
    state.editingId = null;
    els.editModal.hidden = true;
    setEditError("");
  }

  function setEditError(msg) {
    if (!msg) {
      els.editError.textContent = "";
      els.editError.hidden = true;
      return;
    }
    els.editError.textContent = msg;
    els.editError.hidden = false;
  }

  // Shared dim-validator used by the custom form and the edit modal. Returns
  // {ok: true, w, h} or {ok: false, error}.
  function validateDims(wRaw, hRaw) {
    if (!wRaw || !hRaw) return { ok: false, error: "Enter width and height" };
    const w = Number(wRaw);
    const h = Number(hRaw);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
      return { ok: false, error: "Whole positive numbers only" };
    }
    if (w > MAX_DIM || h > MAX_DIM) {
      return { ok: false, error: `Max ${MAX_DIM}px per side` };
    }
    return { ok: true, w, h };
  }

  async function confirmEdit() {
    if (!state.editingId) return;
    const idx = state.saved.findIndex((p) => p.id === state.editingId);
    if (idx === -1) {
      closeEditModal();
      return;
    }

    const name = els.editName.value.trim();
    if (!name) {
      setEditError("Name can't be empty");
      els.editName.focus();
      return;
    }

    const dimsCheck = validateDims(
      els.editWidth.value.trim(),
      els.editHeight.value.trim()
    );
    if (!dimsCheck.ok) {
      setEditError(dimsCheck.error);
      return;
    }

    const updated = {
      ...state.saved[idx],
      name: name.slice(0, 40),
      w: dimsCheck.w,
      h: dimsCheck.h,
    };
    state.saved[idx] = updated;
    await persistSaved();
    renderSaved();
    renderActiveHighlight();
    closeEditModal();
    showToast(`Updated "${updated.name}"`);
  }

  // ---------------------------------------------------------------------------
  // Drag and drop reordering (saved presets)
  // ---------------------------------------------------------------------------

  function attachDragHandlers(card, presetId) {
    card.addEventListener("dragstart", (e) => {
      // Don't initiate drag from the action buttons.
      if (e.target.closest(".preset-action")) {
        e.preventDefault();
        return;
      }
      state.dragSourceId = presetId;
      card.classList.add("is-dragging");
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        // Some browsers require any data to be set or drag is cancelled.
        try {
          e.dataTransfer.setData("text/plain", presetId);
        } catch (_e) {
          /* ignored — IE-era quirk, harmless on Chromium */
        }
      }
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      clearDropIndicators();
      state.dragSourceId = null;
    });

    card.addEventListener("dragover", (e) => {
      if (!state.dragSourceId) return;
      if (state.dragSourceId === presetId) {
        // Hovering over yourself — no drop indicator.
        e.preventDefault();
        clearDropIndicators();
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      clearDropIndicators();
      card.classList.add(before ? "is-drop-before" : "is-drop-after");
    });

    card.addEventListener("dragleave", (e) => {
      // Only clear if leaving toward something that isn't this card's child.
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove("is-drop-before", "is-drop-after");
      }
    });

    card.addEventListener("drop", (e) => {
      if (!state.dragSourceId) return;
      e.preventDefault();
      const rect = card.getBoundingClientRect();
      const before = e.clientX < rect.left + rect.width / 2;
      const sourceId = state.dragSourceId;
      reorderSaved(sourceId, presetId, before);
    });
  }

  function clearDropIndicators() {
    document
      .querySelectorAll(".preset-card.is-drop-before, .preset-card.is-drop-after")
      .forEach((c) => c.classList.remove("is-drop-before", "is-drop-after"));
  }

  async function reorderSaved(sourceId, targetId, insertBefore) {
    if (sourceId === targetId) return;
    const sourceIdx = state.saved.findIndex((p) => p.id === sourceId);
    const targetIdx = state.saved.findIndex((p) => p.id === targetId);
    if (sourceIdx === -1 || targetIdx === -1) return;

    const [item] = state.saved.splice(sourceIdx, 1);
    // Recompute target index after removal.
    let insertAt = state.saved.findIndex((p) => p.id === targetId);
    if (insertAt === -1) insertAt = state.saved.length;
    if (!insertBefore) insertAt += 1;
    state.saved.splice(insertAt, 0, item);

    await persistSaved();
    renderSaved();
    renderActiveHighlight();
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
    // Mode flip changes which axis (outer vs inner) we display and match against.
    renderCurrent();
    renderActiveHighlight();
  }

  // ---------------------------------------------------------------------------
  // Custom dimensions
  // ---------------------------------------------------------------------------

  // Returns {w, h} or null. Sets an inline error message when invalid.
  // Uses the shared validateDims helper so the edit modal can show the same
  // error messages.
  function readCustomDims() {
    const result = validateDims(
      els.customW.value.trim(),
      els.customH.value.trim()
    );
    if (!result.ok) {
      setCustomError(result.error);
      return null;
    }
    setCustomError("");
    return { w: result.w, h: result.h };
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
    renderActiveHighlight();
  }

  async function deleteSavedPreset(id) {
    state.saved = state.saved.filter((p) => p.id !== id);
    await persistSaved();
    renderSaved();
    renderActiveHighlight();
  }

  // ---------------------------------------------------------------------------
  // Save modal
  // ---------------------------------------------------------------------------

  function openSaveModal(w, h) {
    state.pendingSave = { w, h };
    els.saveModalDesc.textContent = `${w} × ${h}`;

    const match = findMatchingPreset(w, h);
    if (match) {
      els.saveModalNote.textContent = `Already exists: ${match}`;
      els.saveModalNote.hidden = false;
    } else {
      els.saveModalNote.textContent = "";
      els.saveModalNote.hidden = true;
    }

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
  // Screenshot capture
  // ---------------------------------------------------------------------------

  // Chrome rate-limits captureVisibleTab to ~2 per second (500ms gap). Add a
  // small safety margin and a settle delay after each scroll so reflows and
  // lazy-loaded media have time to resolve.
  const CAPTURE_RATE_MS = 550;
  const CAPTURE_SETTLE_MS = 220;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function execScript(tabId, func, args = []) {
    return new Promise((resolve, reject) => {
      chrome.scripting.executeScript(
        { target: { tabId }, func, args },
        (results) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(results && results[0] ? results[0].result : null);
        }
      );
    });
  }

  function captureVisibleTab(windowId, options = { format: "png" }) {
    return new Promise((resolve, reject) => {
      chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(dataUrl);
      });
    });
  }

  function getDomain(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "") || "page";
    } catch (_e) {
      return "page";
    }
  }

  function formatTimestamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
      `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    );
  }

  function captureFilename(domain, kind) {
    const safeDomain = (domain || "page").replace(/[^a-z0-9.-]+/gi, "-");
    return `framesnap-${safeDomain}-${kind}-${formatTimestamp()}.png`;
  }

  // Triggers a save-to-disk download for the given href. Works for data: and
  // blob: URLs from the popup page.
  function triggerDownload(href, filename) {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function setCaptureBusy(card, busy) {
    if (!card) return;
    card.classList.toggle("is-busy", !!busy);
  }

  // ----- Framing (gradient background + rounded corners + drop shadow) -----
  //
  // Composites a captured screenshot onto a gradient canvas with rounded
  // corners and a subtle shadow. Padding is adaptive: short captures get
  // the full target padding; tall full-page captures shrink padding (down
  // to a 16 px floor) so the framed canvas stays under Chrome's
  // ~32k-px GPU canvas limit.

  const FRAME_PADDING_TARGET = 64;
  const FRAME_PADDING_MIN = 16;
  const FRAME_RADIUS = 12;

  function loadImageFromUrl(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image decode failed"));
      img.src = url;
    });
  }

  function canvasToBlob(canvas, type = "image/png") {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Canvas to blob failed"));
      }, type);
    });
  }

  function pickPadding(imgW, imgH) {
    // Target padding shrinks proportionally if it would push either canvas
    // dimension past the GPU's max. Symmetric — same padding all sides.
    const cap = CAPTURE_MAX_HEIGHT;
    const allowed = Math.floor(Math.min((cap - imgW) / 2, (cap - imgH) / 2));
    if (allowed >= FRAME_PADDING_TARGET) return FRAME_PADDING_TARGET;
    return Math.max(FRAME_PADDING_MIN, allowed);
  }

  function pathRoundRect(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function fillCanvasGradient(ctx, w, h, gradDef) {
    // Convert "angle in degrees clockwise from up" (CSS convention) to
    // canvas linear-gradient start/end coordinates.
    const angle = ((gradDef.angle - 90) * Math.PI) / 180;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.sqrt(w * w + h * h) / 2;
    const dx = Math.cos(angle) * r;
    const dy = Math.sin(angle) * r;
    const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    for (const stop of gradDef.stops) {
      grad.addColorStop(stop.at, stop.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  function gradientToCss(gradDef) {
    const stops = gradDef.stops
      .map((s) => `${s.color} ${Math.round(s.at * 100)}%`)
      .join(", ");
    return `linear-gradient(${gradDef.angle}deg, ${stops})`;
  }

  // Returns a PNG blob of the dataURL screenshot composited onto a gradient
  // background with rounded corners and a drop shadow.
  async function applyFrame(dataUrl, gradientId) {
    const gradDef =
      FRAME_GRADIENTS[gradientId] || FRAME_GRADIENTS[DEFAULT_GRADIENT];
    const img = await loadImageFromUrl(dataUrl);

    const imgW = img.naturalWidth || img.width;
    const imgH = img.naturalHeight || img.height;
    const pad = pickPadding(imgW, imgH);
    const canvasW = imgW + pad * 2;
    const canvasH = imgH + pad * 2;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    fillCanvasGradient(ctx, canvasW, canvasH, gradDef);

    // Drop shadow under the screenshot. Shadow scales with available
    // padding so it doesn't dominate tightly-padded tall captures.
    const shadowBlur = Math.min(28, Math.round(pad * 0.4));
    const shadowOffset = Math.min(10, Math.round(pad * 0.18));
    ctx.save();
    ctx.shadowColor = "rgba(0, 0, 0, 0.32)";
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = shadowOffset;
    pathRoundRect(ctx, pad, pad, imgW, imgH, FRAME_RADIUS);
    ctx.fillStyle = "#000"; // colour irrelevant — only shadow paints since the
    ctx.fill(); // image draws over the fill below.
    ctx.restore();

    // Clip to the rounded rect, then draw the screenshot. The clip yields
    // the rounded corners on the screenshot itself.
    ctx.save();
    pathRoundRect(ctx, pad, pad, imgW, imgH, FRAME_RADIUS);
    ctx.clip();
    ctx.drawImage(img, pad, pad);
    ctx.restore();

    return await canvasToBlob(canvas, "image/png");
  }

  // Mirrors triggerDownload but for a Blob — wraps it in an object URL with
  // delayed revocation so the download has time to start.
  function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    triggerDownload(url, filename);
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ----- Clipboard delivery -----

  async function dataUrlToBlob(dataUrl) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  async function writeBlobToClipboard(blob) {
    if (typeof ClipboardItem === "undefined") {
      throw new Error("Clipboard images not supported");
    }
    if (!navigator.clipboard || !navigator.clipboard.write) {
      throw new Error("Clipboard API unavailable");
    }
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type || "image/png"]: blob }),
    ]);
  }

  // Single delivery path used by both capture functions. Honours the user's
  // current output preference (file vs clipboard); on clipboard failure (rare
  // — gesture timeout, OS clipboard busy, etc.) falls back to file save with
  // a warning toast so the capture isn't lost.
  //
  // `payload` is { blob?, dataUrl? } — at least one must be set.
  // Returns "clipboard" | "file" indicating where the image actually went.
  async function deliverImage(payload, filename) {
    if (state.output === "clipboard") {
      try {
        let blob = payload.blob;
        if (!blob && payload.dataUrl) {
          blob = await dataUrlToBlob(payload.dataUrl);
        }
        if (!blob) throw new Error("No image data");
        await writeBlobToClipboard(blob);
        return "clipboard";
      } catch (_e) {
        showToast("Clipboard failed — saving as file", { warning: true });
        // Fall through to file path.
      }
    }

    if (payload.blob) {
      triggerBlobDownload(payload.blob, filename);
    } else if (payload.dataUrl) {
      triggerDownload(payload.dataUrl, filename);
    }
    return "file";
  }

  // ----- Frame UI controls -----

  function setFrameMode(mode, { persist = true } = {}) {
    if (mode !== "raw" && mode !== "framed") return;
    state.frame.enabled = mode === "framed";
    els.frameSegmented.dataset.active = mode;
    els.frameOptions.forEach((btn) => {
      btn.setAttribute(
        "aria-selected",
        btn.dataset.frame === mode ? "true" : "false"
      );
    });
    els.frameSwatches.hidden = mode !== "framed";
    if (persist) storageSet({ [STORAGE_KEYS.frameEnabled]: state.frame.enabled });
  }

  function setOutputMode(mode, { persist = true } = {}) {
    if (mode !== "file" && mode !== "clipboard") return;
    state.output = mode;
    els.outputSegmented.dataset.active = mode;
    els.outputOptions.forEach((btn) => {
      btn.setAttribute(
        "aria-selected",
        btn.dataset.output === mode ? "true" : "false"
      );
    });
    if (persist) storageSet({ [STORAGE_KEYS.output]: mode });
  }

  function setFrameGradient(id, { persist = true } = {}) {
    if (!FRAME_GRADIENTS[id]) return;
    state.frame.gradient = id;
    els.frameSwatches.querySelectorAll(".frame-swatch").forEach((sw) => {
      const isActive = sw.dataset.gradient === id;
      sw.classList.toggle("is-active", isActive);
      sw.setAttribute("aria-checked", isActive ? "true" : "false");
    });
    if (persist) storageSet({ [STORAGE_KEYS.frameGradient]: id });
  }

  function renderFrameSwatches() {
    const container = els.frameSwatches;
    container.replaceChildren();
    for (const [id, def] of Object.entries(FRAME_GRADIENTS)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "frame-swatch";
      btn.dataset.gradient = id;
      btn.title = def.name;
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-label", def.name);
      btn.setAttribute(
        "aria-checked",
        id === state.frame.gradient ? "true" : "false"
      );
      btn.style.backgroundImage = gradientToCss(def);
      if (id === state.frame.gradient) btn.classList.add("is-active");
      btn.addEventListener("click", () => setFrameGradient(id));
      container.appendChild(btn);
    }
  }

  // ----- Visible-area capture -----

  async function captureVisibleArea() {
    if (state.capture.active) return;
    state.capture.active = true;
    setCaptureBusy(els.captureVisibleBtn, true);
    try {
      const tab = await getActiveTab();
      if (!tab || tab.windowId == null) {
        showToast("No active tab", { warning: true });
        return;
      }
      const dataUrl = await captureVisibleTab(tab.windowId, { format: "png" });
      const filename = captureFilename(getDomain(tab.url), "viewable");

      const blob = state.frame.enabled
        ? await applyFrame(dataUrl, state.frame.gradient)
        : null;

      const mode = await deliverImage({ blob, dataUrl }, filename);
      showToast(
        mode === "clipboard"
          ? state.frame.enabled
            ? "Copied framed image to clipboard"
            : "Copied to clipboard"
          : `Saved ${filename}`
      );
    } catch (e) {
      showToast(`Capture failed: ${e.message || "unknown error"}`, {
        warning: true,
      });
    } finally {
      setCaptureBusy(els.captureVisibleBtn, false);
      state.capture.active = false;
    }
  }

  // ----- Capture modal -----

  function showCaptureModal() {
    els.captureModal.hidden = false;
  }

  function hideCaptureModal() {
    els.captureModal.hidden = true;
  }

  function setCaptureStatus(message) {
    els.captureStatus.textContent = message;
  }

  // ----- chrome.debugger helpers -----
  //
  // Page.captureScreenshot({ captureBeyondViewport: true }) is the same call
  // Chrome's own DevTools "Capture full size screenshot" runs. The browser
  // renders the entire DOM at its natural size in a single render pass —
  // nothing depends on programmatic scroll, scrollHeight reporting, lazy-load
  // detection, or any of the things that broke the scroll-and-stitch path on
  // SPAs like LinkedIn.
  //
  // The cost is the user-visible "This tab is being controlled by automated
  // test software" infobar that Chromium shows while the debugger is
  // attached. We attach, capture, detach as quickly as possible (~1 second).

  function debuggerAttach(target, version) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach(target, version, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
  }

  function debuggerDetach(target) {
    return new Promise((resolve) => {
      chrome.debugger.detach(target, () => {
        // A detach error usually means we were already detached (e.g. tab
        // navigated). Harmless — resolve either way.
        void chrome.runtime.lastError;
        resolve();
      });
    });
  }

  function debuggerSendCommand(target, method, params = {}) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(target, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(result);
      });
    });
  }

  // ----- Full-page capture -----

  // Chromium GPU max texture height on most desktops. Exceeding this causes
  // Page.captureScreenshot to fail or return a truncated image.
  const CAPTURE_MAX_HEIGHT = 16384;
  // How long to wait for new content to settle after each scroll-to-bottom.
  const CAPTURE_LOAD_WAIT_MS = 800;
  // Safety cap on the load loop — protects against truly infinite feeds.
  const CAPTURE_LOAD_MAX_ITERATIONS = 30;
  // After scrollHeight stops growing, this many quiet rounds confirms the
  // page is genuinely done loading (vs. a brief network pause).
  const CAPTURE_LOAD_STABLE_ROUNDS = 2;

  // Drives the page to load lazy / virtualized content before we capture it.
  // Combines two scroll mechanisms because different sites respond to
  // different ones:
  //   1. Runtime.evaluate window.scrollTo — instant, works on most sites.
  //   2. Input.synthesizeScrollGesture — injects a trusted user-style scroll
  //      gesture. Works on sites that ignore programmatic scroll
  //      (anti-automation) and on sites with custom scroll containers where
  //      window.scrollTo is a no-op.
  // Returns the final content height when the page stops growing or we hit
  // a cap.
  async function loadDeferredContent(target, layoutVp) {
    let lastHeight = 0;
    let stable = 0;

    for (let i = 0; i < CAPTURE_LOAD_MAX_ITERATIONS; i++) {
      if (state.capture.cancelled) throw new Error("__CANCELLED__");

      let metrics;
      try {
        metrics = await debuggerSendCommand(target, "Page.getLayoutMetrics");
      } catch (_e) {
        return lastHeight;
      }
      const cssContent = metrics.cssContentSize || metrics.contentSize;
      if (!cssContent) return lastHeight;

      const currentHeight = cssContent.height;
      setCaptureStatus(
        `Loading content… ${Math.round(currentHeight).toLocaleString()} px`
      );

      // Hit our hard cap — no point loading more, the capture would be
      // truncated anyway.
      if (currentHeight >= CAPTURE_MAX_HEIGHT) return currentHeight;

      // Page hasn't grown — count this as a stable round.
      if (currentHeight <= lastHeight + 50) {
        stable += 1;
        if (stable >= CAPTURE_LOAD_STABLE_ROUNDS) return currentHeight;
      } else {
        stable = 0;
      }

      // Try the cheap path first: JS scrollTo via the privileged debugger
      // context. Pokes every plausible scroll target so custom-container
      // sites also move.
      try {
        await debuggerSendCommand(target, "Runtime.evaluate", {
          expression:
            "(function(){var m=Math.max((document.body&&document.body.scrollHeight)||0,document.documentElement.scrollHeight);" +
            "try{window.scrollTo(0,m);}catch(_){}try{document.scrollingElement&&(document.scrollingElement.scrollTop=m);}catch(_){}" +
            "try{document.body&&(document.body.scrollTop=m);}catch(_){}try{document.documentElement.scrollTop=m;}catch(_){}})()",
        });
      } catch (_e) {
        /* ignore — gesture below is the fallback */
      }

      // Layer a synthesized scroll gesture on top. Trusted input event,
      // routed to whatever container is under (x, y) — handles sites with
      // custom scroll containers OR with anti-automation that filters
      // programmatic scroll.
      try {
        const x = Math.max(10, Math.round((layoutVp.clientWidth || 800) / 2));
        const y = Math.max(10, Math.round((layoutVp.clientHeight || 600) / 2));
        await debuggerSendCommand(target, "Input.synthesizeScrollGesture", {
          x,
          y,
          xDistance: 0,
          yDistance: -8000,
          speed: 12000,
        });
      } catch (_e) {
        /* gesture API may not be available everywhere — runtime path covers most */
      }

      await sleep(CAPTURE_LOAD_WAIT_MS);

      lastHeight = currentHeight;
    }

    return lastHeight;
  }

  async function captureFullPage() {
    if (state.capture.active) return;
    state.capture.active = true;
    state.capture.cancelled = false;
    setCaptureBusy(els.captureFullpageBtn, true);

    let target = null;
    let attached = false;
    let emulationOverridden = false;

    try {
      const tab = await getActiveTab();
      if (!tab || tab.id == null) {
        throw new Error("No active tab");
      }
      // chrome:// pages, the Web Store, and a few other surfaces refuse
      // debugger attach. Detect and surface a useful error instead of letting
      // the attach call's cryptic message bubble up.
      if (
        tab.url &&
        /^(chrome|brave|edge|chromewebstore):/i.test(tab.url)
      ) {
        throw new Error("This page can't be captured");
      }

      target = { tabId: tab.id };
      state.capture.debuggerTarget = target;

      showCaptureModal();
      setCaptureStatus("Attaching…");

      try {
        await debuggerAttach(target, "1.3");
      } catch (e) {
        const msg = (e && e.message) || "attach failed";
        if (/another debugger|already attached/i.test(msg)) {
          throw new Error("Close DevTools on this tab, then retry");
        }
        throw e;
      }
      attached = true;

      if (state.capture.cancelled) throw new Error("__CANCELLED__");

      // Read the *initial* layout viewport — used as the click target for
      // the synthesized scroll gestures during the load loop. (Once we set
      // an emulated viewport later, gesture coordinates would map to that
      // override instead.)
      const initialMetrics = await debuggerSendCommand(
        target,
        "Page.getLayoutMetrics"
      );
      const initialLayoutVp =
        initialMetrics.cssLayoutViewport ||
        initialMetrics.layoutViewport || { clientWidth: 800, clientHeight: 600 };

      // Phase 1: drive the page to load all deferred / virtualized content
      // by scrolling to bottom repeatedly until scrollHeight stops growing
      // or we hit the GPU height cap. This is what makes infinite-scroll
      // feeds (LinkedIn home, Twitter, etc.) actually capture meaningfully
      // — without this the snapshot only contains whatever was in the DOM
      // when the popup opened.
      setCaptureStatus("Loading content…");
      await loadDeferredContent(target, initialLayoutVp);

      if (state.capture.cancelled) throw new Error("__CANCELLED__");

      // Phase 2: scroll back to the top so the captured image starts at the
      // page header rather than mid-feed.
      try {
        await debuggerSendCommand(target, "Runtime.evaluate", {
          expression:
            "try{window.scrollTo(0,0);}catch(_){}try{document.scrollingElement&&(document.scrollingElement.scrollTop=0);}catch(_){}" +
            "try{document.body&&(document.body.scrollTop=0);}catch(_){}try{document.documentElement.scrollTop=0;}catch(_){}",
        });
      } catch (_e) {
        /* page may have detached — finally block will clean up */
      }
      await sleep(250);

      if (state.capture.cancelled) throw new Error("__CANCELLED__");

      setCaptureStatus("Measuring page…");

      // Read the page's true content size + current layout viewport width.
      const layoutMetrics = await debuggerSendCommand(
        target,
        "Page.getLayoutMetrics"
      );
      const cssContent =
        layoutMetrics.cssContentSize || layoutMetrics.contentSize;
      const cssLayout =
        layoutMetrics.cssLayoutViewport || layoutMetrics.layoutViewport;
      if (!cssContent || !cssLayout) {
        throw new Error("Couldn't read page layout");
      }

      const layoutWidth = Math.ceil(cssLayout.clientWidth);
      const fullHeight = Math.ceil(cssContent.height);
      const captureHeight = Math.min(fullHeight, CAPTURE_MAX_HEIGHT);

      // Resize the layout viewport to match the page's content height. This
      // is the key step: without it, position:fixed and position:sticky
      // elements get re-painted at every viewport-sized tile of the captured
      // region (which is the "BBC header repeated 12 times" symptom). With
      // the viewport sized to the entire page, fixed elements anchor once
      // and the page is rendered as one continuous canvas.
      //
      // Width is held at the current layout-viewport width so responsive
      // breakpoints don't flip mid-capture.
      await debuggerSendCommand(target, "Emulation.setDeviceMetricsOverride", {
        width: layoutWidth,
        height: captureHeight,
        deviceScaleFactor: 0, // 0 = preserve the device's actual DPR
        mobile: false,
      });
      emulationOverridden = true;

      // Give the page a beat to relayout under the new viewport size.
      await sleep(200);

      if (state.capture.cancelled) throw new Error("__CANCELLED__");

      setCaptureStatus("Rendering page…");

      const result = await debuggerSendCommand(target, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      });

      if (state.capture.cancelled) throw new Error("__CANCELLED__");
      if (!result || !result.data) {
        throw new Error("Empty screenshot data");
      }

      setCaptureStatus(state.frame.enabled ? "Framing…" : "Saving…");

      const dataUrl = `data:image/png;base64,${result.data}`;
      const filename = captureFilename(getDomain(tab.url), "fullpage");
      const blob = state.frame.enabled
        ? await applyFrame(dataUrl, state.frame.gradient)
        : null;

      const mode = await deliverImage({ blob, dataUrl }, filename);

      const truncated = fullHeight > CAPTURE_MAX_HEIGHT;
      const sizeSuffix = ` · ${layoutWidth}×${captureHeight}${truncated ? " (truncated)" : ""}`;
      showToast(
        mode === "clipboard"
          ? `Copied to clipboard${sizeSuffix}`
          : `Saved${sizeSuffix}`
      );
    } catch (e) {
      const cancelled = e && e.message === "__CANCELLED__";
      if (cancelled) {
        showToast("Capture cancelled", { warning: true });
      } else {
        showToast(`Capture failed: ${e.message || "unknown error"}`, {
          warning: true,
        });
      }
    } finally {
      // Always restore page state: clear emulation BEFORE detach so the page
      // sees the override removed cleanly.
      if (attached && target) {
        if (emulationOverridden) {
          try {
            await debuggerSendCommand(
              target,
              "Emulation.clearDeviceMetricsOverride"
            );
          } catch (_e) {
            /* page may have navigated; nothing to do */
          }
        }
        await debuggerDetach(target);
      }
      hideCaptureModal();
      setCaptureBusy(els.captureFullpageBtn, false);
      state.capture.active = false;
      state.capture.cancelled = false;
      state.capture.debuggerTarget = null;
    }
  }

  function cancelFullPageCapture() {
    if (!state.capture.active) return;
    state.capture.cancelled = true;
    setCaptureStatus("Cancelling…");
    els.captureCancel.disabled = true;
    setTimeout(() => {
      els.captureCancel.disabled = false;
    }, 1500);
  }

  // ---------------------------------------------------------------------------
  // Wire up events
  // ---------------------------------------------------------------------------

  function wire() {
    els.options.forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.mode));
    });

    els.frameOptions.forEach((btn) => {
      btn.addEventListener("click", () => setFrameMode(btn.dataset.frame));
    });

    els.outputOptions.forEach((btn) => {
      btn.addEventListener("click", () => setOutputMode(btn.dataset.output));
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

    els.captureBtn.addEventListener("click", () => {
      const dims = currentDimsForMode();
      if (!dims || !Number.isFinite(dims.w) || !Number.isFinite(dims.h)) {
        showToast("No current dimensions", { warning: true });
        return;
      }
      els.customW.value = String(dims.w);
      els.customH.value = String(dims.h);
      setCustomError("");
      // Clear any active search so the custom section is reachable.
      if (state.searchQuery) {
        els.searchInput.value = "";
        applyFilter("");
      }
      // Scroll the custom section into view and focus the first input so the
      // user can edit before applying or saving.
      els.customW.focus();
      els.customW.select();
      els.customForm.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    // -------- Search --------

    els.searchInput.addEventListener("input", (e) => {
      applyFilter(e.target.value);
    });

    els.searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (els.searchInput.value) {
          e.preventDefault();
          els.searchInput.value = "";
          applyFilter("");
        } else {
          els.searchInput.blur();
        }
      }
    });

    els.searchClear.addEventListener("click", () => {
      els.searchInput.value = "";
      applyFilter("");
      els.searchInput.focus();
    });

    // "/" focuses the search box from anywhere except inside another input.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "/") return;
      const t = e.target;
      const isTyping =
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (isTyping) return;
      e.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    });

    // -------- Edit modal --------

    els.editCancel.addEventListener("click", closeEditModal);
    els.editConfirm.addEventListener("click", confirmEdit);

    [els.editName, els.editWidth, els.editHeight].forEach((input) => {
      input.addEventListener("input", () => setEditError(""));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirmEdit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeEditModal();
        }
      });
    });

    els.editModal.addEventListener("click", (e) => {
      if (e.target === els.editModal) closeEditModal();
    });

    // -------- Capture --------

    els.captureVisibleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pressFeedback(els.captureVisibleBtn);
      captureVisibleArea();
    });

    els.captureFullpageBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      pressFeedback(els.captureFullpageBtn);
      captureFullPage();
    });

    els.captureCancel.addEventListener("click", cancelFullPageCapture);

    // Esc inside the capture modal also cancels.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (state.capture.active && !els.captureModal.hidden) {
        e.preventDefault();
        cancelFullPageCapture();
      }
    });

    els.infoBtn.addEventListener("click", () => {
      showToast("FrameSnap · v0.6.1");
    });
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------

  async function init() {
    const stored = await storageGet([
      STORAGE_KEYS.mode,
      STORAGE_KEYS.saved,
      STORAGE_KEYS.frameEnabled,
      STORAGE_KEYS.frameGradient,
      STORAGE_KEYS.output,
    ]);
    setMode(stored[STORAGE_KEYS.mode] === "viewport" ? "viewport" : "window", {
      persist: false,
    });
    // Restore frame preferences. Default off; default gradient is indigo.
    const savedGradient = stored[STORAGE_KEYS.frameGradient];
    if (savedGradient && FRAME_GRADIENTS[savedGradient]) {
      state.frame.gradient = savedGradient;
    }
    renderFrameSwatches();
    setFrameMode(stored[STORAGE_KEYS.frameEnabled] ? "framed" : "raw", {
      persist: false,
    });
    setOutputMode(stored[STORAGE_KEYS.output] === "clipboard" ? "clipboard" : "file", {
      persist: false,
    });
    await loadSaved();
    renderBuiltins();
    renderSaved();
    wire();
    // Establish a known filter state once the DOM is fully populated, so the
    // search-empty element and group `data-empty` attributes are coherent.
    applyFilter("");
    // Read live window state once so the status strip and active-preset
    // highlight render immediately on popup open.
    refreshCurrent();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
