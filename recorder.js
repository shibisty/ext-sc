// Runs inside recorder.html (an extension popup window). Handles the actual
// screen/tab capture, optional cropping to a previously selected area, and
// saving the resulting webm file.

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "full"; // "full" | "area"
const wantAudio = params.get("audio") === "1";

const dotEl = document.getElementById("dot");
const timeEl = document.getElementById("time");
const statusEl = document.getElementById("status");
const previewEl = document.getElementById("preview");
const stopBtn = document.getElementById("stopBtn");
const cancelBtn = document.getElementById("cancelBtn");

let lang = "en";
let displayStream = null;
let recordStream = null; // stream actually fed into MediaRecorder
let recorder = null;
let chunks = [];
let startedAt = null;
let timerHandle = null;
let cropRAF = null;
let finished = false;
let currentMimeType = "video/webm";

async function init() {
  const { lang: storedLang } = await SettingsStore.get();
  lang = resolveLang(storedLang);
  applyI18n(document, lang);
  const { theme } = await SettingsStore.get();
  applyTheme(theme);

  statusEl.textContent = t("recorderPickPrompt", lang);

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: wantAudio
    });
  } catch (e) {
    statusEl.textContent = t("recorderErrorPermission", lang);
    await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED" });
    setTimeout(() => window.close(), 1600);
    return;
  }

  // If the user (or the tab that requested this) closes the shared stream
  // from the browser's own "Stop sharing" UI, wrap up gracefully.
  const videoTrack = displayStream.getVideoTracks()[0];
  videoTrack.addEventListener("ended", () => finalize());

  if (mode === "area") {
    recordStream = await buildCroppedStream(displayStream);
  } else {
    recordStream = displayStream;
  }

  previewEl.srcObject = recordStream;
  previewEl.style.display = "block";
  await previewEl.play().catch(() => {});

  const { videoFormat = "webm" } = await chrome.storage.local.get(["videoFormat"]);
  const mimeType = pickSupportedMimeType(videoFormat === "mp4");
  currentMimeType = mimeType || "video/webm";
  const recorderOptions = mimeType ? { mimeType } : {};
  const { videoQuality = "auto" } = await chrome.storage.local.get(["videoQuality"]);
  const bitrate = { low: 1_000_000, medium: 2_500_000, high: 6_000_000 }[videoQuality];
  if (bitrate) recorderOptions.videoBitsPerSecond = bitrate;

  recorder = new MediaRecorder(recordStream, recorderOptions);
  chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = onRecorderStopped;
  recorder.start(1000);

  startedAt = Date.now();
  timerHandle = setInterval(updateTimer, 250);
  statusEl.textContent = t("recorderTitle", lang);
  stopBtn.disabled = false;
}

