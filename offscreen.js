// Runs inside the hidden offscreen document. This is the actual recording
// engine: it owns the MediaRecorder and keeps running after the popup or
// side panel that started the recording has been closed.
//
// Two ways media can arrive here:
//   1) "tab" / "area" modes: background calls chrome.tabCapture.getMediaStreamId
//      for the current tab and sends us the streamId directly (no OS picker,
//      no popup needed at all after this point).
//   2) "screen" mode: getDisplayMedia() must run in a visible, user-activated
//      page (the popup/side panel), since browsers refuse to show the share
//      picker from a hidden document. The popup grabs the stream, then
//      relays it to us over a local WebRTC loopback connection (a common
//      pattern for MV3 extensions) so recording survives the popup closing.

let mediaRecorder = null;
let recordedChunks = [];
let activeStream = null; // the stream actually fed to MediaRecorder
let rawInputStream = null; // original (uncropped) stream, kept to stop tracks
let cropTimer = null;
let relayPC = null;
let currentMode = "tab"; // "tab" | "area" | "screen" — for activity-log labeling
let currentMimeType = "video/webm";
let audioMonitorEl = null; // plays captured tab audio back so it isn't silenced locally
let annotationImg = null; // live drawing/text overlay from annotate-overlay.js, composited each frame
let hasAnnotation = false;

function send(type, payload) {
  chrome.runtime.sendMessage({ target: "background", type, ...payload }).catch(() => {});
}

// ---------- Large-blob transfer (IndexedDB) ----------
// See background.js for the full explanation: chrome.runtime.sendMessage
// caps out at 64MiB, which a longer recording's data easily exceeds. We
// store the finished Blob directly in IndexedDB (shared origin with the
// service worker) and send only a small key through messaging.

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

async function blobToDataURL(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

const WEBM_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const MP4_CANDIDATES = ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "video/mp4;codecs=h264,aac", "video/mp4"];

function pickSupportedMimeType(preferMp4) {
  const ordered = preferMp4 ? [...MP4_CANDIDATES, ...WEBM_CANDIDATES] : [...WEBM_CANDIDATES, ...MP4_CANDIDATES];
  for (const c of ordered) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function extensionForMimeType(mimeType) {
  return mimeType && mimeType.includes("mp4") ? "mp4" : "webm";
}

const QUALITY_BITRATES = {
  low: 1_000_000,
  medium: 2_500_000,
  high: 6_000_000
  // "auto" (or anything else) → no explicit bitrate, browser default
};

async function getVideoBitrate() {
  try {
    const { videoQuality = "auto" } = await chrome.storage.local.get(["videoQuality"]);
    return QUALITY_BITRATES[videoQuality] || null;
  } catch (e) {
    return null;
  }
}

async function getPreferredVideoFormat() {
  try {
    const { videoFormat = "webm" } = await chrome.storage.local.get(["videoFormat"]);
    return videoFormat;
  } catch (e) {
    return "webm";
  }
}

async function buildCroppedStream(sourceStream, rect, dpr, viewportWidth, viewportHeight) {
  hasAnnotation = false;
  annotationImg = null;

  const sourceVideo = document.getElementById("hiddenVideo");
  sourceVideo.srcObject = sourceStream;
  await sourceVideo.play().catch(() => {});
  await new Promise((resolve) => {
    if (sourceVideo.readyState >= 2) resolve();
    else sourceVideo.onloadedmetadata = () => resolve();
  });

  const videoW = sourceVideo.videoWidth || Math.round((viewportWidth || rect.width) * dpr);
  const videoH = sourceVideo.videoHeight || Math.round((viewportHeight || rect.height) * dpr);

  // Prefer a scale factor derived from the ACTUAL captured pixel size vs the
  // CSS viewport size measured at selection time, rather than assuming the
  // capture is exactly `cssPixels * devicePixelRatio` — tabCapture doesn't
  // always guarantee that exact relationship, which was causing the
  // selection box and the recorded video to be slightly misaligned/scaled.
  const scaleX = viewportWidth ? videoW / viewportWidth : dpr;
  const scaleY = viewportHeight ? videoH / viewportHeight : dpr;

  const outW = Math.max(2, Math.round(rect.width * scaleX));
  const outH = Math.max(2, Math.round(rect.height * scaleY));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");

  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);

  let stopped = false;
  let framesDrawn = 0;
  const FRAME_INTERVAL_MS = 16; // ~60fps
  function drawFrame() {
    if (stopped) return;
    try {
      const vw = sourceVideo.videoWidth || videoW;
      const vh = sourceVideo.videoHeight || videoH;
      // Clamp so the source rectangle passed to drawImage is always >= 1px
      // in both dimensions — a zero/negative source size throws
      // IndexSizeError, which (before this fix) silently killed the whole
      // loop since the exception happened before the next frame was
      // scheduled.
      const cropX = Math.min(Math.max(0, sx), Math.max(0, vw - 1));
      const cropY = Math.min(Math.max(0, sy), Math.max(0, vh - 1));
      const cropW = Math.max(1, Math.min(outW, vw - cropX));
      const cropH = Math.max(1, Math.min(outH, vh - cropY));
      ctx.drawImage(sourceVideo, cropX, cropY, cropW, cropH, 0, 0, outW, outH);
      if (hasAnnotation && annotationImg && annotationImg.complete && annotationImg.naturalWidth > 0) {
        ctx.drawImage(annotationImg, 0, 0, outW, outH);
      }
      framesDrawn++;
    } catch (err) {
      console.error("ScreenRec: crop draw error", err);
    }
    cropTimer = setTimeout(drawFrame, FRAME_INTERVAL_MS);
  }
  drawFrame();

  const canvasStream = canvas.captureStream(60);
  sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  canvasStream.__stopCropLoop = () => { stopped = true; if (cropTimer) clearTimeout(cropTimer); };
  return canvasStream;
}

