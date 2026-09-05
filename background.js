// Background service worker (MV3). Coordinates hotkeys, screenshots and
// video recording. Recording itself happens in a persistent "offscreen"
// document (chrome.offscreen) so it keeps running after the popup/side
// panel is closed. Falls back to a small recorder window on browsers that
// don't support chrome.offscreen / chrome.tabCapture (e.g. Firefox).
//
// IMPORTANT: MV3 service workers can be unloaded by the browser at any time
// after a short idle period. Any state kept only in plain JS variables here
// would be silently lost mid-recording (the offscreen document keeps
// recording, but the service worker "forgets" about it). To avoid that,
// all recording state is mirrored into chrome.storage.session, which
// survives service worker restarts within the same browser session.

const HAS_OFFSCREEN = !!(chrome.offscreen && chrome.offscreen.createDocument);
const HAS_TAB_CAPTURE = !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId);

const DEFAULT_STATE = {
  isRecording: false,
  isSaving: false, // true from "Stop" click until the file is actually saved (or fails)
  recordingStartedAt: null,
  recorderWindowId: null, // fallback path only
  recordingTabId: null,   // set for "tab"/"area" modes so the UI can jump back to it
  recordingTabTitle: null
};

let state = { ...DEFAULT_STATE };

const stateReady = chrome.storage.session.get(Object.keys(DEFAULT_STATE))
  .then((stored) => { state = { ...DEFAULT_STATE, ...stored }; })
  .catch(() => {});

async function setState(partial) {
  state = { ...state, ...partial };
  try {
    await chrome.storage.session.set(partial);
  } catch (e) {
    console.error("ScreenRec: failed to persist state", e);
  }
}

async function resetRecordingState() {
  const tabId = state.recordingTabId;
  await setState({
    isRecording: false,
    isSaving: false,
    recordingStartedAt: null,
    recorderWindowId: null,
    recordingTabId: null,
    recordingTabTitle: null
  });
  if (tabId != null) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "STOP_ANNOTATION" });
    } catch (e) {
      // tab may be closed, or never had the annotation overlay injected — fine
    }
  }
}

// ---------- Large-blob transfer (IndexedDB) ----------
// chrome.runtime.sendMessage has a hard 64MiB cap, which a long recording's
// base64 payload can easily exceed. IndexedDB is available in both the
// service worker and the offscreen document (same extension origin), so we
// pass only a small string key through messaging and hand off the actual
// video data via IndexedDB instead.

const BLOB_DB_NAME = "screenrec-blobs-db";
const BLOB_STORE_NAME = "blobs";

function openBlobDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLOB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BLOB_STORE_NAME)) {
        req.result.createObjectStore(BLOB_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getBlobRecord(id) {
  const db = await openBlobDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, "readonly");
    const req = tx.objectStore(BLOB_STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlobRecord(id) {
  try {
    const db = await openBlobDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE_NAME, "readwrite");
      tx.objectStore(BLOB_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) {
    console.error("ScreenRec: failed to clean up blob record", e);
  }
}

// ---------- Utilities ----------

async function blobToDataURL(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function timestampName(ext) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `ScreenRec/${stamp}.${ext}`;
}

// ---------- Activity log (persistent — helps users find where things were saved) ----------

const ACTIVITY_LOG_KEY = "activityLog";
const ACTIVITY_LOG_MAX = 10;

async function appendLogEntry(entry) {
  try {
    const { [ACTIVITY_LOG_KEY]: existing = [] } = await chrome.storage.local.get([ACTIVITY_LOG_KEY]);
    const updated = [{ ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, ...existing]
      .slice(0, ACTIVITY_LOG_MAX);
    await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: updated });
  } catch (e) {
    console.error("ScreenRec: failed to write activity log", e);
  }
}

// All actual chrome.downloads.download() calls happen here, in the
// background script — some contexts (e.g. offscreen documents) don't have
// reliable access to chrome.downloads, so offscreen.js/recorder.js send us
// the data instead of downloading it themselves.
async function downloadAndLog(dataUrl, filename, type, extra = {}) {
  const downloadId = await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  await appendLogEntry({ downloadId, type, filename, timestamp: Date.now(), ...extra });
  return downloadId;
}

// ---------- Settings ----------

async function getSettings() {
  const { lang = "auto", autoClipboard = true, screenshotFormat = "png" } =
    await chrome.storage.local.get(["lang", "autoClipboard", "screenshotFormat"]);
  return { lang, autoClipboard, screenshotFormat };
}

function screenshotMimeAndExt(format) {
  return format === "webp" ? { mime: "image/webp", ext: "webp" } : { mime: "image/png", ext: "png" };
}

async function getUILang() {
  const { lang } = await getSettings();
  if (lang === "en" || lang === "ru") return lang;
  const uiLang = chrome.i18n.getUILanguage();
  return uiLang.toLowerCase().startsWith("ru") ? "ru" : "en";
}

const NOTIF_STRINGS = {
  en: {
    screenshotSavedTitle: "Screenshot saved",
    screenshotSavedMsg: "Your screenshot was downloaded.",
    screenshotSavedClipboardMsg: "Downloaded and copied to clipboard.",
    clipboardFailedTitle: "Clipboard copy failed",
    clipboardFailedMsg: "The screenshot was saved, but couldn't be copied to the clipboard.",
    recordingSavedTitle: "Recording saved",
    recordingSavedMsg: "Your video was downloaded.",
    errorTitle: "Something went wrong",
    errorRestrictedMsg: "This isn't possible on browser system pages (chrome://, about:, the Web Store, etc). Please switch to a regular website tab.",
    selectAreaTitle: "Select an area",
    selectAreaMsg: "Drag on the page to select the region, then confirm."
  },
  ru: {
    screenshotSavedTitle: "Скриншот сохранён",
    screenshotSavedMsg: "Скриншот загружен в папку загрузок.",
    screenshotSavedClipboardMsg: "Загружен и скопирован в буфер обмена.",
    clipboardFailedTitle: "Не удалось скопировать в буфер",
    clipboardFailedMsg: "Скриншот сохранён, но не удалось скопировать его в буфер обмена.",
    recordingSavedTitle: "Запись сохранена",
    recordingSavedMsg: "Видео загружено в папку загрузок.",
    errorTitle: "Что-то пошло не так",
    errorRestrictedMsg: "Это невозможно на служебных страницах браузера (chrome://, about:, магазин расширений и т.п.). Переключитесь на обычную вкладку сайта.",
    selectAreaTitle: "Выделите область",
    selectAreaMsg: "Выделите регион на странице и подтвердите."
  }
};

async function notify(titleKey, messageKey) {
  const lang = await getUILang();
  const s = NOTIF_STRINGS[lang];
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: s[titleKey],
    message: s[messageKey]
  });
}

async function updateBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: state.isSaving ? "#f2a900" : "#e04343" });
  await chrome.action.setBadgeText({ text: state.isSaving ? "..." : state.isRecording ? "REC" : "" });
}

const RESTRICTED_URL_PREFIXES = [
  "chrome://", "chrome-extension://", "edge://", "about:", "moz-extension://",
  "view-source:", "chrome.google.com/webstore", "microsoftedge.microsoft.com/addons",
  "addons.mozilla.org", "devtools://", "data:"
];

function isRestrictedUrl(url) {
  if (!url) return true;
  return RESTRICTED_URL_PREFIXES.some((p) => url.includes(p));
}

async function guardActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isRestrictedUrl(tab.url)) {
    await notify("errorTitle", "errorRestrictedMsg");
    return null;
  }
  return tab;
}

// ---------- Offscreen document (recording + clipboard) ----------

async function ensureOffscreenDocument() {
  if (!HAS_OFFSCREEN) return false;
  let alreadyExists = false;
  try {
    if (chrome.offscreen.hasDocument) {
      alreadyExists = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      alreadyExists = existing && existing.length > 0;
    }
  } catch (e) {
    alreadyExists = false;
  }
  if (alreadyExists) return true;

  const reasonSets = [
    ["USER_MEDIA", "DISPLAY_MEDIA", "CLIPBOARD"],
    ["USER_MEDIA", "CLIPBOARD"],
    ["CLIPBOARD"],
    ["USER_MEDIA"]
  ];
  let lastErr = null;
  for (const reasons of reasonSets) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons,
        justification: "Recording screen/tab video with audio and copying screenshots to the clipboard — both need to keep working after the popup closes."
      });
      return true;
    } catch (e) {
      lastErr = e;
      if (/already exists/i.test(String(e))) return true;
    }
  }
  console.error("ScreenRec: could not create offscreen document", lastErr);
  throw lastErr || new Error("offscreen document creation failed");
}

