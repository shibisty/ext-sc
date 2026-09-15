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

import { storeBlobRecord } from "./lib/blob-db.js";
import {
  pickSupportedMimeTypeInBrowser,
  pickSupportedVideoOnlyMimeTypeInBrowser,
  extensionForMimeType,
  getVideoBitrate,
  getPreferredVideoFormat,
} from "./lib/video-format.js";
import { timestampName } from "./lib/timestamp.js";
import { mixInMicrophone, mixAudioTracks, stopMicMix, type MicMixResult } from "./lib/audio-mix.js";

type RecordingMode = "tab" | "area" | "screen";

interface CropStream extends MediaStream {
  __stopCropLoop?: () => void;
}

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let activeStream: CropStream | MediaStream | null = null; // the stream actually fed to MediaRecorder
let rawInputStream: MediaStream | null = null; // original (uncropped) stream, kept to stop tracks
let cropTimer: ReturnType<typeof setTimeout> | null = null;
let relayPC: RTCPeerConnection | null = null;
let currentMode: RecordingMode = "tab"; // for activity-log labeling
let currentMimeType = "video/webm";
let audioMonitorEl: HTMLAudioElement | null = null; // plays captured tab audio back so it isn't silenced locally
// Set by either audio path below (direct tabCapture mixing, or the relay
// path's own mixing of two already-relayed tracks) whenever real mixing
// happened, so onRecorderStopped()'s cleanup can release it — see
// audio-mix.ts's header comment for why this lives here (a page that
// persists for the whole recording) rather than in app.ts.
let activeMicMix: MicMixResult | null = null;
// Only populated when real mixing actually replaced a stream's original
// tab-audio track(s) with a new AudioContext-produced one (see
// startTabCapture() below): those original tracks are intentionally kept
// alive (not stopped) while mixing is still using them, then stopped here
// once the recording actually ends — stopping them earlier would silence
// half of the mix mid-recording.
let detachedTabAudioTracks: MediaStreamTrack[] = [];
// Area-mode recordings can occasionally lose video for a stretch while
// audio keeps recording — genuine stalls in this offscreen document's
// drawFrame() loop below (e.g. from OS-level CPU starvation), not a bug in
// the crop math itself. There's no way to make a background JS timer
// immune to the system being starved of CPU, but like cropDebugTag
// elsewhere in this codebase, this can at least be made self-diagnosing:
// any gap between consecutive drawFrame() calls far larger than the
// requested draw interval is recorded and, if it happened at all, appended
// to the saved filename, so a report like this is instantly diagnosable
// from the filename alone — no re-upload/ffprobe/back-and-forth needed to
// confirm it's the same phenomenon again.
let cropStallTag = "";