async function beginRecording(stream, { rect, dpr, viewportWidth, viewportHeight }) {
  try {
    rawInputStream = stream;
    if (rect) {
      activeStream = await buildCroppedStream(stream, rect, dpr || 1, viewportWidth, viewportHeight);
    } else {
      activeStream = stream;
    }

    const preferredFormat = await getPreferredVideoFormat();
    const mimeType = pickSupportedMimeType(preferredFormat === "mp4");
    currentMimeType = mimeType || "video/webm";
    const recorderOptions = mimeType ? { mimeType } : {};
    const bitrate = await getVideoBitrate();
    if (bitrate) recorderOptions.videoBitsPerSecond = bitrate;

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(activeStream, recorderOptions);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (event) => {
      console.error("ScreenRec: MediaRecorder error", event.error || event);
    };
    mediaRecorder.onstop = onRecorderStopped;
    mediaRecorder.start(1000);

    // If the user stops sharing from the browser's own "Stop sharing" bar,
    // wrap up gracefully instead of leaving a dangling recorder.
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.addEventListener("ended", () => stopRecording());

    send("OFFSCREEN_RECORDING_STARTED", {});
  } catch (e) {
    console.error("ScreenRec: beginRecording failed", e);
    send("OFFSCREEN_RECORDING_ERROR", { detail: String(e && e.message || e) });
  }
}

function stopRecording() {
  if (cropTimer) clearTimeout(cropTimer);
  if (activeStream && activeStream.__stopCropLoop) activeStream.__stopCropLoop();
  if (!mediaRecorder) {
    // Never actually started (e.g. beginRecording failed before creating
    // the recorder) — nothing to finalize.
    send("OFFSCREEN_RECORDING_ERROR", { detail: "not_recording" });
    return;
  }
  if (mediaRecorder.state === "inactive") {
    // Already stopped/stopping — MediaRecorder.state flips to "inactive"
    // SYNCHRONOUSLY inside stop(), well before the async 'stop' event (and
    // its guaranteed final 'dataavailable') actually fires. If something
    // calls stopRecording() again in that window — e.g. the user clicking
    // Stop right as the browser's own "Stop sharing" control also fires —
    // the old code path called onRecorderStopped() directly here, racing
    // the real completion handler and packaging an incomplete chunk list
    // into the saved file. onstop is now the only thing allowed to finalize
    // a recording, so we just do nothing and let it run exactly once.
    return;
  }
  try { mediaRecorder.requestData(); } catch (e) { /* some UAs disallow this right before stop() — harmless */ }
  mediaRecorder.stop();
}