let offscreenBusyCount = 0;

async function closeOffscreenDocumentIfIdle() {
  if (!HAS_OFFSCREEN) return;
  if (state.isRecording || offscreenBusyCount > 0) return; // still needed
  try {
    await chrome.offscreen.closeDocument();
  } catch (e) {
    // already closed
  }
}

// Freshly-created offscreen documents can have a brief window where
// chrome.offscreen.createDocument() has resolved but the document's own
// script hasn't attached its onMessage listener yet, so the very first
// sendMessage can race and fail with "receiving end does not exist" even
// though the document exists. Retry a couple of times before giving up.
async function sendToOffscreen(message, attempts = 4) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 + i * 120));
    }
  }
  throw lastErr;
}

async function copyDataUrlToClipboard(dataUrl) {
  if (!HAS_OFFSCREEN) return; // no reliable clipboard path without offscreen documents (e.g. Firefox)
  offscreenBusyCount++;
  try {
    await ensureOffscreenDocument();
    await sendToOffscreen({ type: "COPY_IMAGE_TO_CLIPBOARD", dataUrl });
    // The actual success/failure is reported later via CLIPBOARD_COPY_RESULT
    // once the async navigator.clipboard.write() in the offscreen document
    // resolves — we intentionally don't claim success here.
  } catch (e) {
    console.error("ScreenRec: clipboard copy request failed", e);
    await notify("clipboardFailedTitle", "clipboardFailedMsg");
    offscreenBusyCount--;
    await closeOffscreenDocumentIfIdle();
    return;
  }
  offscreenBusyCount--;
}

// ---------- Screenshot: visible area ----------

async function captureVisibleTabPng(windowId) {
  return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

// chrome.tabs.captureVisibleTab is rate-limited (roughly 2 calls/sec per
// profile). The full-page screenshot loop calls this many times in a row,
// so retry with backoff instead of failing outright on
// MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
async function captureVisibleTabPngSafe(windowId, maxAttempts = 6) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await captureVisibleTabPng(windowId);
    } catch (e) {
      const isQuota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(e && e.message || e));
      if (isQuota && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 700 + attempt * 250));
        continue;
      }
      throw e;
    }
  }
}

async function finishScreenshot(dataUrl, filename, mode) {
  const downloadId = await downloadAndLog(dataUrl, filename, "screenshot", { mode });
  const { autoClipboard } = await getSettings();
  if (autoClipboard && HAS_OFFSCREEN) {
    // Fire-and-forget: its real outcome arrives later via
    // CLIPBOARD_COPY_RESULT, which only surfaces a notification on failure
    // (to avoid a confusing "copied" toast racing ahead of the actual result).
    copyDataUrlToClipboard(dataUrl);
  } else if (HAS_OFFSCREEN) {
    // Keep it around (this session) so the manual "copy to clipboard"
    // button in the popup/side panel can still act on it later.
    await chrome.storage.session.set({ lastScreenshotDataUrl: dataUrl });
  }
  await notify("screenshotSavedTitle", "screenshotSavedMsg");
  return downloadId;
}

// chrome.tabs.captureVisibleTab only ever returns PNG or JPEG — re-encode
// through a canvas when the user wants WebP instead.
async function reencodeDataUrl(dataUrl, mime, quality) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const outBlob = await canvas.convertToBlob({ type: mime, quality });
  return await blobToDataURL(outBlob);
}

async function doCaptureVisible(tab) {
  try {
    let dataUrl = await captureVisibleTabPngSafe(tab.windowId);
    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    if (screenshotFormat === "webp") dataUrl = await reencodeDataUrl(dataUrl, mime, 0.92);
    await finishScreenshot(dataUrl, timestampName(ext), "visible");
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// ---------- Screenshot / video: selected area ----------

async function startAreaSelection(tabId, purpose, audio) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["select-overlay.js"]
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (p, a) => window.__screenrecStartSelection__(p, a),
    args: [purpose, !!audio]
  });
}