function send(type: string, payload: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ target: "background", type, ...payload }).catch(() => {});
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function buildCroppedStream(
  sourceStream: MediaStream,
  rect: Rect,
  dpr: number,
  viewportWidth: number | undefined,
  viewportHeight: number | undefined
): Promise<CropStream> {
  cropStallTag = ""; // reset per recording — see its declaration above
  const sourceVideo = document.getElementById("hiddenVideo") as HTMLVideoElement;
  sourceVideo.srcObject = sourceStream;
  await sourceVideo.play().catch(() => {});
  await new Promise<void>((resolve) => {
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

  // Every area-mode recording draws the raw captured frame into a canvas
  // and re-encodes it via canvas.captureStream() every frame — GPU
  // compositing + encode work that scales directly with the canvas's
  // pixel count times how often it's redrawn per second, on top of
  // decoding the raw incoming chrome.tabCapture stream itself. A large
  // selection at full native resolution and a high frame rate can push
  // this past what a system's GPU can sustain, leading to stalls, a driver
  // reset (a monitor blanking out momentarily is a classic symptom on
  // Windows), or even a full renderer crash.
  //
  // Rather than force a fixed resolution/frame-rate pair, this bounds
  // total throughput (pixels drawn+encoded per second) against a budget
  // and lets resolution and frame rate trade off against each other:
  // TARGET_PIXELS_PER_SECOND is a reasoned, evidence-based throughput
  // ceiling (1920×1080 @ 30fps) — fps is solved for whatever resolution is
  // actually being recorded, so a small area gets up to MAX_FPS, and area
  // size alone doesn't force a resolution cut. MAX_CROP_OUTPUT_PIXELS is
  // set to a full 4K frame so a true 4K selection still records at native
  // resolution (at a low, but not floor-clamped, fps) — it only engages as
  // a last-resort safety net beyond that (e.g. an ultra-wide multi-monitor
  // selection), where even MIN_FPS alone could no longer keep total
  // throughput inside budget. cropW/cropH below (the SOURCE region
  // actually sampled from sourceVideo) are computed from the uncapped
  // outW/outH regardless, so a large selection still records everything
  // inside it.
  const TARGET_PIXELS_PER_SECOND = 1920 * 1080 * 30;
  const MAX_CROP_OUTPUT_PIXELS = 3840 * 2160; // full 4K — a safety ceiling, not the normal case
  const MIN_FPS = 5;
  const MAX_FPS = 30;
  const rawPixels = outW * outH;
  const cropDownscale = rawPixels > MAX_CROP_OUTPUT_PIXELS ? Math.sqrt(MAX_CROP_OUTPUT_PIXELS / rawPixels) : 1;
  const canvasW = Math.max(2, Math.round(outW * cropDownscale));
  const canvasH = Math.max(2, Math.round(outH * cropDownscale));
  const canvasPixels = canvasW * canvasH;
  const captureFps = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(TARGET_PIXELS_PER_SECOND / canvasPixels)));
  const canvas = document.createElement("canvas");
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  // Logged once per recording so a report can say what was actually
  // chosen — resolution and fps both vary with area size now, rather than
  // being fixed.
  console.log(`ScreenRec: area crop recording at ${canvasW}x${canvasH} @ ${captureFps}fps (requested ${outW}x${outH})`);

  const sx = Math.round(rect.x * scaleX);
  const sy = Math.round(rect.y * scaleY);

  let stopped = false;
  const FRAME_INTERVAL_MS = Math.round(1000 / captureFps);
  // See cropStallTag's declaration above for why this exists. A gap this
  // far past the requested draw interval is well outside normal
  // GC/scheduler jitter (typically low single-digit ms) and means
  // something genuinely stalled this loop, not just ran a little behind.
  const STALL_THRESHOLD_MS = 500;
  let lastDrawAt = performance.now();
  let stallCount = 0;
  let maxStallMs = 0;
  let totalStallMs = 0;

  // A loop that stops running entirely can never notice its own silence —
  // there's no "next call" inside it to compute a gap from — so this
  // watchdog runs independently, on its own timer, and checks two
  // different things. First, whether this loop's own JS stopped executing
  // at all (lastDrawAt going stale): a requestVideoFrameCallback-driven
  // version of this loop was tried and found to stop firing for good in
  // this offscreen document, which is why a plain setTimeout drives it
  // instead. Second, once past that, whether sourceVideo's own playback
  // position has stopped advancing even though this loop is still calling
  // drawOnce() on schedule — proof the freeze sits upstream of this loop
  // entirely, most likely in chrome.tabCapture's own delivery into
  // sourceVideo, which no amount of rescheduling here can fix. Telling
  // these two apart (via sourceVideo.currentTime) turns "something froze"
  // into a specific, actionable diagnosis, saved directly in the
  // recording's filename.
  //
  // Threshold and polling interval are both kept low so even a short gap
  // is caught well before a typical recording ends.
  const DEAD_LOOP_THRESHOLD_MS = 1200;
  let deadLoopWarned = false;
  let lastVideoCurrentTime = sourceVideo.currentTime;
  let lastVideoTimeChangeAt = performance.now();
  const watchdogTimer = setInterval(() => {
    if (stopped || deadLoopWarned) return;
    const now = performance.now();
    const drawSilence = now - lastDrawAt;
    if (drawSilence > DEAD_LOOP_THRESHOLD_MS) {
      // The loop's own JS stopped executing — recordStallIfAny() hasn't
      // touched lastDrawAt in a while, so nothing inside the loop could
      // ever have noticed this itself (see the comment above).
      deadLoopWarned = true;
      console.error(`ScreenRec: crop draw loop appears to have stopped entirely (no draw in ${Math.round(drawSilence)}ms)`);
      cropStallTag = `deadloop_after${Math.round(drawSilence)}ms`;
      return;
    }
    // The loop IS still calling drawOnce() on schedule — check whether
    // sourceVideo actually has new frames to draw. readyState is included
    // in the tag since it's the standard signal for *why* a video element
    // isn't advancing (2=HAVE_CURRENT_DATA/stalled-but-has-a-frame,
    // 0-1=nothing usable at all).
    if (sourceVideo.currentTime !== lastVideoCurrentTime) {
      lastVideoCurrentTime = sourceVideo.currentTime;
      lastVideoTimeChangeAt = now;
    } else if (now - lastVideoTimeChangeAt > DEAD_LOOP_THRESHOLD_MS) {
      deadLoopWarned = true;
      console.error(`ScreenRec: sourceVideo stopped advancing (readyState=${sourceVideo.readyState}) even though the draw loop is still running — the freeze is upstream of this extension's own code`);
      cropStallTag = `srcfrozen_after${Math.round(now - lastVideoTimeChangeAt)}ms_rs${sourceVideo.readyState}`;
    }
  }, 400);

  function recordStallIfAny(): void {
    const now = performance.now();
    const gap = now - lastDrawAt;
    lastDrawAt = now;
    if (gap > STALL_THRESHOLD_MS) {
      stallCount++;
      maxStallMs = Math.max(maxStallMs, gap);
      totalStallMs += gap;
      console.warn(`ScreenRec: crop draw loop stalled for ${Math.round(gap)}ms (stall #${stallCount})`);
      cropStallTag = `stall-n${stallCount}_max${Math.round(maxStallMs)}ms_sum${Math.round(totalStallMs)}ms`;
    }
  }

  function drawOnce(): void {
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
      // This crop used to ALSO draw a separately-transmitted PNG snapshot
      // of annotate-overlay.js's on-page drawing/GIF canvas on top of this
      // frame (`annotationImg`, fed by the ANNOTATION_FRAME message
      // below). That was redundant: `sourceVideo` is chrome.tabCapture's
      // raw capture of the tab's actual rendered pixels, which already
      // includes that canvas live (it's a real, visible, on-page
      // `position: fixed` element covering exactly this rect for the whole
      // recording) — cropping it here already carries strokes/GIF frames
      // through with zero extra latency. Drawing a SECOND,
      // separately-transmitted copy on top — one that lagged behind the
      // live capture by however long its own encode+relay took — is what
      // caused the GIF being visible in two states at once: whenever that
      // lag still had the previous exported frame decoding/painting while
      // the native layer underneath had already moved on, both painted
      // simultaneously. See annotate-overlay.ts's sendSnapshotNow() for
      // the matching half of this fix (now a no-op, nothing sends
      // ANNOTATION_FRAME anymore).
      // Destination size is the (possibly downscaled, see cropDownscale
      // above) canvas size, not outW/outH — outW/outH here only bound how
      // much of the SOURCE to sample.
      ctx.drawImage(sourceVideo, cropX, cropY, cropW, cropH, 0, 0, canvasW, canvasH);
    } catch (err) {
      console.error("ScreenRec: crop draw error", err);
    }
  }

  function timerLoop(): void {
    if (stopped) return;
    recordStallIfAny();
    drawOnce();
    cropTimer = setTimeout(timerLoop, FRAME_INTERVAL_MS);
  }

  drawOnce(); // paint whatever's already on sourceVideo immediately, don't wait for the first tick
  cropTimer = setTimeout(timerLoop, FRAME_INTERVAL_MS);

  const canvasStream = canvas.captureStream(captureFps) as CropStream; // matches FRAME_INTERVAL_MS above, both derived from captureFps
  sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  canvasStream.__stopCropLoop = () => {
    stopped = true;
    if (cropTimer) clearTimeout(cropTimer);
    clearInterval(watchdogTimer);
  };
  return canvasStream;
}

