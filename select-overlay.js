// Injected on demand via chrome.scripting.executeScript. Lets the user drag
// a rectangle over the page, then move/resize it before confirming, then
// reports it back to the background script.
// Exposes window.__screenrecStartSelection__(purpose, audio) as the entry point.

(() => {
  if (window.__screenrecSelectionLoaded__) return;
  window.__screenrecSelectionLoaded__ = true;

  function detectLang() {
    const nav = (navigator.language || "en").toLowerCase();
    return nav.startsWith("ru") ? "ru" : "en";
  }

  const LANG = detectLang();
  const STR = {
    en: {
      hintIdle: "Drag anywhere on the page to select an area",
      hintDragging: "Release to finish, then adjust or confirm",
      hintSelected: "Drag inside to move, drag a handle to resize",
      size: "Size",
      confirm: "Use this area",
      cancel: "Cancel",
      esc: "Esc to cancel · Enter to confirm"
    },
    ru: {
      hintIdle: "Потяните мышью по странице, чтобы выделить область",
      hintDragging: "Отпустите кнопку мыши, затем настройте или подтвердите",
      hintSelected: "Тяните внутри — чтобы двигать, за уголок — чтобы менять размер",
      size: "Размер",
      confirm: "Использовать область",
      cancel: "Отмена",
      esc: "Esc — отмена · Enter — подтвердить"
    }
  }[LANG];

  const MIN_SIZE = 20;
  const HANDLE_SIZE = 12;
  // Order matters for cursor mapping below.
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const CURSORS = {
    nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize", e: "ew-resize",
    se: "nwse-resize", s: "ns-resize", sw: "nesw-resize", w: "ew-resize"
  };

  window.__screenrecStartSelection__ = function (purpose, audio) {
    const overlay = document.createElement("div");
    overlay.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      cursor: crosshair; background: transparent;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const hint = document.createElement("div");
    hint.textContent = STR.hintIdle;
    hint.style.cssText = `
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      background: rgba(20,20,26,0.92); color: #fff; padding: 9px 16px;
      border-radius: 8px; font-size: 13px; z-index: 2147483647; pointer-events: none;
      box-shadow: 0 4px 18px rgba(0,0,0,0.3); white-space: nowrap;
    `;

    // The "spotlight" box: a box-shadow with a huge spread darkens
    // everything OUTSIDE the box, making the selected region visually pop.
    const box = document.createElement("div");
    box.style.cssText = `
      position: fixed; border: 2px solid #7c5cff; display: none;
      z-index: 2147483647; box-shadow: 0 0 0 9999px rgba(0,0,0,0.55);
      cursor: move;
    `;

    const sizeTag = document.createElement("div");
    sizeTag.style.cssText = `
      position: fixed; background: #7c5cff; color: #fff; font-size: 11px;
      padding: 3px 7px; border-radius: 5px; display: none; z-index: 2147483647;
      pointer-events: none; font-weight: 600; white-space: nowrap;
    `;

    // Resize handles — small squares at each corner/edge of the box.
    const handleEls = {};
    HANDLES.forEach((pos) => {
      const h = document.createElement("div");
      h.style.cssText = `
        position: fixed; width: ${HANDLE_SIZE}px; height: ${HANDLE_SIZE}px;
        background: #fff; border: 2px solid #7c5cff; border-radius: 50%;
        z-index: 2147483647; display: none; cursor: ${CURSORS[pos]};
      `;
      handleEls[pos] = h;
    });

    // Controls render INSIDE the box (bottom-right corner by default) so
    // they can never end up off-screen, even for very large selections.
    const controls = document.createElement("div");
    controls.style.cssText = `
      position: fixed; display: none; gap: 8px; z-index: 2147483647;
      font-size: 13px;
    `;
    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = "✓ " + STR.confirm;
    confirmBtn.style.cssText = `
      background: #7c5cff; color: #fff; border: none; padding: 8px 14px;
      border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35); white-space: nowrap;
    `;
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "✕ " + STR.cancel;
    cancelBtn.style.cssText = `
      background: rgba(255,255,255,0.95); color: #17181c; border: none;
      padding: 8px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 700;
      cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.35); white-space: nowrap;
    `;
    controls.appendChild(cancelBtn);
    controls.appendChild(confirmBtn);

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(hint);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(sizeTag);
    Object.values(handleEls).forEach((h) => document.documentElement.appendChild(h));
    document.documentElement.appendChild(controls);

    // rect = the current selection, always kept normalized (positive w/h).
    let rect = null;
    let phase = "idle"; // "idle" | "drawing" | "selected" | "moving" | "resizing"
    let finished = false;
    let dragStart = null; // { mouseX, mouseY, rect: {...} } snapshot at drag start
    let activeHandle = null;

    function cleanup() {
      overlay.remove();
      hint.remove();
      box.remove();
      sizeTag.remove();
      controls.remove();
      Object.values(handleEls).forEach((h) => h.remove());
      document.removeEventListener("keydown", onKeyDown, true);
    }

    function clampRect(r) {
      let { x, y, width, height } = r;
      width = Math.max(MIN_SIZE, width);
      height = Math.max(MIN_SIZE, height);
      x = Math.min(Math.max(0, x), Math.max(0, window.innerWidth - width));
      y = Math.min(Math.max(0, y), Math.max(0, window.innerHeight - height));
      width = Math.min(width, window.innerWidth - x);
      height = Math.min(height, window.innerHeight - y);
      return { x, y, width, height };
    }

    function render() {
      if (!rect) return;
      box.style.display = "block";
      box.style.left = rect.x + "px";
      box.style.top = rect.y + "px";
      box.style.width = rect.width + "px";
      box.style.height = rect.height + "px";

      sizeTag.style.display = "block";
      const tagTop = rect.y > 26 ? rect.y - 24 : rect.y + rect.height + 6;
      sizeTag.style.left = rect.x + "px";
      sizeTag.style.top = tagTop + "px";
      sizeTag.textContent = `${STR.size}: ${Math.round(rect.width)} × ${Math.round(rect.height)}`;

      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const positions = {
        nw: [rect.x, rect.y], n: [cx, rect.y], ne: [rect.x + rect.width, rect.y],
        e: [rect.x + rect.width, cy], se: [rect.x + rect.width, rect.y + rect.height],
        s: [cx, rect.y + rect.height], sw: [rect.x, rect.y + rect.height], w: [rect.x, cy]
      };
      HANDLES.forEach((pos) => {
        const h = handleEls[pos];
        const [hx, hy] = positions[pos];
        h.style.display = phase === "idle" || phase === "drawing" ? "none" : "block";
        h.style.left = (hx - HANDLE_SIZE / 2) + "px";
        h.style.top = (hy - HANDLE_SIZE / 2) + "px";
      });

      if (phase === "selected" || phase === "moving" || phase === "resizing") {
        showControls();
      } else {
        controls.style.display = "none";
      }
    }

    // Prefers placing the confirm/cancel buttons OUTSIDE the box (below it
    // by default, or above if there's no room below) since that keeps them
    // from covering the selected content. Only falls back to anchoring them
    // INSIDE the box (bottom-right corner, clamped) when the box is so
    // large that neither placement fits within the viewport — this is what
    // prevents the controls from disappearing off-screen for huge selections.
    function showControls() {
      controls.style.display = "flex";
      // Measure once controls are visible+laid out.
      const cw = controls.offsetWidth || 180;
      const ch = controls.offsetHeight || 36;
      const gap = 10;
      const margin = 10;

      const fitsBelow = rect.y + rect.height + gap + ch <= window.innerHeight;
      const fitsAbove = rect.y - gap - ch >= 0;

      let left = Math.max(margin, Math.min(rect.x + rect.width - cw, window.innerWidth - cw - margin));
      let top;

      if (fitsBelow) {
        top = rect.y + rect.height + gap;
      } else if (fitsAbove) {
        top = rect.y - gap - ch;
      } else {
        // Neither outside placement fits (box spans nearly the full viewport
        // height) — anchor inside the box instead, clamped to its bounds.
        top = Math.max(rect.y + margin, Math.min(rect.y + rect.height - ch - margin, rect.y + rect.height - ch - 4));
        left = Math.max(rect.x + margin, Math.min(left, rect.x + rect.width - cw - 4));
        if (rect.width < cw + margin * 2) left = rect.x + Math.max(0, (rect.width - cw) / 2);
        if (rect.height < ch + margin * 2) top = rect.y + Math.max(0, (rect.height - ch) / 2);
      }

      controls.style.left = Math.round(left) + "px";
      controls.style.top = Math.round(top) + "px";
    }

    function finish(confirmed) {
      if (finished) return;
      finished = true;
      const r = rect;
      cleanup();
      if (confirmed && r && r.width > 4 && r.height > 4) {
        chrome.runtime.sendMessage({
          type: "AREA_SELECTED",
          purpose,
          audio: !!audio,
          rect: r,
          dpr: window.devicePixelRatio || 1,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight
        });
      } else {
        chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" });
      }
    }

    // ---------- Drawing a brand-new selection ----------

    function startDrawing(e) {
      phase = "drawing";
      dragStart = { mouseX: e.clientX, mouseY: e.clientY };
      rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
      hint.textContent = STR.hintDragging;
      render();
    }

    function updateDrawing(e) {
      const x = Math.min(dragStart.mouseX, e.clientX);
      const y = Math.min(dragStart.mouseY, e.clientY);
      const width = Math.abs(e.clientX - dragStart.mouseX);
      const height = Math.abs(e.clientY - dragStart.mouseY);
      rect = { x, y, width, height };
      render();
    }

    function finishDrawing() {
      if (rect && rect.width > 4 && rect.height > 4) {
        rect = clampRect(rect);
        phase = "selected";
        hint.textContent = STR.hintSelected;
      } else {
        rect = null;
        phase = "idle";
        hint.textContent = STR.hintIdle;
      }
      render();
    }

    // ---------- Moving an existing selection ----------

    function startMoving(e) {
      phase = "moving";
      dragStart = { mouseX: e.clientX, mouseY: e.clientY, rect: { ...rect } };
      render();
    }

    function updateMoving(e) {
      const dx = e.clientX - dragStart.mouseX;
      const dy = e.clientY - dragStart.mouseY;
      const r = dragStart.rect;
      rect = clampRect({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });
      render();
    }

    // ---------- Resizing via a handle ----------

    function startResizing(handlePos, e) {
      phase = "resizing";
      activeHandle = handlePos;
      dragStart = { mouseX: e.clientX, mouseY: e.clientY, rect: { ...rect } };
      render();
    }

    function updateResizing(e) {
      const r = dragStart.rect;
      const dx = e.clientX - dragStart.mouseX;
      const dy = e.clientY - dragStart.mouseY;
      let { x, y, width, height } = r;

      if (activeHandle.includes("e")) width = r.width + dx;
      if (activeHandle.includes("s")) height = r.height + dy;
      if (activeHandle.includes("w")) { x = r.x + dx; width = r.width - dx; }
      if (activeHandle.includes("n")) { y = r.y + dy; height = r.height - dy; }

      // Keep positive dimensions by flipping the anchor if dragged past it.
      if (width < 0) { x += width; width = -width; }
      if (height < 0) { y += height; height = -height; }

      rect = clampRect({ x, y, width, height });
      render();
    }

    function endInteractiveDrag() {
      phase = "selected";
      activeHandle = null;
      hint.textContent = STR.hintSelected;
      render();
    }

    // ---------- Event wiring ----------

    function onMouseDown(e) {
      if (e.button !== 0) return;
      if (phase === "selected") {
        // Starting a new drag on the transparent overlay (outside the box)
        // resets to drawing a fresh rectangle.
        startDrawing(e);
      } else {
        startDrawing(e);
      }
    }

    function onBoxMouseDown(e) {
      if (e.button !== 0) return;
      e.stopPropagation();
      startMoving(e);
    }

    function onMouseMove(e) {
      if (phase === "drawing") updateDrawing(e);
      else if (phase === "moving") updateMoving(e);
      else if (phase === "resizing") updateResizing(e);
    }

    function onMouseUp() {
      if (phase === "drawing") finishDrawing();
      else if (phase === "moving" || phase === "resizing") endInteractiveDrag();
    }

    function onKeyDown(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && phase === "selected") {
        e.preventDefault();
        finish(true);
      }
    }

    confirmBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(true); });
    cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(false); });
    box.addEventListener("mousedown", onBoxMouseDown);
    HANDLES.forEach((pos) => {
      handleEls[pos].addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        startResizing(pos, e);
      });
    });
    overlay.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown, true);
  };
})();