function pickSupportedMimeType(preferMp4) {
  const webmCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mp4Candidates = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=h264,aac", "video/mp4"];
  const ordered = preferMp4 ? [...mp4Candidates, ...webmCandidates] : [...webmCandidates, ...mp4Candidates];
  for (const c of ordered) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

async function buildCroppedStream(sourceStream) {
  const { pendingRect, pendingRectDpr, pendingRectViewportW, pendingRectViewportH } = await chrome.storage.session.get([
    "pendingRect",
    "pendingRectDpr",
    "pendingRectViewportW",
    "pendingRectViewportH"
  ]);
  const rect = pendingRect || { x: 0, y: 0, width: 1280, height: 720 };
  const dpr = pendingRectDpr || 1;

  const sourceVideo = document.createElement("video");
  sourceVideo.muted = true;
  sourceVideo.srcObject = sourceStream;
  await sourceVideo.play().catch(() => {});
  await new Promise((resolve) => {
    if (sourceVideo.readyState >= 2) resolve();
    else sourceVideo.onloadedmetadata = () => resolve();
  });

  const videoW = sourceVideo.videoWidth || Math.round((pendingRectViewportW || rect.width) * dpr);
  const videoH = sourceVideo.videoHeight || Math.round((pendingRectViewportH || rect.height) * dpr);

  // Prefer a scale factor derived from the actual captured pixel size vs the
  // CSS viewport size measured at selection time, rather than assuming the
  // capture is exactly `cssPixels * devicePixelRatio`.
  const scaleX = pendingRectViewportW ? videoW / pendingRectViewportW : dpr;
  const scaleY = pendingRectViewportH ? videoH / pendingRectViewportH : dpr;

  const outW = Math.max(2, Math.round(rect.width * scaleX));
  const outH = Math.max(2, Math.round(rect.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");

  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);

  function drawFrame() {
    if (finished) return;
    const vw = sourceVideo.videoWidth || videoW;
    const vh = sourceVideo.videoHeight || videoH;
    const cropX = Math.min(Math.max(0, sx), Math.max(0, vw - 1));
    const cropY = Math.min(Math.max(0, sy), Math.max(0, vh - 1));
    const cropW = Math.min(outW, vw - cropX);
    const cropH = Math.min(outH, vh - cropY);
    ctx.drawImage(sourceVideo, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
    cropRAF = requestAnimationFrame(drawFrame);
  }
  drawFrame();

  const canvasStream = canvas.captureStream(60);
  // Re-attach original audio tracks (if any) to the canvas-based video stream.
  sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  return canvasStream;
}

function updateTimer() {
  const elapsedMs = Date.now() - startedAt;
  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  timeEl.textContent = `${mm}:${ss}`;
}

async function finalize() {
  if (finished) return;
  finished = true;
  clearInterval(timerHandle);
  if (cropRAF) cancelAnimationFrame(cropRAF);
  stopBtn.disabled = true;
  cancelBtn.disabled = true;
  dotEl.style.animation = "none";
  dotEl.style.opacity = "0.3";

  if (recorder && recorder.state !== "inactive") {
    recorder.stop();
  } else {
    await onRecorderStopped();
  }
  (displayStream && displayStream.getTracks() || []).forEach((tr) => tr.stop());
}

// ---------- Large-blob transfer (IndexedDB) — see background.js for details ----------
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

async function storeBlobRecord(id, record) {
  const db = await openBlobDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, "readwrite");
    tx.objectStore(BLOB_STORE_NAME).put({ id, ...record });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function onRecorderStopped() {
  try {
    if (chunks.length > 0) {
      const ext = currentMimeType.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(chunks, { type: currentMimeType });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      const blobId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await storeBlobRecord(blobId, { blob, createdAt: Date.now() });
      statusEl.textContent = t("recorderDone", lang);
      await chrome.runtime.sendMessage({
        target: "background",
        type: "SAVE_RECORDING_BLOB",
        blobId,
        filename: `ScreenRec/ScreenRec-${stamp}.${ext}`,
        mode
      });
    } else {
      await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED" });
    }
  } finally {
    await chrome.storage.session.remove(["pendingRect", "pendingRectDpr", "pendingRectViewportW", "pendingRectViewportH", "pendingRectTabId"]);
    setTimeout(() => window.close(), 1200);
  }
}

stopBtn.addEventListener("click", finalize);
cancelBtn.addEventListener("click", async () => {
  finished = true;
  clearInterval(timerHandle);
  if (cropRAF) cancelAnimationFrame(cropRAF);
  if (recorder && recorder.state !== "inactive") {
    chunks = []; // discard
    recorder.onstop = async () => {
      await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED" });
      window.close();
    };
    recorder.stop();
  } else {
    await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED" });
    window.close();
  }
  (displayStream && displayStream.getTracks() || []).forEach((tr) => tr.stop());
});

// Allow the background script to ask us to stop (e.g. via hotkey).
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "RECORDER_STOP_REQUEST") {
    finalize();
    sendResponse({ ok: true });
  }
});

init();