async function onRecorderStopped() {
  try {
    const totalSize = recordedChunks.reduce((sum, c) => sum + c.size, 0);
    if (recordedChunks.length > 0 && totalSize > 0) {
      const ext = extensionForMimeType(currentMimeType);
      const blob = new Blob(recordedChunks, { type: currentMimeType });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      const blobId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Handing the raw Blob to background.js via IndexedDB (not through
      // runtime.sendMessage, which caps out at 64MiB and would fail on any
      // recording more than a few minutes long).
      await storeBlobRecord(blobId, { blob, createdAt: Date.now() });
      send("SAVE_RECORDING_BLOB", {
        blobId,
        filename: `ScreenRec/ScreenRec-${stamp}.${ext}`,
        mode: currentMode
      });
    } else {
      console.error("ScreenRec: no recorded data (chunks:", recordedChunks.length, "totalSize:", totalSize, ")");
      send("OFFSCREEN_RECORDING_ERROR", { detail: "no_data" });
    }
  } catch (e) {
    console.error("ScreenRec: save failed", e);
    send("OFFSCREEN_RECORDING_ERROR", { detail: String(e && e.message || e) });
  } finally {
    (rawInputStream && rawInputStream.getTracks() || []).forEach((tr) => tr.stop());
    if (relayPC) { relayPC.close(); relayPC = null; }
    stopAudioMonitor();
    mediaRecorder = null;
    recordedChunks = [];
    activeStream = null;
    rawInputStream = null;
  }
}

// ---------- Path 1: direct tab capture (no picker) ----------

async function startTabCapture({ streamId, audio, rect, dpr, mode, viewportWidth, viewportHeight }) {
  currentMode = mode || (rect ? "area" : "tab");
  try {
    const videoConstraint = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    };
    // Pin the capture to the tab's exact physical pixel size. Without this,
    // Chrome can choose its own default resolution/aspect ratio for the
    // tabCapture stream and pad (letterbox) the frame to fit it — which
    // showed up as the same amount of extra pixels being captured at both
    // the top and bottom of the recorded video.
    if (viewportWidth && viewportHeight) {
      const exactW = Math.round(viewportWidth * (dpr || 1));
      const exactH = Math.round(viewportHeight * (dpr || 1));
      videoConstraint.mandatory.minWidth = exactW;
      videoConstraint.mandatory.maxWidth = exactW;
      videoConstraint.mandatory.minHeight = exactH;
      videoConstraint.mandatory.maxHeight = exactH;
    }
    const constraints = { video: videoConstraint };
    if (audio) {
      constraints.audio = {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (constraintErr) {
      if (videoConstraint.mandatory.minWidth) {
        // Exact resolution wasn't satisfiable — retry without pinning it
        // rather than failing the recording outright.
        console.error("ScreenRec: exact-resolution capture failed, retrying unconstrained", constraintErr);
        delete videoConstraint.mandatory.minWidth;
        delete videoConstraint.mandatory.maxWidth;
        delete videoConstraint.mandatory.minHeight;
        delete videoConstraint.mandatory.maxHeight;
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: constraints.audio });
      } else {
        throw constraintErr;
      }
    }
    startAudioMonitor(stream);
    await beginRecording(stream, { rect, dpr, viewportWidth, viewportHeight });
  } catch (e) {
    console.error(e);
    send("OFFSCREEN_RECORDING_ERROR", {});
  }
}

