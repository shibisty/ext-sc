// Injected either after a video "area" recording starts (mode: "video",
// live continuous drawing composited into every recorded frame) or right
// after an area screenshot is captured (mode: "screenshot", drawing over a
// frozen still image, with an explicit Save/Cancel step before anything is
// written to disk).
//
// Every stroke is a "layer": it keeps its original geometry untouched and
// is rendered through a simple rect-to-rect transform (baseBBox -> current
// targetBBox), so selecting a layer and dragging its handles can move,
// resize, or non-uniformly deform it at any time without needing to touch
// the original point data.

(() => {
  if (window.__screenrecAnnotationLoaded__) return;
  window.__screenrecAnnotationLoaded__ = true;

  function detectLang() {
    const nav = (navigator.language || "en").toLowerCase();
    return nav.startsWith("ru") ? "ru" : "en";
  }
  const LANG = detectLang();
  const STR = {
    en: {
      pen: "Brush", text: "Text", select: "Select / Move / Resize",
      clear: "Clear all", undo: "Undo",
      hide: "Hide toolbar", show: "Show annotation toolbar",
      size: "Size", opacity: "Opacity", softness: "Softness",
      fontSize: "Font size", fontWeight: "Weight",
      weightNormal: "Normal", weightMedium: "Medium", weightBold: "Bold",
      typeHint: "Type your text…", confirm: "✓ Add", cancel: "✕",
      layers: "Layers", noLayers: "No layers yet",
      layerPen: "Brush stroke", save: "💾 Save", cancelEdit: "✕ Cancel",
      stopRecording: "⏹ Stop recording", stopping: "Stopping…",
      deleteLayer: "Delete layer",
      layerImage: "Image", layerGif: "GIF",
      pasteHint: "Drop an image or paste (Ctrl+V) to add it as a layer",
      imageAddFailed: "Couldn't add that image",
      gifLibrary: "GIF library", gifLibraryEmpty: "No GIFs found in the library folder", gifLibraryLoadFailed: "Couldn't load the GIF library"
    },
    ru: {
      pen: "Кисть", text: "Текст", select: "Выбор / перемещение / размер",
      clear: "Очистить всё", undo: "Отменить",
      hide: "Скрыть панель", show: "Показать панель разметки",
      size: "Размер", opacity: "Прозрачность", softness: "Размытие",
      fontSize: "Размер шрифта", fontWeight: "Толщина",
      weightNormal: "Обычный", weightMedium: "Средний", weightBold: "Жирный",
      typeHint: "Введите текст…", confirm: "✓ Добавить", cancel: "✕",
      layers: "Слои", noLayers: "Пока нет слоёв",
      layerPen: "Мазок кисти", save: "💾 Сохранить", cancelEdit: "✕ Отмена",
      stopRecording: "⏹ Остановить запись", stopping: "Останавливаю…",
      deleteLayer: "Удалить слой",
      layerImage: "Изображение", layerGif: "GIF",
      pasteHint: "Перетащите изображение или вставьте (Ctrl+V), чтобы добавить как слой",
      imageAddFailed: "Не удалось добавить изображение",
      gifLibrary: "Библиотека GIF", gifLibraryEmpty: "В папке библиотеки нет файлов", gifLibraryLoadFailed: "Не удалось загрузить библиотеку GIF"
    }
  }[LANG];

  const PALETTE = ["#e04343", "#ffb300", "#2ecc71", "#2f80ed", "#111318", "#ffffff"];
  const FONT_STACK = `"Google Sans", "Product Sans", Roboto, -apple-system, "Segoe UI", sans-serif`;
  const TOOLBAR_WIDTH = 220;
  const HANDLE_SIZE = 10;
  const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  window.__screenrecStartAnnotation__ = async function (rect, dpr, opts) {
    opts = opts || { mode: "video" };
    const isScreenshotMode = opts.mode === "screenshot";

    const TOOL_SETTINGS_KEY = "annotationToolSettings";
    const saved = await new Promise((resolve) => {
      try {
        chrome.storage.local.get([TOOL_SETTINGS_KEY], (result) => resolve((result && result[TOOL_SETTINGS_KEY]) || {}));
      } catch (e) { resolve({}); }
    });

    function persistToolSettings() {
      chrome.storage.local.set({
        [TOOL_SETTINGS_KEY]: { color, brushSize, brushOpacity, brushSoftness, fontSize, fontWeight }
      });
    }

    let tool = "pen"; // "pen" | "text" | "select"
    let color = saved.color || PALETTE[0];
    let brushSize = saved.brushSize ?? 6;
    let brushOpacity = saved.brushOpacity ?? 1;
    let brushSoftness = saved.brushSoftness ?? 0;
    let fontSize = saved.fontSize ?? 24;
    let fontWeight = saved.fontWeight ?? 600;
    let nextLayerId = 1;
    let strokes = []; // committed layers, see shape notes below
    let currentStroke = null; // in-progress pen stroke (fast incremental path)
    let lastMidpoint = null;
    let selectedIds = new Set();
    let lastClickedIndex = null;
    let toolbarVisible = true;
    let activeTextEditor = null;
    let backgroundImg = null;
    let backgroundReady = false;

    // ---------- Canvas ----------

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    canvas.style.cssText = `
      position: fixed; left: ${rect.x}px; top: ${rect.y}px;
      width: ${rect.width}px; height: ${rect.height}px;
      z-index: 2147483646; cursor: crosshair;
      outline: 2px dashed rgba(224,67,67,0.6); outline-offset: -2px;
    `;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    document.documentElement.appendChild(canvas);

    if (isScreenshotMode && opts.imageDataUrl) {
      backgroundImg = new Image();
      backgroundImg.onload = () => { backgroundReady = true; redraw(); };
      backgroundImg.src = opts.imageDataUrl;
    }

    // ---------- Selection handle elements (shown only in "select" tool) ----------

    const selectionBox = document.createElement("div");
    selectionBox.style.cssText = `
      position: fixed; border: 2px solid #7c5cff; display: none;
      z-index: 2147483646; pointer-events: none;
    `;
    document.documentElement.appendChild(selectionBox);
    const handleEls = {};
    HANDLES.forEach((pos) => {
      const h = document.createElement("div");
      const cursors = { nw: "nwse-resize", n: "ns-resize", ne: "nesw-resize", e: "ew-resize", se: "nwse-resize", s: "ns-resize", sw: "nesw-resize", w: "ew-resize" };
      h.style.cssText = `
        position: fixed; width: ${HANDLE_SIZE}px; height: ${HANDLE_SIZE}px;
        background: #fff; border: 2px solid #7c5cff; border-radius: 50%;
        z-index: 2147483647; display: none; cursor: ${cursors[pos]};
      `;
      document.documentElement.appendChild(h);
      handleEls[pos] = h;
    });

    const rotateLine = document.createElement("div");
    rotateLine.style.cssText = `
      position: fixed; height: 2px; background: #7c5cff; z-index: 2147483646;
      display: none; pointer-events: none; transform-origin: 0 50%;
    `;
    document.documentElement.appendChild(rotateLine);
    const rotateHandle = document.createElement("div");
    rotateHandle.style.cssText = `
      position: fixed; width: ${HANDLE_SIZE + 2}px; height: ${HANDLE_SIZE + 2}px;
      background: #fff; border: 2px solid #7c5cff; border-radius: 50%;
      z-index: 2147483647; display: none; cursor: grab;
    `;
    document.documentElement.appendChild(rotateHandle);

    // ---------- Toolbar shell ----------

    const toolbar = document.createElement("div");
    toolbar.style.cssText = `
      position: fixed; width: ${TOOLBAR_WIDTH}px; z-index: 2147483647;
      display: flex; flex-direction: column; gap: 10px; padding: 12px;
      background: rgba(28,28,34,0.95); border-radius: 14px;
      box-shadow: 0 6px 24px rgba(0,0,0,0.4); color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-sizing: border-box; overflow-y: auto;
    `;
    document.documentElement.appendChild(toolbar);

    function positionToolbar() {
      let left = rect.x + rect.width + 10;
      if (left + TOOLBAR_WIDTH > window.innerWidth) {
        left = Math.max(4, rect.x - TOOLBAR_WIDTH - 10);
      }
      toolbar.style.left = Math.round(left) + "px";

      const margin = 8;
      const naturalTop = Math.max(margin, Math.min(rect.y, window.innerHeight - 120));
      // scrollHeight reports the panel's full content height regardless of
      // any max-height clamp already applied — use it to figure out
      // whether everything (including Save/Cancel, further down) actually
      // fits below naturalTop; if not, shift the panel upward first rather
      // than relying purely on an internal scrollbar the person might not
      // notice.
      const contentHeight = toolbar.scrollHeight || 0;
      let top = naturalTop;
      if (top + contentHeight + margin > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - contentHeight - margin);
      }
      toolbar.style.top = Math.round(top) + "px";
      toolbar.style.maxHeight = Math.max(120, window.innerHeight - top - margin) + "px";
    }
    positionToolbar();

    function toolBtn(label, title) {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.style.cssText = `
        width: 32px; height: 32px; border-radius: 8px; border: none;
        background: rgba(255,255,255,0.08); color: #fff; font-size: 14px;
        cursor: pointer; display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      `;
      return b;
    }

    const toolRow = document.createElement("div");
    toolRow.style.cssText = "display:flex; gap:5px; align-items:center; flex-wrap: wrap;";
    const penBtn = toolBtn("🖌", STR.pen);
    const textBtn = toolBtn("T", STR.text);
    const selectBtn = toolBtn("⇱", STR.select);
    const libraryBtn = toolBtn("📚", STR.gifLibrary);
    const undoBtn = toolBtn("↩", STR.undo);
    const clearBtn = toolBtn("🗑", STR.clear);
    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.value = color;
    colorInput.style.cssText = "width:32px; height:32px; border:none; border-radius:8px; padding:0; background:none; cursor:pointer; flex-shrink:0;";
    const hideBtn = toolBtn("×", STR.hide);
    hideBtn.style.background = "rgba(224,67,67,0.25)";
    hideBtn.style.marginLeft = "auto";
    [penBtn, textBtn, selectBtn, libraryBtn, colorInput, undoBtn, clearBtn, hideBtn].forEach((el) => toolRow.appendChild(el));
    toolbar.appendChild(toolRow);

    function sliderRow(labelText, min, max, step, value) {
      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex; flex-direction:column; gap:2px;";
      const label = document.createElement("div");
      label.textContent = labelText;
      label.style.cssText = "font-size:11px; opacity:0.75;";
      const input = document.createElement("input");
      input.type = "range";
      input.min = min; input.max = max; input.step = step; input.value = value;
      input.style.cssText = "width:100%; accent-color:#7c5cff;";
      wrap.appendChild(label);
      wrap.appendChild(input);
      return { wrap, input };
    }

    const brushPanel = document.createElement("div");
    brushPanel.style.cssText = "display:flex; flex-direction:column; gap:8px;";
    const sizeRow = sliderRow(STR.size, 1, 40, 1, brushSize);
    const opacityRow = sliderRow(STR.opacity, 0.1, 1, 0.05, brushOpacity);
    const softRow = sliderRow(STR.softness, 0, 12, 0.5, brushSoftness);
    [sizeRow, opacityRow, softRow].forEach((r) => brushPanel.appendChild(r.wrap));
    toolbar.appendChild(brushPanel);
    sizeRow.input.addEventListener("input", (e) => { brushSize = parseFloat(e.target.value); });
    opacityRow.input.addEventListener("input", (e) => { brushOpacity = parseFloat(e.target.value); });
    softRow.input.addEventListener("input", (e) => { brushSoftness = parseFloat(e.target.value); });
    [sizeRow.input, opacityRow.input, softRow.input].forEach((el) => el.addEventListener("change", persistToolSettings));

    const textPanel = document.createElement("div");
    textPanel.style.cssText = "display:none; flex-direction:column; gap:8px;";
    const fontSizeRow = sliderRow(STR.fontSize, 12, 72, 1, fontSize);
    const weightWrap = document.createElement("div");
    weightWrap.style.cssText = "display:flex; flex-direction:column; gap:2px;";
    const weightLabel = document.createElement("div");
    weightLabel.textContent = STR.fontWeight;
    weightLabel.style.cssText = "font-size:11px; opacity:0.75;";
    const weightSelect = document.createElement("select");
    weightSelect.style.cssText = "width:100%; border-radius:6px; border:none; padding:4px; font-size:12px;";
    [[400, STR.weightNormal], [600, STR.weightMedium], [800, STR.weightBold]].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = label;
      if (val === fontWeight) opt.selected = true;
      weightSelect.appendChild(opt);
    });
    weightWrap.appendChild(weightLabel);
    weightWrap.appendChild(weightSelect);
    textPanel.appendChild(fontSizeRow.wrap);
    textPanel.appendChild(weightWrap);
    toolbar.appendChild(textPanel);
    fontSizeRow.input.addEventListener("input", (e) => { fontSize = parseFloat(e.target.value); });
    fontSizeRow.input.addEventListener("change", persistToolSettings);
    weightSelect.addEventListener("change", (e) => { fontWeight = parseInt(e.target.value, 10); persistToolSettings(); });

    // Layers panel
    const layersPanel = document.createElement("div");
    layersPanel.style.cssText = "display:flex; flex-direction:column; gap:4px;";
    const layersLabel = document.createElement("div");
    layersLabel.textContent = STR.layers;
    layersLabel.style.cssText = "font-size:11px; opacity:0.75;";
    const layersList = document.createElement("div");
    layersList.style.cssText = "display:flex; flex-direction:column; gap:3px; max-height:140px; overflow-y:auto;";
    layersPanel.appendChild(layersLabel);
    layersPanel.appendChild(layersList);
    toolbar.appendChild(layersPanel);

    const pasteHint = document.createElement("div");
    pasteHint.textContent = STR.pasteHint;
    pasteHint.style.cssText = "font-size:10.5px; opacity:0.55; line-height:1.4;";
    toolbar.appendChild(pasteHint);

    // GIF library panel (hidden until the 📚 button is clicked)
    const libraryPanel = document.createElement("div");
    libraryPanel.style.cssText = "display:none; flex-direction:column; gap:6px;";
    const libraryLabel = document.createElement("div");
    libraryLabel.textContent = STR.gifLibrary;
    libraryLabel.style.cssText = "font-size:11px; opacity:0.75;";
    const libraryGrid = document.createElement("div");
    libraryGrid.style.cssText = "display:grid; grid-template-columns: repeat(3, 1fr); gap:6px; max-height:220px; overflow-y:auto;";
    libraryPanel.appendChild(libraryLabel);
    libraryPanel.appendChild(libraryGrid);
    toolbar.appendChild(libraryPanel);
    let libraryLoaded = false;
    let libraryOpen = false;

    // Screenshot mode: Save / Cancel. Video mode: Stop recording — both let
    // the person finish up without leaving the page to reopen the popup.
    let saveBtn = null, cancelEditBtn = null, stopRecordingBtn = null;
    if (isScreenshotMode) {
      const saveRow = document.createElement("div");
      saveRow.style.cssText = "display:flex; gap:6px;";
      cancelEditBtn = document.createElement("button");
      cancelEditBtn.textContent = STR.cancelEdit;
      cancelEditBtn.style.cssText = "flex:1; padding:8px; border:none; border-radius:8px; background:rgba(255,255,255,0.12); color:#fff; font-weight:700; cursor:pointer; font-size:12.5px;";
      saveBtn = document.createElement("button");
      saveBtn.textContent = STR.save;
      saveBtn.style.cssText = "flex:1; padding:8px; border:none; border-radius:8px; background:#7c5cff; color:#fff; font-weight:700; cursor:pointer; font-size:12.5px;";
      saveRow.appendChild(cancelEditBtn);
      saveRow.appendChild(saveBtn);
      toolbar.appendChild(saveRow);
    } else {
      stopRecordingBtn = document.createElement("button");
      stopRecordingBtn.textContent = STR.stopRecording;
      stopRecordingBtn.style.cssText = "padding:9px; border:none; border-radius:8px; background:#e04343; color:#fff; font-weight:700; cursor:pointer; font-size:12.5px;";
      stopRecordingBtn.addEventListener("click", () => {
        stopRecordingBtn.disabled = true;
        stopRecordingBtn.textContent = STR.stopping;
        chrome.runtime.sendMessage({ target: "background", type: "STOP_RECORDING_REQUEST" }).catch(() => {});
      });
      toolbar.appendChild(stopRecordingBtn);
    }

    function setActiveTool(t) {
      tool = t;
      penBtn.style.outline = t === "pen" ? "2px solid #7c5cff" : "none";
      textBtn.style.outline = t === "text" ? "2px solid #7c5cff" : "none";
      selectBtn.style.outline = t === "select" ? "2px solid #7c5cff" : "none";
      canvas.style.cursor = t === "text" ? "text" : t === "select" ? "default" : "crosshair";
      brushPanel.style.display = t === "pen" ? "flex" : "none";
      textPanel.style.display = t === "text" ? "flex" : "none";
      if (t !== "select") { selectedIds = new Set(); updateSelectionUI(); }
      positionToolbar();
    }
    setActiveTool("pen");

    // ---------- Geometry helpers ----------

    function measureTextBBox(stroke) {
      ctx.save();
      ctx.font = `${stroke.fontWeight} ${stroke.fontSize}px ${FONT_STACK}`;
      const lines = String(stroke.text).split("\n");
      let maxW = 0;
      for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
      ctx.restore();
      return { x: stroke.x, y: stroke.y, width: Math.max(20, maxW), height: stroke.fontSize * 1.2 * lines.length };
    }

    function computeBaseBBox(stroke) {
      if (stroke.tool === "pen") {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of stroke.points) {
          minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        }
        const pad = stroke.width / 2 + (stroke.blur || 0) + 2;
        return { x: minX - pad, y: minY - pad, width: (maxX - minX) + pad * 2, height: (maxY - minY) + pad * 2 };
      }
      return measureTextBBox(stroke);
    }

    // ---------- Rendering ----------

    function drawPenRaw(stroke) {
      const pts = stroke.points;
      if (pts.length === 0) return;
      ctx.save();
      ctx.globalAlpha = stroke.opacity;
      ctx.filter = stroke.blur > 0 ? `blur(${stroke.blur}px)` : "none";
      ctx.strokeStyle = stroke.color;
      ctx.fillStyle = stroke.color;
      ctx.lineWidth = stroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length - 1; i++) {
          const midX = (pts[i].x + pts[i + 1].x) / 2;
          const midY = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawTextRaw(stroke) {
      ctx.save();
      ctx.fillStyle = stroke.color;
      ctx.font = `${stroke.fontWeight} ${stroke.fontSize}px ${FONT_STACK}`;
      ctx.textBaseline = "top";
      const lines = String(stroke.text).split("\n");
      lines.forEach((line, i) => ctx.fillText(line, stroke.x, stroke.y + i * stroke.fontSize * 1.2));
      ctx.restore();
    }

    function drawImageRaw(stroke) {
      ctx.drawImage(stroke.bitmap, 0, 0, stroke.naturalWidth, stroke.naturalHeight);
    }

    // Renders a committed layer through its base->target rect transform, so
    // moving/resizing/deforming a layer never touches its original geometry.
    function renderLayer(stroke) {
      const base = stroke.baseBBox;
      const target = stroke.targetBBox;
      const sx = base.width > 0 ? target.width / base.width : 1;
      const sy = base.height > 0 ? target.height / base.height : 1;
      const cx = target.x + target.width / 2;
      const cy = target.y + target.height / 2;
      ctx.save();
      if (stroke.rotation) {
        ctx.translate(cx, cy);
        ctx.rotate(stroke.rotation);
        ctx.translate(-cx, -cy);
      }
      ctx.translate(target.x, target.y);
      ctx.scale(sx, sy);
      ctx.translate(-base.x, -base.y);
      if (stroke.tool === "pen") drawPenRaw(stroke);
      else if (stroke.tool === "image") drawImageRaw(stroke);
      else drawTextRaw(stroke);
      ctx.restore();
    }

    // Painting the canvas and refreshing the surrounding UI chrome (layers
    // panel DOM, selection handle positions) are kept separate on purpose:
    // the GIF animation ticker needs to repaint pixels many times per
    // second, but rebuilding the layers panel's DOM that often was
    // literally yanking rows out from under the user's cursor mid-click —
    // that's what was actually breaking layer selection, not anything
    // about the click/modifier-key handling itself.
    function paintCanvas() {
      ctx.clearRect(0, 0, rect.width, rect.height);
      if (isScreenshotMode && backgroundReady) {
        ctx.drawImage(backgroundImg, 0, 0, rect.width, rect.height);
      }
      for (const s of strokes) renderLayer(s);
      // The stroke currently being drawn isn't committed into `strokes`
      // until the mouse is released — anything that calls paintCanvas() in
      // the meantime (most notably the GIF animation ticker, firing every
      // ~40ms) would otherwise wipe it off the canvas mid-draw, making the
      // line only "appear" once you let go.
      if (currentStroke) drawPenRaw(currentStroke);
    }

    function redraw() {
      paintCanvas();
      updateSelectionUI();
      positionToolbar();
    }

    // Snapshot export is intentionally NOT called synchronously from the
    // pointermove handler at all — it's marked "dirty" instead, and a
    // separate requestAnimationFrame loop below is the only thing that ever
    // actually calls canvas.toBlob(). This guarantees the pointermove
    // handler that draws the live brush stroke does nothing but draw —
    // no export/message work of any kind can ever delay or compete with
    // painting the stroke itself.
    let snapshotDirty = false;
    let snapshotLoopStopped = false;
    function requestSnapshot() { snapshotDirty = true; }

    function sendSnapshotNow() {
      if (isScreenshotMode) return; // screenshot mode only exports on explicit Save
      canvas.toBlob((blob) => {
        if (!blob) return;
        const reader = new FileReader();
        reader.onload = () => {
          chrome.runtime.sendMessage({ target: "offscreen", type: "ANNOTATION_FRAME", dataUrl: reader.result }).catch(() => {});
        };
        reader.readAsDataURL(blob);
      }, "image/png");
    }

    function sendSnapshot(force) {
      if (force) sendSnapshotNow();
      else requestSnapshot();
    }

    // The canvas is `position: fixed` at a spot chosen once when the
    // overlay was created and never moves again — its bounding rect can't
    // change from scrolling (fixed elements are scroll-independent) and
    // only needs to be recomputed on an actual window resize. Calling
    // getBoundingClientRect() on every single pointermove otherwise forces
    // a synchronous layout reflow of the whole page on every mouse
    // movement, which on a sufficiently busy/complex page can by itself be
    // enough to noticeably delay the browser's paint of the live stroke.
    let cachedCanvasRect = canvas.getBoundingClientRect();
    function refreshCachedCanvasRect() { cachedCanvasRect = canvas.getBoundingClientRect(); }
    window.addEventListener("resize", refreshCachedCanvasRect);

    function toLocal(e) {
      return { x: e.clientX - cachedCanvasRect.left, y: e.clientY - cachedCanvasRect.top };
    }

    // ---------- Image / GIF layers (drag-drop or paste) ----------

    // Adds a new image (or animated GIF) as a selectable/transformable
    // layer, sized to fit within the canvas and centered on the drop point
    // (or the canvas center for a paste, which has no drop position).
    function addImageLayer(bitmap, naturalWidth, naturalHeight, dropPos, extra) {
      const maxW = rect.width * 0.6, maxH = rect.height * 0.6;
      const fitScale = Math.min(1, maxW / naturalWidth, maxH / naturalHeight);
      const dispW = Math.max(8, naturalWidth * fitScale);
      const dispH = Math.max(8, naturalHeight * fitScale);
      const cx = dropPos ? dropPos.x : rect.width / 2;
      const cy = dropPos ? dropPos.y : rect.height / 2;
      const stroke = {
        id: nextLayerId++, tool: "image", rotation: 0,
        bitmap, naturalWidth, naturalHeight,
        baseBBox: { x: 0, y: 0, width: naturalWidth, height: naturalHeight },
        targetBBox: { x: cx - dispW / 2, y: cy - dispH / 2, width: dispW, height: dispH },
        isAnimated: false,
        ...extra
      };
      strokes.push(stroke);
      setActiveTool("select");
      selectedIds = new Set([stroke.id]);
      redraw();
      sendSnapshot(true);
      ensureAnimationLoop();
      return stroke;
    }

    // Decodes an animated image (GIF, animated WebP/PNG) into individual
    // frame bitmaps with per-frame durations, using Chrome's ImageDecoder
    // (WebCodecs) — returns null for static images or if decoding isn't
    // supported/possible, in which case the caller falls back to a plain
    // single-frame createImageBitmap.
    async function decodeAnimatedFrames(blob) {
      if (typeof ImageDecoder === "undefined") return null;
      try {
        const buf = await blob.arrayBuffer();
        const decoder = new ImageDecoder({ data: buf, type: blob.type });
        await decoder.tracks.ready;
        const track = decoder.tracks.selectedTrack;
        if (!track || track.frameCount <= 1) { decoder.close && decoder.close(); return null; }
        const frameCount = Math.min(track.frameCount, 120); // sanity cap
        const frames = [];
        for (let i = 0; i < frameCount; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          const bitmap = await createImageBitmap(image);
          // VideoFrame.duration is in microseconds; fall back to 100ms.
          const durationMs = image.duration ? image.duration / 1000 : 100;
          image.close && image.close();
          frames.push({ bitmap, duration: Math.max(20, durationMs) });
        }
        decoder.close && decoder.close();
        return frames;
      } catch (e) {
        console.error("ScreenRec: animated image decode failed", e);
        return null;
      }
    }

    async function handleIncomingImageBlob(blob, dropPos) {
      try {
        let frames = null;
        if (blob.type === "image/gif" || blob.type === "image/webp" || blob.type === "image/png") {
          frames = await decodeAnimatedFrames(blob);
        }
        if (frames && frames.length > 1) {
          const first = frames[0].bitmap;
          addImageLayer(first, first.width, first.height, dropPos, {
            isAnimated: true, frames, frameIndex: 0, frameElapsed: 0
          });
        } else {
          const bitmap = await createImageBitmap(blob);
          addImageLayer(bitmap, bitmap.width, bitmap.height, dropPos, { isAnimated: false });
        }
      } catch (e) {
        console.error("ScreenRec: failed to add image layer", e);
      }
    }

    // ---------- Bundled GIF library (gif-library/) ----------
    // Content scripts can't list a directory's contents, so gif-library/
    // ships its own manifest.json naming the available files. Usage counts
    // are tracked in chrome.storage.local so the most-used items float to
    // the top of the grid.

    const GIF_USAGE_KEY = "gifLibraryUsage";

    async function getGifUsage() {
      return new Promise((resolve) => {
        chrome.storage.local.get([GIF_USAGE_KEY], (r) => resolve((r && r[GIF_USAGE_KEY]) || {}));
      });
    }

    async function bumpGifUsage(filename) {
      const usage = await getGifUsage();
      usage[filename] = (usage[filename] || 0) + 1;
      chrome.storage.local.set({ [GIF_USAGE_KEY]: usage });
    }

    async function loadGifLibrary() {
      libraryGrid.innerHTML = "";
      try {
        const manifestUrl = chrome.runtime.getURL("gif-library/manifest.json");
        const manifest = await fetch(manifestUrl).then((r) => r.json());
        const files = Array.isArray(manifest.files) ? manifest.files : [];
        if (files.length === 0) {
          const empty = document.createElement("div");
          empty.textContent = STR.gifLibraryEmpty;
          empty.style.cssText = "font-size:11px; opacity:0.5; grid-column: 1 / -1;";
          libraryGrid.appendChild(empty);
          return;
        }
        const usage = await getGifUsage();
        // Most-used first; ties keep the manifest's original order.
        const ordered = files
          .map((name, idx) => ({ name, idx, count: usage[name] || 0 }))
          .sort((a, b) => b.count - a.count || a.idx - b.idx);

        for (const item of ordered) {
          const thumb = document.createElement("button");
          thumb.title = item.name;
          thumb.style.cssText = `
            width: 100%; aspect-ratio: 1; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15);
            background: rgba(255,255,255,0.06) center/cover no-repeat; cursor: pointer; padding: 0;
            overflow: hidden; position: relative;
          `;
          const img = document.createElement("img");
          img.src = chrome.runtime.getURL(`gif-library/${item.name}`);
          img.style.cssText = "width:100%; height:100%; object-fit:cover; display:block;";
          img.loading = "lazy";
          thumb.appendChild(img);
          thumb.addEventListener("click", () => addFromGifLibrary(item.name));
          libraryGrid.appendChild(thumb);
        }
      } catch (e) {
        console.error("ScreenRec: failed to load GIF library", e);
        const err = document.createElement("div");
        err.textContent = STR.gifLibraryLoadFailed;
        err.style.cssText = "font-size:11px; opacity:0.5; grid-column: 1 / -1;";
        libraryGrid.appendChild(err);
      }
    }

    async function addFromGifLibrary(filename) {
      try {
        const url = chrome.runtime.getURL(`gif-library/${filename}`);
        const blob = await fetch(url).then((r) => r.blob());
        await handleIncomingImageBlob(blob, null);
        await bumpGifUsage(filename);
        // Refresh order so frequently-used items keep floating to the top
        // the next time the panel is opened.
        libraryLoaded = false;
      } catch (e) {
        console.error("ScreenRec: failed to insert library GIF", e);
      }
    }

    libraryBtn.addEventListener("click", async () => {
      libraryOpen = !libraryOpen;
      libraryPanel.style.display = libraryOpen ? "flex" : "none";
      libraryBtn.style.outline = libraryOpen ? "2px solid #7c5cff" : "none";
      if (libraryOpen && !libraryLoaded) {
        libraryLoaded = true;
        await loadGifLibrary();
      }
      positionToolbar();
    });

    // Advancing animated-GIF frames and exporting a snapshot both happen
    // inside the SAME requestAnimationFrame tick — previously the GIF
    // ticker ran on its own independent 40ms setInterval while snapshot
    // export ran on a separate rAF loop, so a frame could change at one
    // moment and not get exported (or get exported twice) until some
    // unrelated later tick, which is what caused visible timing artifacts
    // in the recorded video. A single shared clock means "the frame
    // changed" and "here's the updated pixels" are always the same event.
    let lastAnimTick = null;

    function tickAnimatedLayers(now) {
      const hasAnimated = strokes.some((s) => s.tool === "image" && s.isAnimated);
      if (!hasAnimated) { lastAnimTick = null; return false; }
      if (lastAnimTick == null) { lastAnimTick = now; return false; }
      const dt = now - lastAnimTick;
      lastAnimTick = now;
      let changed = false;
      for (const s of strokes) {
        if (s.tool !== "image" || !s.isAnimated || !s.frames || s.frames.length < 2) continue;
        s.frameElapsed += dt;
        const frame = s.frames[s.frameIndex];
        if (s.frameElapsed >= frame.duration) {
          s.frameElapsed -= frame.duration;
          s.frameIndex = (s.frameIndex + 1) % s.frames.length;
          s.bitmap = s.frames[s.frameIndex].bitmap;
          changed = true;
        }
      }
      return changed;
    }

    (function mainLoop(now) {
      if (snapshotLoopStopped) return;
      if (tickAnimatedLayers(now || performance.now())) {
        paintCanvas();
        snapshotDirty = true;
      }
      if (snapshotDirty) {
        snapshotDirty = false;
        sendSnapshotNow();
      }
      requestAnimationFrame(mainLoop);
    })();

    // Kept as a no-op shim — earlier code called this after adding/removing
    // an image layer to start/stop the old per-timer animation loop. The
    // unified mainLoop above already checks for animated layers on every
    // tick by itself, so nothing needs to be explicitly started or stopped
    // anymore; the calls are left in place rather than ripped out
    // everywhere they're used.
    function ensureAnimationLoop() {}

    function closeImageStroke(s) {
      if (s.tool !== "image") return;
      try { s.bitmap && s.bitmap.close && s.bitmap.close(); } catch (e) { /* ignore */ }
      if (s.frames) {
        for (const f of s.frames) { try { f.bitmap.close && f.bitmap.close(); } catch (e) { /* ignore */ } }
      }
    }

    // ---------- Drag & drop / paste wiring ----------

    canvas.addEventListener("dragover", (e) => { e.preventDefault(); });
    canvas.addEventListener("drop", (e) => {
      e.preventDefault();
      const pos = toLocal(e);
      const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file && file.type.startsWith("image/")) {
        handleIncomingImageBlob(file, pos);
        return;
      }
      // Dragging an image FROM another tab/page usually hands over a URL
      // rather than a File — best-effort fallback, silently ignored if the
      // source doesn't allow it (e.g. cross-origin without CORS).
      const url = e.dataTransfer && (e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("URL"));
      if (url) {
        fetch(url).then((r) => r.blob()).then((b) => {
          if (b.type.startsWith("image/")) handleIncomingImageBlob(b, pos);
        }).catch(() => {});
      }
    });

    function onPasteEvent(e) {
      if (!e.clipboardData) return;
      const items = Array.from(e.clipboardData.items || []);
      const imageItem = items.find((it) => it.type && it.type.startsWith("image/"));
      if (!imageItem) return; // let normal text paste (e.g. into the text editor) proceed
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (blob) handleIncomingImageBlob(blob, null);
    }
    document.addEventListener("paste", onPasteEvent);

    // ---------- Layers panel ----------

    function layerLabel(s) {
      if (s.tool === "text") return `T: ${String(s.text).slice(0, 16)}${s.text.length > 16 ? "…" : ""}`;
      if (s.tool === "image") return s.isAnimated ? STR.layerGif : STR.layerImage;
      return STR.layerPen;
    }

    function selectLayerAt(index, e) {
      const s = strokes[index];
      if (e && e.shiftKey && lastClickedIndex != null) {
        const lo = Math.min(lastClickedIndex, index), hi = Math.max(lastClickedIndex, index);
        selectedIds = new Set(strokes.slice(lo, hi + 1).map((x) => x.id));
      } else if (e && (e.ctrlKey || e.metaKey)) {
        if (selectedIds.has(s.id)) selectedIds.delete(s.id); else selectedIds.add(s.id);
        lastClickedIndex = index;
      } else {
        selectedIds = new Set([s.id]);
        lastClickedIndex = index;
      }
    }

    function refreshLayersList() {
      layersList.innerHTML = "";
      layersList.style.userSelect = "none";
      if (strokes.length === 0) {
        const empty = document.createElement("div");
        empty.textContent = STR.noLayers;
        empty.style.cssText = "font-size:11.5px; opacity:0.5; padding:4px 0;";
        layersList.appendChild(empty);
        return;
      }
      strokes.forEach((s, index) => {
        const row = document.createElement("div");
        row.style.cssText = `
          display:flex; align-items:center; gap:6px; padding:5px 7px; border-radius:7px;
          background: ${selectedIds.has(s.id) ? "rgba(124,92,255,0.35)" : "rgba(255,255,255,0.06)"};
          cursor:pointer; font-size:11.5px; user-select:none;
        `;
        const icon = document.createElement("span");
        icon.textContent = s.tool === "text" ? "T" : s.tool === "image" ? (s.isAnimated ? "🎞" : "🖼") : "🖌";
        icon.style.cssText = "flex-shrink:0; width:16px; text-align:center; opacity:0.85;";
        const label = document.createElement("span");
        label.textContent = layerLabel(s);
        label.style.cssText = "flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";
        const delBtn = document.createElement("button");
        delBtn.textContent = "🗑";
        delBtn.title = STR.deleteLayer;
        delBtn.style.cssText = "border:none; background:none; color:#fff; opacity:0.6; cursor:pointer; font-size:11px; flex-shrink:0;";
        row.appendChild(icon);
        row.appendChild(label);
        row.appendChild(delBtn);
        // mousedown (not click) + preventDefault stops the browser from
        // treating a Ctrl/Shift-click as a native text-selection gesture,
        // which on some platforms can swallow the click before our own
        // handler's modifier-key logic ever sees it.
        row.addEventListener("mousedown", (e) => { e.preventDefault(); });
        row.addEventListener("click", (e) => {
          e.preventDefault();
          if (tool !== "select") setActiveTool("select");
          selectLayerAt(index, e);
          redraw();
        });
        delBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          closeImageStroke(s);
          strokes = strokes.filter((x) => x.id !== s.id);
          selectedIds.delete(s.id);
          redraw();
          sendSnapshot(true);
          ensureAnimationLoop();
        });
        layersList.appendChild(row);
      });
    }

    // Delete/Backspace removes every currently-selected layer at once —
    // covers both "delete this one GIF/layer" and "select several, delete
    // them together". Ignored while the text editor has focus, so Backspace
    // still works normally for editing text.
    function onGlobalKeyDown(e) {
      if (activeTextEditor) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedIds.size > 0) {
        e.preventDefault();
        const toRemove = selectedIds;
        strokes.forEach((s) => { if (toRemove.has(s.id)) closeImageStroke(s); });
        strokes = strokes.filter((s) => !toRemove.has(s.id));
        selectedIds = new Set();
        redraw();
        sendSnapshot(true);
        ensureAnimationLoop();
      }
    }
    document.addEventListener("keydown", onGlobalKeyDown);

    // ---------- Selection handles UI ----------

    function getSelectedStrokes() {
      return strokes.filter((s) => selectedIds.has(s.id));
    }

    // Union bounding box of every selected layer — used to show one combined
    // handle set and to drive group move/resize.
    function getGroupBBox(selected) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const s of selected) {
        const b = s.targetBBox;
        minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
      }
      return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    }

    function updateSelectionUI() {
      refreshLayersList();
      positionSelectionHandles();
    }

    function positionSelectionHandles() {
      const selected = tool === "select" ? getSelectedStrokes() : [];
      if (selected.length === 0) {
        selectionBox.style.display = "none";
        HANDLES.forEach((p) => { handleEls[p].style.display = "none"; });
        rotateHandle.style.display = "none";
        rotateLine.style.display = "none";
        return;
      }
      const isSingle = selected.length === 1;
      const b = isSingle ? selected[0].targetBBox : getGroupBBox(selected);
      const rotation = isSingle ? (selected[0].rotation || 0) : 0;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;

      // Rotate a local (bbox-relative) point around the bbox center, then
      // convert to page coordinates.
      function toPageRotated(lx, ly) {
        const dx = lx - cx, dy = ly - cy;
        const cosA = Math.cos(rotation), sinA = Math.sin(rotation);
        return { x: rect.x + cx + dx * cosA - dy * sinA, y: rect.y + cy + dx * sinA + dy * cosA };
      }

      selectionBox.style.display = "block";
      selectionBox.style.left = (rect.x + b.x) + "px";
      selectionBox.style.top = (rect.y + b.y) + "px";
      selectionBox.style.width = b.width + "px";
      selectionBox.style.height = b.height + "px";
      selectionBox.style.transform = rotation ? `rotate(${rotation}rad)` : "none";
      selectionBox.style.transformOrigin = "center center";

      const positions = {
        nw: [b.x, b.y], n: [cx, b.y], ne: [b.x + b.width, b.y],
        e: [b.x + b.width, cy], se: [b.x + b.width, b.y + b.height],
        s: [cx, b.y + b.height], sw: [b.x, b.y + b.height], w: [b.x, cy]
      };
      HANDLES.forEach((pos) => {
        const h = handleEls[pos];
        const [hx, hy] = positions[pos];
        const p = toPageRotated(hx, hy);
        h.style.display = "block";
        h.style.left = (p.x - HANDLE_SIZE / 2) + "px";
        h.style.top = (p.y - HANDLE_SIZE / 2) + "px";
      });

      // Rotation is only meaningful for a single selected layer — a group's
      // combined box doesn't have one consistent orientation to spin.
      if (isSingle) {
        const ROTATE_OFFSET = 26;
        const topMid = toPageRotated(cx, b.y);
        const handlePt = toPageRotated(cx, b.y - ROTATE_OFFSET);
        const dx = handlePt.x - topMid.x, dy = handlePt.y - topMid.y;
        const lineLength = Math.sqrt(dx * dx + dy * dy);
        const lineAngle = Math.atan2(dy, dx);
        rotateLine.style.display = "block";
        rotateLine.style.left = topMid.x + "px";
        rotateLine.style.top = topMid.y + "px";
        rotateLine.style.width = lineLength + "px";
        rotateLine.style.transform = `rotate(${lineAngle}rad)`;
        rotateHandle.style.display = "block";
        rotateHandle.style.left = (handlePt.x - (HANDLE_SIZE + 2) / 2) + "px";
        rotateHandle.style.top = (handlePt.y - (HANDLE_SIZE + 2) / 2) + "px";
      } else {
        rotateHandle.style.display = "none";
        rotateLine.style.display = "none";
      }
    }

    let dragState = null; // { kind: 'move'|'resize', handle?, startMouse, startGroupBBox, startLayerBoxes: Map<id,bbox> }

    rotateHandle.addEventListener("pointerdown", (e) => {
      const selected = getSelectedStrokes();
      if (selected.length !== 1) return; // rotation is single-layer only
      e.preventDefault();
      e.stopPropagation();
      const s = selected[0];
      const b = s.targetBBox;
      const centerPage = { x: rect.x + b.x + b.width / 2, y: rect.y + b.y + b.height / 2 };
      dragState = {
        kind: "rotate",
        strokeId: s.id,
        centerPage,
        startAngle: Math.atan2(e.clientY - centerPage.y, e.clientX - centerPage.x),
        startRotation: s.rotation || 0
      };
      window.addEventListener("pointermove", onDragMove);
      window.addEventListener("pointerup", onDragEnd);
    });

    HANDLES.forEach((pos) => {
      handleEls[pos].addEventListener("pointerdown", (e) => {
        const selected = getSelectedStrokes();
        if (selected.length === 0) return;
        e.preventDefault();
        e.stopPropagation();
        dragState = {
          kind: "resize",
          handle: pos,
          startMouse: { x: e.clientX, y: e.clientY },
          startGroupBBox: getGroupBBox(selected),
          startLayerBoxes: new Map(selected.map((s) => [s.id, { ...s.targetBBox }]))
        };
        window.addEventListener("pointermove", onDragMove);
        window.addEventListener("pointerup", onDragEnd);
      });
    });

    function onDragMove(e) {
      if (dragState && dragState.kind === "rotate") {
        const s = strokes.find((x) => x.id === dragState.strokeId);
        if (!s) return;
        const angle = Math.atan2(e.clientY - dragState.centerPage.y, e.clientX - dragState.centerPage.x);
        s.rotation = dragState.startRotation + (angle - dragState.startAngle);
        paintCanvas();
        positionSelectionHandles();
        return;
      }
      const selected = getSelectedStrokes();
      if (selected.length === 0 || !dragState) return;
      const dx = e.clientX - dragState.startMouse.x;
      const dy = e.clientY - dragState.startMouse.y;

      if (dragState.kind === "move") {
        // Same translation for every selected layer — relative positions
        // within the group are preserved exactly.
        for (const s of selected) {
          const start = dragState.startLayerBoxes.get(s.id);
          if (!start) continue;
          s.targetBBox = { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height };
        }
      } else {
        const startGroup = dragState.startGroupBBox;
        let { x, y, width, height } = startGroup;
        const h = dragState.handle;
        if (h.includes("e")) width = startGroup.width + dx;
        if (h.includes("s")) height = startGroup.height + dy;
        if (h.includes("w")) { x = startGroup.x + dx; width = startGroup.width - dx; }
        if (h.includes("n")) { y = startGroup.y + dy; height = startGroup.height - dy; }
        if (width < 0) { x += width; width = -width; }
        if (height < 0) { y += height; height = -height; }
        const newGroup = { x, y, width: Math.max(6, width), height: Math.max(6, height) };

        // Map every selected layer's relative position/size within the OLD
        // group box into the NEW group box — this is what lets a whole
        // selection be resized/deformed together while each layer keeps its
        // proportional place and size within the group.
        const sgx = newGroup.width / (startGroup.width || 1);
        const sgy = newGroup.height / (startGroup.height || 1);
        for (const s of selected) {
          const start = dragState.startLayerBoxes.get(s.id);
          if (!start) continue;
          s.targetBBox = {
            x: newGroup.x + (start.x - startGroup.x) * sgx,
            y: newGroup.y + (start.y - startGroup.y) * sgy,
            width: Math.max(4, start.width * sgx),
            height: Math.max(4, start.height * sgy)
          };
        }
      }
      paintCanvas();
      positionSelectionHandles();
    }
    function onDragEnd() {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      dragState = null;
      sendSnapshot(true);
    }

    // ---------- Pen: fast incremental drawing (no per-move full redraw) ----------

    function beginPenStroke(pt) {
      currentStroke = { id: nextLayerId++, tool: "pen", color, width: brushSize, opacity: brushOpacity, blur: brushSoftness, rotation: 0, points: [pt] };
      lastMidpoint = pt;
      ctx.save();
      ctx.globalAlpha = currentStroke.opacity;
      ctx.filter = currentStroke.blur > 0 ? `blur(${currentStroke.blur}px)` : "none";
      ctx.fillStyle = currentStroke.color;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, currentStroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function extendPenStroke(pt) {
      const pts = currentStroke.points;
      pts.push(pt);
      const n = pts.length;
      const p0 = pts[n - 2], p1 = pts[n - 1];
      const newMid = n >= 3 ? { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 } : p1;
      ctx.save();
      ctx.globalAlpha = currentStroke.opacity;
      ctx.filter = currentStroke.blur > 0 ? `blur(${currentStroke.blur}px)` : "none";
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = currentStroke.width;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(lastMidpoint.x, lastMidpoint.y);
      ctx.quadraticCurveTo(p0.x, p0.y, newMid.x, newMid.y);
      ctx.stroke();
      ctx.restore();
      lastMidpoint = newMid;
      sendSnapshot(false);
    }

    function finishPenStroke() {
      if (!currentStroke) return;
      currentStroke.baseBBox = computeBaseBBox(currentStroke);
      currentStroke.targetBBox = { ...currentStroke.baseBBox };
      strokes.push(currentStroke);
      currentStroke = null;
      lastMidpoint = null;
      redraw(); // one authoritative repaint so pixels exactly match future re-renders
      sendSnapshot(true);
    }

    // ---------- Pointer wiring on the canvas ----------

    function onPointerDown(e) {
      if (activeTextEditor) return;
      if (tool === "pen") {
        beginPenStroke(toLocal(e));
        canvas.setPointerCapture(e.pointerId);
      } else if (tool === "text") {
        e.preventDefault();
        e.stopPropagation();
        openTextEditor(toLocal(e));
      } else if (tool === "select") {
        const pt = toLocal(e);
        let hitIndex = -1;
        for (let i = strokes.length - 1; i >= 0; i--) {
          const b = strokes[i].targetBBox;
          if (pt.x >= b.x - 6 && pt.x <= b.x + b.width + 6 && pt.y >= b.y - 6 && pt.y <= b.y + b.height + 6) { hitIndex = i; break; }
        }
        if (hitIndex === -1) {
          if (!(e.ctrlKey || e.metaKey || e.shiftKey)) selectedIds = new Set();
        } else {
          const hasModifier = e.ctrlKey || e.metaKey || e.shiftKey;
          const alreadyInGroup = selectedIds.has(strokes[hitIndex].id) && selectedIds.size > 1;
          // A plain click on something that's already part of the current
          // multi-selection must NOT collapse it down to just that one item
          // — otherwise dragging always ends up moving only a single layer
          // even though several were selected.
          if (hasModifier || !alreadyInGroup) {
            selectLayerAt(hitIndex, e);
          }
        }
        updateSelectionUI();
        const selected = getSelectedStrokes();
        if (hitIndex !== -1 && selected.length > 0) {
          e.preventDefault();
          dragState = {
            kind: "move",
            startMouse: { x: e.clientX, y: e.clientY },
            startGroupBBox: getGroupBBox(selected),
            startLayerBoxes: new Map(selected.map((s) => [s.id, { ...s.targetBBox }]))
          };
          window.addEventListener("pointermove", onDragMove);
          window.addEventListener("pointerup", onDragEnd);
        }
      }
    }
    function onPointerMove(e) {
      if (tool === "pen" && currentStroke) extendPenStroke(toLocal(e));
    }
    function onPointerUp() {
      if (tool === "pen" && currentStroke) finishPenStroke();
    }

    // ---------- Text editing ----------

    function openTextEditor(pos) {
      canvas.style.pointerEvents = "none";
      const wrap = document.createElement("div");
      wrap.style.cssText = `
        position: fixed; left: ${rect.x + pos.x}px; top: ${rect.y + pos.y}px;
        z-index: 2147483647; display: flex; flex-direction: column; gap: 6px;
        align-items: flex-start;
      `;
      const input = document.createElement("textarea");
      input.placeholder = STR.typeHint;
      input.spellcheck = false;
      input.style.cssText = `
        min-width: 160px; min-height: 32px; box-sizing: border-box;
        background: rgba(255,255,255,0.97); border: 2px solid ${color};
        border-radius: 8px; font: ${fontWeight} ${Math.max(14, Math.min(28, fontSize))}px ${FONT_STACK};
        color: #17181c; padding: 4px 8px; resize: both;
      `;
      const btnRow = document.createElement("div");
      btnRow.style.cssText = "display:flex; gap:6px;";
      const confirmBtn = document.createElement("button");
      confirmBtn.textContent = STR.confirm;
      confirmBtn.style.cssText = "background:#7c5cff; color:#fff; border:none; padding:6px 12px; border-radius:7px; font-size:12px; font-weight:700; cursor:pointer;";
      const cancelBtn = document.createElement("button");
      cancelBtn.textContent = STR.cancel;
      cancelBtn.style.cssText = "background:rgba(255,255,255,0.9); color:#17181c; border:none; padding:6px 12px; border-radius:7px; font-size:12px; font-weight:700; cursor:pointer;";
      btnRow.appendChild(cancelBtn);
      btnRow.appendChild(confirmBtn);
      wrap.appendChild(input);
      wrap.appendChild(btnRow);
      document.documentElement.appendChild(wrap);
      requestAnimationFrame(() => input.focus());
      activeTextEditor = wrap;

      let done = false;
      function finish(confirmed) {
        if (done) return;
        done = true;
        if (confirmed && input.value.trim()) {
          const stroke = { id: nextLayerId++, tool: "text", color, x: pos.x, y: pos.y, text: input.value, fontSize, fontWeight, rotation: 0 };
          stroke.baseBBox = computeBaseBBox(stroke);
          stroke.targetBBox = { ...stroke.baseBBox };
          strokes.push(stroke);
          redraw();
          sendSnapshot(true);
        }
        wrap.remove();
        canvas.style.pointerEvents = "auto";
        activeTextEditor = null;
      }
      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
        else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      });
      confirmBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(true); });
      cancelBtn.addEventListener("click", (e) => { e.stopPropagation(); finish(false); });
    }

    // ---------- Wiring ----------

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    penBtn.addEventListener("click", () => setActiveTool("pen"));
    textBtn.addEventListener("click", () => setActiveTool("text"));
    selectBtn.addEventListener("click", () => setActiveTool("select"));
    colorInput.addEventListener("input", (e) => { color = e.target.value; persistToolSettings(); });
    undoBtn.addEventListener("click", () => {
      const removed = strokes.pop();
      if (removed) closeImageStroke(removed);
      const liveIds = new Set(strokes.map((s) => s.id));
      selectedIds = new Set([...selectedIds].filter((id) => liveIds.has(id)));
      redraw();
      sendSnapshot(true);
      ensureAnimationLoop();
    });
    clearBtn.addEventListener("click", () => {
      strokes.forEach(closeImageStroke);
      strokes = [];
      selectedIds = new Set();
      redraw();
      sendSnapshot(true);
      ensureAnimationLoop();
    });
    hideBtn.addEventListener("click", () => {
      toolbarVisible = !toolbarVisible;
      canvas.style.display = toolbarVisible ? "block" : "none";
      [brushPanel, textPanel, layersPanel].forEach((el) => {
        if (el === brushPanel) el.style.display = toolbarVisible && tool === "pen" ? "flex" : "none";
        else if (el === textPanel) el.style.display = toolbarVisible && tool === "text" ? "flex" : "none";
        else el.style.display = toolbarVisible ? "flex" : "none";
      });
      libraryPanel.style.display = toolbarVisible && libraryOpen ? "flex" : "none";
      [penBtn, textBtn, selectBtn, libraryBtn, colorInput, undoBtn, clearBtn].forEach((el) => { el.style.display = toolbarVisible ? "flex" : "none"; });
      pasteHint.style.display = toolbarVisible ? "block" : "none";
      if (saveBtn) { saveBtn.parentElement.style.display = toolbarVisible ? "flex" : "none"; }
      if (stopRecordingBtn) { stopRecordingBtn.style.display = toolbarVisible ? "block" : "none"; }
      hideBtn.textContent = toolbarVisible ? "×" : "✎";
      hideBtn.title = toolbarVisible ? STR.hide : STR.show;
      positionToolbar();
    });

    if (isScreenshotMode) {
      saveBtn.addEventListener("click", () => {
        const finalDataUrl = canvas.toDataURL("image/png");
        chrome.runtime.sendMessage({ target: "background", type: "SCREENSHOT_ANNOTATION_SAVE", dataUrl: finalDataUrl }).catch(() => {});
        teardown();
      });
      cancelEditBtn.addEventListener("click", () => {
        chrome.runtime.sendMessage({ target: "background", type: "SCREENSHOT_ANNOTATION_CANCEL" }).catch(() => {});
        teardown();
      });
    }

    window.addEventListener("resize", positionToolbar);

    function teardown() {
      window.removeEventListener("resize", positionToolbar);
      window.removeEventListener("resize", refreshCachedCanvasRect);
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragEnd);
      document.removeEventListener("paste", onPasteEvent);
      document.removeEventListener("keydown", onGlobalKeyDown);
      snapshotLoopStopped = true;
      strokes.forEach(closeImageStroke);
      if (activeTextEditor) activeTextEditor.remove();
      canvas.remove();
      toolbar.remove();
      selectionBox.remove();
      rotateHandle.remove();
      rotateLine.remove();
      Object.values(handleEls).forEach((h) => h.remove());
      window.__screenrecAnnotationLoaded__ = false;
    }

    chrome.runtime.onMessage.addListener(function onMsg(message) {
      if (message && message.type === "STOP_ANNOTATION") {
        chrome.runtime.onMessage.removeListener(onMsg);
        teardown();
      }
    });

    redraw();
    sendSnapshot(true);
  };
})();