async function doCaptureArea(tab) {
  try {
    await notify("selectAreaTitle", "selectAreaMsg");
    await startAreaSelection(tab.id, "screenshot", false);
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

async function cropDataUrl(dataUrl, rect, dpr, viewportWidth, viewportHeight, mime) {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  // Prefer a scale factor derived from the actual captured pixel size vs
  // the CSS viewport size measured at selection time — more reliable than
  // assuming the capture is exactly `cssPixels * devicePixelRatio` (browser
  // capture pipelines don't always guarantee that exact relationship).
  const scaleX = viewportWidth ? bitmap.width / viewportWidth : dpr;
  const scaleY = viewportHeight ? bitmap.height / viewportHeight : dpr;

  const sx = Math.max(0, Math.round(rect.x * scaleX));
  const sy = Math.max(0, Math.round(rect.y * scaleY));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scaleX)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scaleY)));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({ type: mime || "image/png", quality: mime === "image/webp" ? 0.92 : undefined });
  return await blobToDataURL(outBlob);
}

async function handleAreaSelected(message, sender) {
  const { rect, purpose, dpr, viewportWidth, viewportHeight } = message;
  const tab = sender.tab;
  if (purpose === "screenshot") {
    try {
      const fullDataUrl = await captureVisibleTabPngSafe(tab.windowId);
      const croppedDataUrl = await cropDataUrl(fullDataUrl, rect, dpr, viewportWidth, viewportHeight, "image/png");
      // Hand the frozen crop to the same drawing overlay used for video,
      // in "screenshot" mode: the user can draw/annotate on top of the
      // still image before it's actually saved.
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate-overlay.js"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (r, d, img) => window.__screenrecStartAnnotation__(r, d, { mode: "screenshot", imageDataUrl: img }),
        args: [rect, dpr || 1, croppedDataUrl]
      });
    } catch (e) {
      console.error(e);
      await notify("errorTitle", "errorTitle");
    }
  } else if (purpose === "video") {
    await beginTabRecording(tab, { audio: message.audio !== false, rect, dpr, viewportWidth, viewportHeight });
  }
}

async function handleScreenshotAnnotationSave(dataUrl) {
  try {
    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    const finalDataUrl = screenshotFormat === "webp" ? await reencodeDataUrl(dataUrl, mime, 0.92) : dataUrl;
    await finishScreenshot(finalDataUrl, timestampName(ext), "area");
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// ---------- Full page (scrolling) screenshot ----------

async function doCaptureFullPage(tab) {
  try {
    const [{ result: pageInfo }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        originalScrollY: window.scrollY
      })
    });

    const { scrollHeight, viewportHeight, viewportWidth, dpr, originalScrollY } = pageInfo;
    const steps = Math.max(1, Math.ceil(scrollHeight / viewportHeight));
    const shots = [];

    for (let i = 0; i < steps; i++) {
      const y = Math.min(i * viewportHeight, Math.max(0, scrollHeight - viewportHeight));
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (yy) => window.scrollTo(0, yy),
        args: [y]
      });
      // Stay comfortably under the ~2 calls/sec captureVisibleTab quota.
      await new Promise((r) => setTimeout(r, 650));
      const dataUrl = await captureVisibleTabPngSafe(tab.windowId);
      shots.push({ y, dataUrl });
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (yy) => window.scrollTo(0, yy),
      args: [originalScrollY]
    });

    const canvas = new OffscreenCanvas(
      Math.round(viewportWidth * dpr),
      Math.round(scrollHeight * dpr)
    );
    const ctx = canvas.getContext("2d");

    for (const shot of shots) {
      const resp = await fetch(shot.dataUrl);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, Math.round(shot.y * dpr));
    }

    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    const outBlob = await canvas.convertToBlob({ type: mime, quality: screenshotFormat === "webp" ? 0.92 : undefined });
    const outDataUrl = await blobToDataURL(outBlob);
    await finishScreenshot(outDataUrl, timestampName(ext), "fullpage");
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// ---------- Video recording: offscreen-backed (Chrome) ----------