// Capturing a tab's audio via chromeMediaSource "tab" redirects that audio
// into our stream and silences it for the user — the sound is still present
// in the final recording, but the person can no longer hear it live while
// recording, which is confusing. Play it back through a hidden <audio>
// element so it keeps reaching the speakers during recording too.
function startAudioMonitor(stream) {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return;
  stopAudioMonitor();
  audioMonitorEl = document.createElement("audio");
  audioMonitorEl.autoplay = true;
  audioMonitorEl.srcObject = new MediaStream(audioTracks);
  document.body.appendChild(audioMonitorEl);
  audioMonitorEl.play().catch((e) => console.error("ScreenRec: audio monitor playback failed", e));
}

function stopAudioMonitor() {
  if (audioMonitorEl) {
    audioMonitorEl.pause();
    audioMonitorEl.srcObject = null;
    audioMonitorEl.remove();
    audioMonitorEl = null;
  }
}

// ---------- Path 2: WebRTC relay from popup (screen/window/full-desktop) ----------
// The popup owns the getDisplayMedia() stream (it must, for the OS picker to
// appear) and relays it here over a local loopback WebRTC connection so
// recording continues after the popup window closes.

async function handleRelayOffer({ sdp, withAudio }) {
  currentMode = "screen";
  relayPC = new RTCPeerConnection();
  const remoteTracks = [];
  const remoteStream = new MediaStream();

  relayPC.ontrack = (event) => {
    remoteStream.addTrack(event.track);
    remoteTracks.push(event.track);
  };

  relayPC.onicecandidate = (event) => {
    if (event.candidate) {
      chrome.runtime.sendMessage({
        target: "popup",
        type: "RELAY_ICE",
        candidate: event.candidate
      }).catch(() => {});
    }
  };

  await relayPC.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await relayPC.createAnswer();
  await relayPC.setLocalDescription(answer);

  chrome.runtime.sendMessage({
    target: "popup",
    type: "RELAY_ANSWER",
    sdp: relayPC.localDescription
  }).catch(() => {});

  // Wait briefly for tracks to actually attach before starting the recorder.
  await new Promise((resolve) => {
    const check = () => {
      if (remoteStream.getVideoTracks().length > 0) resolve();
      else setTimeout(check, 100);
    };
    check();
    setTimeout(resolve, 3000); // safety timeout
  });

  await beginRecording(remoteStream, { rect: null, dpr: 1 });
}

async function handleRelayIce({ candidate }) {
  if (relayPC && candidate) {
    try {
      await relayPC.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error(e);
    }
  }
}

// ---------- Clipboard: copy a screenshot (data URL) to the OS clipboard ----------
// This is the officially documented pattern for MV3 service workers, which
// have no DOM and therefore no clipboard access of their own: create an
// offscreen document with reason "CLIPBOARD" and call
// navigator.clipboard.write() from there instead.

async function copyImageToClipboard(dataUrl) {
  try {
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    send("CLIPBOARD_COPY_RESULT", { ok: true });
  } catch (e) {
    console.error("ScreenRec: clipboard copy failed", e);
    send("CLIPBOARD_COPY_RESULT", { ok: false, detail: String(e && e.message || e) });
  }
}

// ---------- Message wiring ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== "offscreen") return;
  switch (message.type) {
    case "START_TAB_CAPTURE":
      startTabCapture(message);
      break;
    case "RELAY_OFFER":
      handleRelayOffer(message);
      break;
    case "RELAY_ICE":
      handleRelayIce(message);
      break;
    case "STOP_RECORDING":
      stopRecording();
      break;
    case "COPY_IMAGE_TO_CLIPBOARD":
      copyImageToClipboard(message.dataUrl);
      break;
    case "ANNOTATION_FRAME":
      if (!annotationImg) annotationImg = new Image();
      annotationImg.src = message.dataUrl;
      hasAnnotation = true;
      break;
  }
  sendResponse({ ok: true });
  return false;
});