interface BeginRecordingOptions {
  rect?: Rect | null;
  dpr?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

async function beginRecording(stream: MediaStream, { rect, dpr, viewportWidth, viewportHeight }: BeginRecordingOptions): Promise<void> {
  try {
    rawInputStream = stream;
    if (rect) {
      activeStream = await buildCroppedStream(stream, rect, dpr || 1, viewportWidth, viewportHeight);
    } else {
      activeStream = stream;
    }

    // Checks whether the stream actually ended up with a live audio track
    // before picking a mimeType that names an audio codec — a mimeType
    // naming an audio codec against a stream with no real live audio can
    // make the resulting file silent even though the video itself records
    // correctly, indistinguishable from a successful recording that simply
    // captured no sound. See video-format.ts's WEBM_VIDEO_ONLY_CANDIDATES
    // comment and recorder.ts's equivalent check for the same fix applied
    // to the getDisplayMedia() path.
    const liveAudioTracks = activeStream.getAudioTracks().filter((tr) => tr.readyState === "live");
    const hasLiveAudio = liveAudioTracks.length > 0;
    const preferredFormat = await getPreferredVideoFormat();
    const mimeType = hasLiveAudio
      ? pickSupportedMimeTypeInBrowser(preferredFormat === "mp4")
      : pickSupportedVideoOnlyMimeTypeInBrowser(preferredFormat === "mp4");
    currentMimeType = mimeType || "video/webm";
    const recorderOptions: MediaRecorderOptions = mimeType ? { mimeType } : {};
    const bitrate = await getVideoBitrate();
    if (bitrate) recorderOptions.videoBitsPerSecond = bitrate;

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(activeStream, recorderOptions);
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onerror = (event) => {
      console.error("ScreenRec: MediaRecorder error", (event as unknown as { error?: unknown }).error || event);
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
    const message = e instanceof Error ? e.message : String(e);
    send("OFFSCREEN_RECORDING_ERROR", { detail: message });
  }
}

function stopRecording(): void {
  if (cropTimer) clearTimeout(cropTimer);
  const cropStream = activeStream as CropStream | null;
  if (cropStream && cropStream.__stopCropLoop) cropStream.__stopCropLoop();
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
  try {
    mediaRecorder.requestData();
  } catch {
    /* some UAs disallow this right before stop() — harmless */
  }
  mediaRecorder.stop();
}

async function onRecorderStopped(): Promise<void> {
  try {
    const totalSize = recordedChunks.reduce((sum, c) => sum + c.size, 0);
    if (recordedChunks.length > 0 && totalSize > 0) {
      const ext = extensionForMimeType(currentMimeType);
      const blob = new Blob(recordedChunks, { type: currentMimeType });
      const blobId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // Handing the raw Blob to background.js via IndexedDB (not through
      // runtime.sendMessage, which caps out at 64MiB and would fail on any
      // recording more than a few minutes long).
      await storeBlobRecord(blobId, { blob, createdAt: Date.now() });
      // Mirrors recorder.ts's cropDebugTag: only area-mode recordings can
      // stall this way (see cropStallTag's declaration), and only when a
      // stall actually happened this recording — leaves every other
      // filename exactly as before.
      const baseFilename = timestampName(ext, new Date(), "ScreenRec-");
      const filename =
        currentMode === "area" && cropStallTag
          ? baseFilename.replace(new RegExp(`\\.${ext}$`), `_${cropStallTag}.${ext}`)
          : baseFilename;
      send("SAVE_RECORDING_BLOB", {
        blobId,
        filename,
        mode: currentMode,
      });
    } else {
      console.error("ScreenRec: no recorded data (chunks:", recordedChunks.length, "totalSize:", totalSize, ")");
      send("OFFSCREEN_RECORDING_ERROR", { detail: "no_data" });
    }
  } catch (e) {
    console.error("ScreenRec: save failed", e);
    const message = e instanceof Error ? e.message : String(e);
    send("OFFSCREEN_RECORDING_ERROR", { detail: message });
  } finally {
    (rawInputStream?.getTracks() || []).forEach((tr) => tr.stop());
    if (relayPC) {
      relayPC.close();
      relayPC = null;
    }
    stopAudioMonitor();
    // Release the mic-mixing graph (closes the AudioContext, stops the
    // getUserMedia() mic stream) and only THEN stop the original tab-audio
    // track(s) that were detached in favor of the mixed one — stopping
    // them any earlier would have silenced half the mix mid-recording.
    stopMicMix(activeMicMix);
    activeMicMix = null;
    detachedTabAudioTracks.forEach((t) => t.stop());
    detachedTabAudioTracks = [];
    mediaRecorder = null;
    recordedChunks = [];
    activeStream = null;
    rawInputStream = null;
  }
}

// ---------- Path 1: direct tab capture (no picker) ----------

interface StartTabCaptureMessage {
  streamId: string;
  audio?: boolean;
  rect?: Rect | null;
  dpr?: number;
  mode?: RecordingMode;
  viewportWidth?: number;
  viewportHeight?: number;
}

// Chrome's legacy `mandatory` getUserMedia constraint shape (chromeMediaSource)
// isn't part of the standard MediaTrackConstraints type, hence `any` here.
async function startTabCapture({ streamId, audio, rect, dpr, mode, viewportWidth, viewportHeight }: StartTabCaptureMessage): Promise<void> {
  currentMode = mode || (rect ? "area" : "tab");
  try {
    const videoConstraint: any = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
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
    const constraints: any = { video: videoConstraint };
    if (audio) {
      constraints.audio = {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      };
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (constraintErr) {
      if (videoConstraint.mandatory.minWidth) {
        // Exact resolution wasn't satisfiable — retry without pinning it
        // rather than failing the recording outright.
        //
        // Same getUserMedia()-throws-a-DOMException case as app.ts's
        // primeMicrophonePermission() and audio-mix.ts's
        // requestMicrophone(): DOMException isn't `instanceof Error`, and a
        // bare object console.error() argument prints "[object DOMException]"
        // once copy-pasted as plain text.
        const constraintDetail =
          constraintErr instanceof DOMException || constraintErr instanceof Error
            ? `${constraintErr.name}: ${constraintErr.message}`
            : String(constraintErr);
        console.error(`ScreenRec: exact-resolution capture failed, retrying unconstrained: ${constraintDetail}`);
        delete videoConstraint.mandatory.minWidth;
        delete videoConstraint.mandatory.maxWidth;
        delete videoConstraint.mandatory.minHeight;
        delete videoConstraint.mandatory.maxHeight;
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: constraints.audio });
      } else {
        throw constraintErr;
      }
    }
    // startAudioMonitor() plays back the ORIGINAL tab audio only (see its
    // own comment) — deliberately called before any mic-mixing below, so
    // the person hears the tab, never their own microphone looped back at
    // them (which would be an echo, not a monitor).
    startAudioMonitor(stream);
    // Mix the actual microphone into this recording (in addition to
    // whatever tab audio was already requested above) when audio was
    // asked for. Safe to do directly here — this offscreen document
    // persists for the whole recording, unlike app.ts's screen-mode relay
    // popup (see audio-mix.ts's header comment). Replaces the stream's own
    // audio track(s) with the single mixed one so MediaRecorder always
    // sees at most one audio track.
    if (audio) {
      const originalAudioTracks = stream.getAudioTracks();
      activeMicMix = await mixInMicrophone(originalAudioTracks);
      // mixAudioTracks() hands back the SAME track object (not a new
      // AudioContext-produced one) whenever only one source was actually
      // available (e.g. the mic was denied, so it fell back to the tab's
      // own track) — in that case there's nothing to swap or detach.
      // Only real mixing needs the original track(s) pulled off the stream
      // and kept alive separately for detachedTabAudioTracks to release later.
      if (activeMicMix.track && activeMicMix.track !== originalAudioTracks[0]) {
        originalAudioTracks.forEach((t) => stream.removeTrack(t));
        stream.addTrack(activeMicMix.track);
        detachedTabAudioTracks = originalAudioTracks;
      }
    }
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
function startAudioMonitor(stream: MediaStream): void {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) return;
  stopAudioMonitor();
  audioMonitorEl = document.createElement("audio");
  audioMonitorEl.autoplay = true;
  audioMonitorEl.srcObject = new MediaStream(audioTracks);
  document.body.appendChild(audioMonitorEl);
  audioMonitorEl.play().catch((e) => console.error("ScreenRec: audio monitor playback failed", e));
}

function stopAudioMonitor(): void {
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

async function handleRelayOffer({ sdp, withAudio }: { sdp: RTCSessionDescriptionInit; withAudio?: boolean }): Promise<void> {
  currentMode = "screen";
  relayPC = new RTCPeerConnection();
  const remoteStream = new MediaStream();

  relayPC.ontrack = (event) => {
    remoteStream.addTrack(event.track);
  };

  relayPC.onicecandidate = (event) => {
    if (event.candidate) {
      chrome.runtime
        .sendMessage({
          target: "popup",
          type: "RELAY_ICE",
          candidate: event.candidate,
        })
        .catch(() => {});
    }
  };

  await relayPC.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await relayPC.createAnswer();
  await relayPC.setLocalDescription(answer);

  chrome.runtime
    .sendMessage({
      target: "popup",
      type: "RELAY_ANSWER",
      sdp: relayPC.localDescription,
    })
    .catch(() => {});

  // Wait briefly for tracks to actually attach before starting the recorder.
  await new Promise<void>((resolve) => {
    const check = () => {
      if (remoteStream.getVideoTracks().length > 0) resolve();
      else setTimeout(check, 100);
    };
    check();
    setTimeout(resolve, 3000); // safety timeout
  });

  // app.ts's relay popup can add up to two independent audio tracks onto
  // the same RTCPeerConnection when mic mixing is wanted (the display/tab
  // audio from getDisplayMedia()'s own share-audio checkbox, and a raw
  // microphone track — see app.ts's startScreenRecordingWithRelay()). Both
  // land on the same ontrack handler above and arrival order isn't
  // guaranteed, so give a second audio track a short extra window to
  // attach after the video track resolves, then mix whatever actually
  // showed up.
  if (withAudio) {
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (remoteStream.getAudioTracks().length >= 2 || Date.now() - start > 1000) resolve();
        else setTimeout(check, 100);
      };
      check();
    });
  }
  const relayedAudioTracks = remoteStream.getAudioTracks();
  if (relayedAudioTracks.length >= 2) {
    const { track, audioContext } = mixAudioTracks(relayedAudioTracks[0], relayedAudioTracks[1]);
    if (track && track !== relayedAudioTracks[0]) {
      relayedAudioTracks.forEach((t) => remoteStream.removeTrack(t));
      remoteStream.addTrack(track);
      activeMicMix = { track, audioContext, micStream: null };
      detachedTabAudioTracks = relayedAudioTracks;
    }
  }

  await beginRecording(remoteStream, { rect: null, dpr: 1 });
}

async function handleRelayIce({ candidate }: { candidate?: RTCIceCandidateInit }): Promise<void> {
  if (relayPC && candidate) {
    try {
      await relayPC.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error(e);
    }
  }
}

// ---------- Message wiring ----------
//
// NOTE: clipboard writes used to be relayed here (reason "CLIPBOARD") and
// done via navigator.clipboard.write(). That never actually worked: an
// offscreen document can never hold OS focus, and Chromium's Async
// Clipboard API requires focus (confirmed via crbug.com/40252021, still
// open) — every call failed with "Document is not focused". Clipboard
// copying is now handled in background.ts instead: directly via
// browser.clipboard.setImageData() on Firefox, or by injecting a small
// script into the source tab on Chrome. See background.ts's "Clipboard"
// section for the full explanation.

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
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
    // ANNOTATION_FRAME removed: annotate-overlay.ts no longer sends it
    // (see its sendSnapshotNow(), now a no-op) now that the crop in
    // buildCroppedStream() above relies solely on the native tab capture,
    // which already includes that canvas live. An unrecognized message
    // type here is harmless (the switch just falls through).
  }
  sendResponse({ ok: true });
  return false;
});