// Record the current tab (optionally cropped to `rect`) with no OS picker,
// using chrome.tabCapture + an offscreen document so it survives the popup
// closing.
async function beginTabRecording(tab, { audio, rect, dpr, viewportWidth, viewportHeight }) {
  if (!HAS_TAB_CAPTURE || !HAS_OFFSCREEN) {
    // Fallback for browsers without these APIs (e.g. Firefox): use the
    // window-based recorder, which relies on getDisplayMedia's own picker.
    await openRecorderWindowFallback({ mode: rect ? "area" : "full", audio, rect, dpr, tab, viewportWidth, viewportHeight });
    return;
  }
  try {
    // "tab" mode (no area selection) doesn't have viewport info yet — fetch
    // it now so we can request an exact-resolution capture below.
    if (!viewportWidth || !viewportHeight) {
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio || 1
          })
        });
        viewportWidth = result.viewportWidth;
        viewportHeight = result.viewportHeight;
        dpr = result.dpr;
      } catch (e) {
        // Non-fatal — we'll just skip the exact-resolution constraint below.
      }
    }

    await ensureOffscreenDocument();
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }, (id) => {
        if (chrome.runtime.lastError || !id) reject(chrome.runtime.lastError || new Error("no stream id"));
        else resolve(id);
      });
    });
    await setState({ recordingTabId: tab.id, recordingTabTitle: tab.title || null });
    // Make sure the tab actually being recorded is the one on screen —
    // matters when the recording was kicked off via hotkey/side panel and
    // some other tab/window could otherwise end up in front.
    try {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) { /* tab/window may have gone away; not fatal */ }
    await sendToOffscreen({
      type: "START_TAB_CAPTURE",
      streamId,
      audio: !!audio,
      rect: rect || null,
      dpr: dpr || 1,
      viewportWidth: viewportWidth || null,
      viewportHeight: viewportHeight || null,
      mode: rect ? "area" : "tab"
    });

    // Area recordings get a live drawing/annotation overlay (pen + text)
    // whose strokes get composited into the recorded video in real time.
    if (rect) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["annotate-overlay.js"] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (r, d) => window.__screenrecStartAnnotation__(r, d),
          args: [rect, dpr || 1]
        });
      } catch (e) {
        console.error("ScreenRec: failed to inject annotation overlay", e);
      }
    }
  } catch (e) {
    console.error(e);
    await resetRecordingState();
    await notify("errorTitle", "errorTitle");
  }
}

// Fallback: small always-visible window using getDisplayMedia (used when
// offscreen/tabCapture aren't available, e.g. Firefox).
async function openRecorderWindowFallback({ mode, audio, rect, dpr, tab, viewportWidth, viewportHeight }) {
  if (rect) {
    await chrome.storage.session.set({
      pendingRect: rect,
      pendingRectDpr: dpr || 1,
      pendingRectViewportW: viewportWidth || null,
      pendingRectViewportH: viewportHeight || null
    });
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`recorder.html?mode=${mode}&audio=${audio ? 1 : 0}`),
    type: "popup",
    width: 420,
    height: 320,
    focused: true
  });
  await setState({
    recorderWindowId: win.id,
    recordingTabId: tab ? tab.id : null,
    recordingTabTitle: tab ? (tab.title || null) : null,
    isRecording: true,
    recordingStartedAt: Date.now()
  });
  await updateBadge();
}

async function stopRecording() {
  if (!state.isRecording) return;
  await setState({ isSaving: true });
  await updateBadge();
  if (HAS_OFFSCREEN && state.recorderWindowId == null) {
    try {
      await sendToOffscreen({ type: "STOP_RECORDING" });
    } catch (e) {
      // offscreen doc might already be gone
    }
  } else if (state.recorderWindowId != null) {
    try {
      await chrome.runtime.sendMessage({ target: "recorderWindow", type: "RECORDER_STOP_REQUEST" });
    } catch (e) {
      // window already closed
    }
  }
}

async function toggleRecordingViaHotkey(tab) {
  const { lastMode = "tab", lastAudio = true } = await chrome.storage.local.get(["lastMode", "lastAudio"]);
  if (lastMode === "area") {
    try {
      await startAreaSelection(tab.id, "video", lastAudio);
    } catch (e) {
      console.error(e);
      await notify("errorTitle", "errorTitle");
    }
  } else if (lastMode === "screen") {
    // Full desktop/window capture needs a real user gesture inside a visible
    // page (browser security requirement) — can't be started headlessly
    // from a hotkey. Open the side panel so the user can click Start there.
    try {
      const [win] = await chrome.windows.getAll();
      if (chrome.sidePanel && win) await chrome.sidePanel.open({ windowId: win.id });
    } catch (e) { /* ignore */ }
  } else {
    await beginTabRecording(tab, { audio: lastAudio });
  }
}

