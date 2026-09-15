// Injected on demand via chrome.scripting.executeScript. Lets the user drag
// a rectangle over the page, then move/resize it before confirming, then
// reports it back to the background script.
// Exposes window.__screenrecStartSelection__(purpose, audio) as the entry point.
//
// This is a content script, not a page script: chrome.scripting.executeScript
// can only inject classic (non-module) scripts, so — unlike background.ts,
// app.ts, etc. — this file has no top-level import/export. Its clampRect is
// therefore a deliberate, small duplicate of src/lib/rect.ts's clampRect
// (which exists so that exact logic can be unit-tested); see ARCHITECTURE.md
// for why this one piece of duplication is kept rather than restructured
// away.

// Every TS-only declaration (types/interfaces) below lives INSIDE this IIFE
// on purpose, even though TypeScript would happily hoist them to the top of
// the file: this file has to compile down to plain JS with no top-level
// import/export (chrome.scripting.executeScript can only inject classic,
// non-module scripts), and it shares a global scope with annotate-overlay.ts
// once both are injected into the same page. Keeping every declaration
// inside the closure — matching the original IIFE-wrapped .js — means
// there is nothing at module/global scope for the two content scripts to
// collide over, without needing `declare global` (which requires a real ES
// module and would reintroduce the top-level `export {}` problem) or a
// dedicated tsconfig knob.
(() => {
  interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  type SelectionPhase = "idle" | "drawing" | "selected" | "moving" | "resizing";
  type HandlePos = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

  interface DragStart {
    mouseX: number;
    mouseY: number;
    rect?: Rect;
  }

  type ScreenrecWindow = Window &
    typeof globalThis & {
      __screenrecSelectionLoaded__?: boolean;
      __screenrecSelectionActive__?: boolean;
      __screenrecStartSelection__?: (purpose: string, audio: boolean) => void;
    };
  const win = window as ScreenrecWindow;

  if (win.__screenrecSelectionLoaded__) return;
  win.__screenrecSelectionLoaded__ = true;

  function detectLang(): "en" | "ru" {
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
      esc: "Esc to cancel · Enter to confirm",
    },
    ru: {
      hintIdle: "Потяните мышью по странице, чтобы выделить область",
      hintDragging: "Отпустите кнопку мыши, затем настройте или подтвердите",
      hintSelected: "Тяните внутри — чтобы двигать, за уголок — чтобы менять размер",
      size: "Размер",
      confirm: "Использовать область",
      cancel: "Отмена",
      esc: "Esc — отмена · Enter — подтвердить",
    },
  }[LANG];

  const MIN_SIZE = 20;
  const HANDLE_SIZE = 12;
  // Order matters for cursor mapping below.
  const HANDLES: HandlePos[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  const CURSORS: Record<HandlePos, string> = {
    nw: "nwse-resize",
    n: "ns-resize",
    ne: "nesw-resize",
    e: "ew-resize",
    se: "nwse-resize",
    s: "ns-resize",
    sw: "nesw-resize",
    w: "ew-resize",
  };

  win.__screenrecStartSelection__ = function (purpose: string, audio: boolean) {
    // Belt-and-suspenders alongside the isSelectingArea guard in
    // background.ts's startAreaSelection() (the primary defense, which
    // stops a repeat click from even getting here). This second guard
    // covers the one gap that check can't: background's session-stored
    // state can be reset (e.g. the service worker being unloaded/restarted
    // mid-selection, a known MV3 quirk this file already works around
    // elsewhere — see stateReady) while this overlay is still physically
    // alive on the page. Without it, a stale/reset background could be
    // talked into re-invoking this entry point for a page that already has
    // a live, undismissed overlay on it, stacking a second one on top.
    // Ignoring the call outright (rather than tearing down the old overlay
    // first) keeps whatever the user already drew intact.
    if (win.__screenrecSelectionActive__) return;
    win.__screenrecSelectionActive__ = true;

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

    // A visible cancel button for before a selection rectangle exists yet:
    // without it, the ONLY way to back out before a rectangle even existed
    // was the Esc key (undiscoverable — nothing on screen said it worked at
    // that point) or closing the tab. Sits right under the hint bubble,
    // visible only during "idle" (before the first drag starts) — once a
    // real selection exists, the per-rectangle Cancel button in `controls`
    // below takes over, so there's never more than one Cancel button on
    // screen at once.
    const idleCancelBtn = document.createElement("button");
    idleCancelBtn.textContent = "✕ " + STR.cancel;
    idleCancelBtn.style.cssText = `
      position: fixed; top: 58px; left: 50%; transform: translateX(-50%);
      background: rgba(255,255,255,0.95); color: #17181c; border: none;
      padding: 7px 14px; border-radius: 8px; font-size: 12.5px; font-weight: 700;
      cursor: pointer; z-index: 2147483647; box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      white-space: nowrap;
    `;
    idleCancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(false);
    });

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
    const handleEls = {} as Record<HandlePos, HTMLDivElement>;
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
    document.documentElement.appendChild(idleCancelBtn);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(sizeTag);
    Object.values(handleEls).forEach((h) => document.documentElement.appendChild(h));
    document.documentElement.appendChild(controls);

    // rect = the current selection, always kept normalized (positive w/h).
    let rect: Rect | null = null;
    let phase: SelectionPhase = "idle";
    let finished = false;
    let dragStart: DragStart | null = null;
    let activeHandle: HandlePos | null = null;

    function cleanup() {
      overlay.remove();
      hint.remove();
      idleCancelBtn.remove();
      box.remove();
      sizeTag.remove();
      controls.remove();
      Object.values(handleEls).forEach((h) => h.remove());
      document.removeEventListener("keydown", onKeyDown, true);
      win.__screenrecSelectionActive__ = false;
    }

    function clampRect(r: Rect): Rect {
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
      const positions: Record<HandlePos, [number, number]> = {
        nw: [rect.x, rect.y],
        n: [cx, rect.y],
        ne: [rect.x + rect.width, rect.y],
        e: [rect.x + rect.width, cy],
        se: [rect.x + rect.width, rect.y + rect.height],
        s: [cx, rect.y + rect.height],
        sw: [rect.x, rect.y + rect.height],
        w: [rect.x, cy],
      };
      HANDLES.forEach((pos) => {
        const h = handleEls[pos];
        const [hx, hy] = positions[pos];
        h.style.display = phase === "idle" || phase === "drawing" ? "none" : "block";
        h.style.left = hx - HANDLE_SIZE / 2 + "px";
        h.style.top = hy - HANDLE_SIZE / 2 + "px";
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
      if (!rect) return;
      controls.style.display = "flex";
      // Measure once controls are visible+laid out.
      const cw = controls.offsetWidth || 180;
      const ch = controls.offsetHeight || 36;
      const gap = 10;
      const margin = 10;

      const fitsBelow = rect.y + rect.height + gap + ch <= window.innerHeight;
      const fitsAbove = rect.y - gap - ch >= 0;

      let left = Math.max(margin, Math.min(rect.x + rect.width - cw, window.innerWidth - cw - margin));
      let top: number;

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

    function finish(confirmed: boolean) {
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
          viewportHeight: window.innerHeight,
        });
      } else {
        chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" });
      }
    }

    // ---------- Drawing a brand-new selection ----------

    function startDrawing(e: MouseEvent) {
      phase = "drawing";
      dragStart = { mouseX: e.clientX, mouseY: e.clientY };
      rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 };
      hint.textContent = STR.hintDragging;
      // Hide the idle Cancel button the instant a drag actually starts —
      // avoids a click landing on it mid-drag racing against the
      // document-level mouseup handler that would also be resolving the
      // drag at that same moment. Esc still works throughout "drawing";
      // once the drag finishes with a real rectangle, the per-rectangle
      // Cancel button in `controls` takes over instead.
      idleCancelBtn.style.display = "none";
      render();
    }

    function updateDrawing(e: MouseEvent) {
      const start = dragStart as DragStart;
      const x = Math.min(start.mouseX, e.clientX);
      const y = Math.min(start.mouseY, e.clientY);
      const width = Math.abs(e.clientX - start.mouseX);
      const height = Math.abs(e.clientY - start.mouseY);
      rect = { x, y, width, height };
      render();
    }

    function finishDrawing() {
      if (rect && rect.width > 4 && rect.height > 4) {
        rect = clampRect(rect);
        phase = "selected";
        hint.textContent = STR.hintSelected;
      } else {
        // Too small a drag to count as a real selection — back to "idle",
        // so bring the idle Cancel button back too.
        rect = null;
        phase = "idle";
        hint.textContent = STR.hintIdle;
        idleCancelBtn.style.display = "block";
      }
      render();
    }

    // ---------- Moving an existing selection ----------

    function startMoving(e: MouseEvent) {
      phase = "moving";
      dragStart = { mouseX: e.clientX, mouseY: e.clientY, rect: { ...(rect as Rect) } };
      render();
    }

    function updateMoving(e: MouseEvent) {
      const start = dragStart as DragStart;
      const dx = e.clientX - start.mouseX;
      const dy = e.clientY - start.mouseY;
      const r = start.rect as Rect;
      rect = clampRect({ x: r.x + dx, y: r.y + dy, width: r.width, height: r.height });
      render();
    }

    // ---------- Resizing via a handle ----------

    function startResizing(handlePos: HandlePos, e: MouseEvent) {
      phase = "resizing";
      activeHandle = handlePos;
      dragStart = { mouseX: e.clientX, mouseY: e.clientY, rect: { ...(rect as Rect) } };
      render();
    }

    function updateResizing(e: MouseEvent) {
      const start = dragStart as DragStart;
      const r = start.rect as Rect;
      const dx = e.clientX - start.mouseX;
      const dy = e.clientY - start.mouseY;
      let { x, y, width, height } = r;
      const handle = activeHandle as HandlePos;

      if (handle.includes("e")) width = r.width + dx;
      if (handle.includes("s")) height = r.height + dy;
      if (handle.includes("w")) {
        x = r.x + dx;
        width = r.width - dx;
      }
      if (handle.includes("n")) {
        y = r.y + dy;
        height = r.height - dy;
      }

      // Keep positive dimensions by flipping the anchor if dragged past it.
      if (width < 0) {
        x += width;
        width = -width;
      }
      if (height < 0) {
        y += height;
        height = -height;
      }

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

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      startDrawing(e);
    }

    function onBoxMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      e.stopPropagation();
      startMoving(e);
    }

    function onMouseMove(e: MouseEvent) {
      if (phase === "drawing") updateDrawing(e);
      else if (phase === "moving") updateMoving(e);
      else if (phase === "resizing") updateResizing(e);
    }

    function onMouseUp() {
      if (phase === "drawing") finishDrawing();
      else if (phase === "moving" || phase === "resizing") endInteractiveDrag();
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && phase === "selected") {
        e.preventDefault();
        finish(true);
      }
    }

    confirmBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(true);
    });
    cancelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      finish(false);
    });
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