// ---------- Message + event wiring ----------

chrome.commands.onCommand.addListener(async (command) => {
  await stateReady;
  if (command === "toggle-recording") {
    if (state.isRecording) {
      await stopRecording();
      return;
    }
    const tab = await guardActiveTab();
    if (!tab) return;
    await toggleRecordingViaHotkey(tab);
    return;
  }
  const tab = await guardActiveTab();
  if (!tab) return;
  if (command === "capture-full-screenshot") await doCaptureVisible(tab);
  if (command === "capture-area-screenshot") await doCaptureArea(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target && message.target !== "background") return; // not for us

  (async () => {
    await stateReady;
    switch (message.type) {
      case "GET_STATE": {
        sendResponse({
          isRecording: state.isRecording,
          isSaving: state.isSaving,
          recordingStartedAt: state.recordingStartedAt,
          hasOffscreen: HAS_OFFSCREEN,
          hasTabCapture: HAS_TAB_CAPTURE,
          recordingTabId: state.recordingTabId,
          recordingTabTitle: state.recordingTabTitle
        });
        break;
      }
      case "CAPTURE_VISIBLE": {
        const tab = await guardActiveTab();
        if (tab) await doCaptureVisible(tab);
        sendResponse({ ok: !!tab });
        break;
      }
      case "CAPTURE_AREA_SCREENSHOT": {
        const tab = await guardActiveTab();
        if (tab) await doCaptureArea(tab);
        sendResponse({ ok: !!tab });
        break;
      }
      case "CAPTURE_FULLPAGE": {
        const tab = await guardActiveTab();
        if (tab) await doCaptureFullPage(tab);
        sendResponse({ ok: !!tab });
        break;
      }
      case "AREA_SELECTED": {
        await handleAreaSelected(message, sender);
        sendResponse({ ok: true });
        break;
      }
      case "SCREENSHOT_ANNOTATION_SAVE": {
        await handleScreenshotAnnotationSave(message.dataUrl);
        sendResponse({ ok: true });
        break;
      }
      case "SCREENSHOT_ANNOTATION_CANCEL": {
        sendResponse({ ok: true });
        break;
      }
      case "COPY_LAST_SCREENSHOT": {
        try {
          const { lastScreenshotDataUrl } = await chrome.storage.session.get(["lastScreenshotDataUrl"]);
          if (lastScreenshotDataUrl) {
            await copyDataUrlToClipboard(lastScreenshotDataUrl);
            sendResponse({ ok: true });
          } else {
            sendResponse({ ok: false, error: "no_screenshot" });
          }
        } catch (e) {
          console.error(e);
          sendResponse({ ok: false, error: String(e) });
        }
        break;
      }
      case "START_TAB_RECORDING": {
        await chrome.storage.local.set({ lastMode: "tab", lastAudio: !!message.audio });
        const tab = await guardActiveTab();
        if (tab) await beginTabRecording(tab, { audio: !!message.audio });
        sendResponse({ ok: !!tab });
        break;
      }
      case "START_LEGACY_SCREEN_RECORDING": {
        await chrome.storage.local.set({ lastMode: "screen", lastAudio: !!message.audio });
        await openRecorderWindowFallback({ mode: "full", audio: !!message.audio });
        sendResponse({ ok: true });
        break;
      }
      case "START_RECORDING_AREA_SELECT": {
        await chrome.storage.local.set({ lastMode: "area", lastAudio: !!message.audio });
        const tab = await guardActiveTab();
        if (tab) {
          await notify("selectAreaTitle", "selectAreaMsg");
          await startAreaSelection(tab.id, "video", !!message.audio);
        }
        sendResponse({ ok: !!tab });
        break;
      }
      case "ENSURE_OFFSCREEN": {
        await chrome.storage.local.set({ lastMode: "screen", lastAudio: !!message.audio });
        const ok = await ensureOffscreenDocument();
        sendResponse({ ok });
        break;
      }
      case "SCREEN_RECORDING_STARTED": {
        // Sent by popup/sidepanel once the WebRTC relay to the offscreen doc
        // is up and MediaRecorder has started there.
        await setState({
          isRecording: true,
          recordingStartedAt: Date.now(),
          recordingTabId: null, // not tied to a specific tab
          recordingTabTitle: null
        });
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "OFFSCREEN_RECORDING_STARTED": {
        await setState({ isRecording: true, recordingStartedAt: Date.now() });
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_RECORDING_BLOB": {
        // offscreen.js / recorder.js store the finished recording in
        // IndexedDB and hand us only a small key — passing the actual video
        // data through runtime.sendMessage would hit its 64MiB cap on
        // anything more than a few minutes long.
        //
        // Saving itself happens in a dedicated hidden helper page
        // (save-helper.html), not here and not in the offscreen document:
        // this extension's service worker doesn't support
        // URL.createObjectURL(), and offscreen documents don't expose
        // chrome.downloads — an ordinary extension page is the only context
        // confirmed to have both. Converting the video to a base64 data URL
        // instead (the previous approach) was suspected as a source of
        // corrupted large recordings, so we now avoid that path entirely.
        try {
          const helperUrl = chrome.runtime.getURL(
            `save-helper.html?blobId=${encodeURIComponent(message.blobId)}` +
            `&filename=${encodeURIComponent(message.filename)}` +
            `&mode=${encodeURIComponent(message.mode || "unknown")}`
          );
          try {
            await chrome.windows.create({ url: helperUrl, type: "popup", focused: false, state: "minimized" });
          } catch (e1) {
            // Some Chrome versions/platforms reject certain window option
            // combinations — fall back to a plain unfocused popup rather
            // than failing the save outright.
            console.error("ScreenRec: minimized save-helper window failed, retrying plain popup", e1);
            await chrome.windows.create({ url: helperUrl, type: "popup", focused: false, width: 200, height: 100 });
          }
        } catch (e) {
          console.error("ScreenRec: failed to open save helper", e);
          await deleteBlobRecord(message.blobId);
          await notify("errorTitle", "errorTitle");
          await resetRecordingState();
          await updateBadge();
          await closeOffscreenDocumentIfIdle();
        }
        sendResponse({ ok: true });
        break;
      }
      case "SAVE_RECORDING_RESULT": {
        if (message.ok) {
          await appendLogEntry({
            downloadId: message.downloadId,
            type: "video",
            filename: message.filename,
            timestamp: Date.now(),
            mode: message.mode
          });
          await notify("recordingSavedTitle", "recordingSavedMsg");
        } else {
          console.error("ScreenRec: save-helper reported failure —", message.detail);
          await notify("errorTitle", "errorTitle");
        }
        await resetRecordingState();
        await updateBadge();
        await closeOffscreenDocumentIfIdle();
        sendResponse({ ok: true });
        break;
      }
      case "OFFSCREEN_RECORDING_ERROR": {
        console.error("ScreenRec: recording failed —", message.detail || "unknown reason");
        await resetRecordingState();
        await updateBadge();
        await notify("errorTitle", "errorTitle");
        await closeOffscreenDocumentIfIdle();
        sendResponse({ ok: true });
        break;
      }
      case "STOP_RECORDING_REQUEST": {
        await stopRecording();
        sendResponse({ ok: true });
        break;
      }
      case "RECORDING_FINISHED": { // legacy fallback-window path (kept for safety)
        await resetRecordingState();
        await updateBadge();
        await notify("recordingSavedTitle", "recordingSavedMsg");
        sendResponse({ ok: true });
        break;
      }
      case "RECORDING_CANCELLED": {
        await resetRecordingState();
        await updateBadge();
        sendResponse({ ok: true });
        break;
      }
      case "FOCUS_RECORDING_TAB": {
        if (state.recordingTabId != null) {
          try {
            const t = await chrome.tabs.get(state.recordingTabId);
            await chrome.tabs.update(state.recordingTabId, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
          } catch (e) {
            // tab may have been closed
          }
        }
        sendResponse({ ok: true });
        break;
      }
      case "CLIPBOARD_COPY_RESULT": {
        if (!message.ok) {
          console.error("ScreenRec: clipboard copy failed —", message.detail);
          await notify("clipboardFailedTitle", "clipboardFailedMsg");
        }
        await closeOffscreenDocumentIfIdle();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep the message channel open for async sendResponse
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await stateReady;
  if (windowId === state.recorderWindowId) {
    await resetRecordingState();
    await updateBadge();
  }
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await stateReady;
  await updateBadge();
});
