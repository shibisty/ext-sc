// Runs inside recorder.html (an extension popup window). Handles the actual
// screen/tab capture, optional cropping to a previously selected area, and
// saving the resulting webm file. This is the Firefox fallback path (no
// chrome.offscreen support there) — see ARCHITECTURE.md.

import { resolveLang, applyI18n, applyTheme, applyDirection, t, SettingsStore } from "./i18n.js";
import { storeBlobRecord } from "./lib/blob-db.js";
import {
  pickSupportedMimeTypeInBrowser,
  pickSupportedVideoOnlyMimeTypeInBrowser,
  extensionForMimeType,
  QUALITY_BITRATES,
  type VideoQuality,
} from "./lib/video-format.js";
import { timestampName } from "./lib/timestamp.js";
import { mixInMicrophone, stopMicMix, type MicMixResult } from "./lib/audio-mix.js";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const params = new URLSearchParams(location.search);
const mode = params.get("mode") || "full"; // "full" | "area"
const wantAudio = params.get("audio") === "1";

const dotEl = document.getElementById("dot") as HTMLElement;
const timeEl = document.getElementById("time") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const areaWarnEl = document.getElementById("areaWarn") as HTMLElement | null;
const audioCheckEl = document.getElementById("audioCheck") as HTMLElement | null;
const tabAudioCheckEl = document.getElementById("tabAudioCheck") as HTMLElement | null;
const previewEl = document.getElementById("preview") as HTMLVideoElement;
const startBtn = document.getElementById("startBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const cancelBtn = document.getElementById("cancelBtn") as HTMLButtonElement;

let lang = resolveLang("auto");
let displayStream: MediaStream | null = null;
let recordStream: MediaStream | null = null; // stream actually fed into MediaRecorder
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let finished = false;
let currentMimeType = "video/webm";
let recorderStartedOk = false; // true once recorder.start() has actually run
// A real microphone mix needs its own AudioContext; this popup window
// persists for the whole recording (unlike app.ts's screen-mode relay
// popup), so it can safely own that AudioContext — see audio-mix.ts's
// header comment. Populated in beginSharing() below, released in
// onRecorderStopped()'s cleanup.
let activeMicMix: MicMixResult | null = null;
let detachedTabAudioTracks: MediaStreamTrack[] = [];
let recorderStartMs = 0; // Date.now() at recorder.start() — used only for the elapsed-time diagnostics below
let frameProbeHandle: ReturnType<typeof setInterval> | null = null;
let recorderSetupError: unknown = null; // set by recorder.onerror, read by onRecorderStopped
let recorderStopHandled = false; // idempotency guard — see finalize()'s grace-period fallback
let cancelHandled = false; // same idea, for the cancel-button path below
// Pixel rect (within the RAW recorded video's own resolution) to crop to
// after recording stops, computed once at start-of-recording time (see
// computeAreaCropRect() below). null for full-tab/full-screen mode, or if
// the selection rect couldn't be recovered from session storage — in
// either case onRecorderStopped() just saves the raw recording untouched.
let areaCropRect: Rect | null = null;
// Pasted console logs from users reliably lose exactly the
// computeAreaCropRect()/calibration/geometry lines that would explain a
// mispositioned crop — the recorder popup's own diagnostics get dropped
// somewhere in the clipboard/paste step while the much larger ffmpeg
// transcript around them survives. Console logging isn't a reliable channel
// for this information, so it's carried a different way instead: a short,
// filename-safe tag set once computeAreaCropRect() finishes, appended to the
// saved file's own name. Whatever recording gets uploaded back to us now
// carries its own crop diagnosis, no console access needed at all.
let cropDebugTag = "";
// An earlier "skip cropping if the share doesn't look like This Tab" safety
// net (displaySurface / resolution-mismatch heuristics below) was removed:
// if Area was selected in the addon, a crop of the same size/position
// measured in the tab is applied unconditionally, even when the wrong
// monitor/window ended up being shared and the crop is therefore
// meaningless content-wise. A missing/undetected crop was judged worse than
// a mispositioned one — see ARCHITECTURE.md.

// Relays a diagnostic line to background.ts's console (mirrors the same
// pattern frame-stitch-recorder.ts already used successfully). Added
// because this window can close itself within ~1.2-1.6s of a silent
// failure (getDisplayMedia() rejected, or the shared track ending before
// recorder.start() ever ran) — too fast to reliably open and read this
// window's OWN devtools console before it's gone, which is exactly what
// was reported: "окошко записи пропадает после старта, консоль пустая".
// Background's console survives the popup closing (chrome://extensions /
// about:debugging → Inspect), so route the same information there too.
function logToBackground(message: string): void {
  console.error("ScreenRec (recorder.html):", message);
  chrome.runtime.sendMessage({ target: "background", type: "RECORDER_LOG", message }).catch(() => {});
}

// Samples a live audio track's actual signal level for ~2.5s and logs a
// verdict, so a "no sound" report can be settled from the console log
// alone on the next retest, without needing the person to attach the
// finished video for an external ffprobe/volumedetect pass — conclusive,
// but a whole extra round-trip every time. Runs fire-and-forget via
// requestAnimationFrame, deliberately not awaited by its caller: it must
// never delay recorder.start() or anything else in beginSharing(). Uses
// its own AudioContext/AnalyserNode rather than reusing any mixing graph
// from audio-mix.ts — this only needs to LISTEN to whatever track is
// already flowing into recordStream, not modify it, so a separate,
// disposable analysis graph keeps this fully decoupled from the actual
// recording path (a bug in the probe itself can't affect what gets
// recorded).
function probeAudioLevel(track: MediaStreamTrack): void {
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let peak = 0;
    let sumSquares = 0;
    let samples = 0;
    const startedAt = Date.now();
    const PROBE_DURATION_MS = 2500;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128; // byte 0..255 centered on silence=128 → -1..1
        peak = Math.max(peak, Math.abs(v));
        sumSquares += v * v;
        samples++;
      }
      if (Date.now() - startedAt < PROBE_DURATION_MS) {
        requestAnimationFrame(tick);
        return;
      }
      const rms = Math.sqrt(sumSquares / Math.max(1, samples));
      // Silence sampled this way isn't perfectly 0 (analog/encoding noise
      // floor), so a small threshold rather than an exact-zero check —
      // matches the same real-world margin an earlier -91dB/-84dB ffprobe
      // reading established as "digital silence" for this project.
      const isSilent = peak < 0.02;
      const verdict = isSilent ? "SILENT or near-silent" : "real signal detected";
      logToBackground(
        `probeAudioLevel(): sampled ~${PROBE_DURATION_MS}ms of the live audio track (${track.label || track.kind}) right at recording start — peak=${peak.toFixed(3)} rms=${rms.toFixed(3)} → ${verdict}. This measures the SOURCE track directly, before MediaRecorder/ffmpeg touch it at all — a silent verdict here means the capture itself (mic muted/wrong device, or the browser's own "Share audio" checkbox left unchecked) is the cause, not the crop/encode pipeline.`
      );
      // Mirrored directly into this window's own UI (not just the
      // console): "no sound" retests repeatedly came back with the
      // console's own early lines missing from what the person could
      // actually copy (a DevTools buffering/Persist-Logs quirk this
      // codebase has no control over — see ARCHITECTURE.md). This window is
      // already open and visible for the whole recording, so showing the
      // verdict here needs no console access at all.
      if (audioCheckEl) {
        audioCheckEl.textContent = t(isSilent ? "recorderAudioCheckSilent" : "recorderAudioCheckOk", lang);
        audioCheckEl.classList.add("visible", isSilent ? "silent" : "ok");
      }
      source.disconnect();
      ctx.close().catch(() => {});
    };
    requestAnimationFrame(tick);
  } catch (e) {
    logToBackground(`probeAudioLevel() failed to run (non-fatal — just means this diagnostic isn't available this time): ${String(e)}`);
  }
}

// See ARCHITECTURE.md: on this Firefox setup, MediaRecorder.onstop can
// simply never fire — first hit in the old frame-stitch path and fixed
// there with a force-flush + grace-period fallback instead of waiting on
// onstop forever. recorder.ts's finalize()/cancel handler need the same
// treatment — without it, clicking Stop just hangs on "Saving…" forever.
// This still matters even after canvas.captureStream() was dropped
// entirely in favor of recording the raw stream directly (see below) —
// onstop reliability for the RAW getDisplayMedia() stream is better but
// the grace period is cheap insurance and stays either way.
const RECORDER_STOP_GRACE_MS = 2500;

async function init(): Promise<void> {
  const { lang: storedLang } = await SettingsStore.get();
  lang = resolveLang(storedLang);
  applyI18n(document, lang);
  applyDirection(lang);
  const { theme } = await SettingsStore.get();
  applyTheme(theme);

  // Area-mode recordings only come out right if the person picks *this*
  // tab (the one they just selected a region on) in the browser's own
  // share dialog a moment later — picking anything else silently crops
  // garbage instead. applyI18n() above already set the generic
  // "recorderPreparing" text from the HTML's data-i18n attribute; override
  // it here with the area-specific version, which says so explicitly
  // (reported as confusing: "не понятно, что выбирать в окне для сьемки").
  if (mode === "area") {
    statusEl.textContent = t("recorderPreparingArea", lang);
    // The text-only instruction above kept getting missed (real reports
    // turned out to be "Entire Screen" picked instead of "This Tab",
    // confirmed from Firefox's own sharing banner in the recording).
    // applyI18n() already filled this element's text from its data-i18n
    // attribute; just make it visible for area mode specifically — a loud,
    // separate warning box instead of relying on the small .status line
    // alone.
    if (areaWarnEl) areaWarnEl.classList.add("visible");
  }

  // getDisplayMedia() only runs once the person clicks startBtn below —
  // calling it automatically here used to fail silently (this window has
  // no "user activation" of its own; it was opened programmatically via
  // chrome.windows.create(), not by a click inside this document); see
  // ARCHITECTURE.md. statusEl already shows recorderPreparing (set via
  // data-i18n in the HTML) prompting the click.
  // cancelBtn's own listener (wired at the bottom of this file) already
  // handles being clicked before recording starts — recorder is still null
  // at that point, so it takes the "just cancel" branch rather than trying
  // to stop a MediaRecorder that doesn't exist yet.
  startBtn.addEventListener(
    "click",
    () => {
      startBtn.hidden = true;
      beginSharing();
    },
    { once: true }
  );
}

async function beginSharing(): Promise<void> {
  statusEl.textContent = mode === "area" ? t("recorderPickPromptArea", lang) : t("recorderPickPrompt", lang);
  logToBackground(`beginSharing() start, mode=${mode}, wantAudio=${wantAudio}`);

  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio: wantAudio,
    });
  } catch (err) {
    // This branch used to log nothing at all — it's one of only two paths
    // in this file that closes the window without ever calling
    // console.error, which is exactly what an empty-console report after
    // "the window just disappeared" would look like from either of them.
    logToBackground(`getDisplayMedia() rejected: ${String(err)}`);
    statusEl.textContent = t("recorderErrorPermission", lang);
    await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "permission_denied" });
    setTimeout(() => window.close(), 1600);
    return;
  }

  const videoTrack = displayStream.getVideoTracks()[0];
  const grantedAt = Date.now();
  logToBackground(
    `getDisplayMedia() granted: label="${videoTrack?.label}" readyState=${videoTrack?.readyState} muted=${videoTrack?.muted} settings=${JSON.stringify(videoTrack?.getSettings?.() || {})}`
  );

  // If the user (or the tab that requested this) closes the shared stream
  // from the browser's own "Stop sharing" UI, wrap up gracefully. This is
  // the OTHER silent-close path (via finalize()'s own "user_cancelled"
  // branch, if it fires before recorder.start() has run) — logging here
  // tells us whether the shared source ended unexpectedly early, and how
  // long after being granted.
  videoTrack.addEventListener("ended", () => {
    logToBackground(
      `shared video track 'ended' fired ${Date.now() - grantedAt}ms after grant — recorderStartedOk=${recorderStartedOk} chunks=${chunks.length} readyState=${videoTrack.readyState}`
    );
    finalize("track_ended");
  });

  // Everything from here on used to run with no try/catch at all — any
  // failure (in the area-crop-rect lookup, or MediaRecorder rejecting the
  // stream/options) was an unhandled promise rejection that
  // left this window sitting there with no feedback: no error, no closed
  // window (that only happens via finalize()/onRecorderStopped(), neither
  // of which this dead end ever reached), just silence. Wrapping it means
  // a setup failure is at least visible and logged instead of indistinguishable
  // from "it's still working".
  try {
    // Area mode used to feed MediaRecorder a canvas.captureStream() (built
    // by the now-removed buildCroppedStream(), which drew a live crop of
    // the shared source onto a <canvas> every frame) so the SAVED file was
    // already cropped. On this Firefox setup that combination reliably
    // produced 0 bytes of output even after fixing every timing issue found
    // along the way (an onstop hang, and rAF throttling) — console logs
    // confirmed MediaRecorder.start() succeeded but chunks stayed empty
    // regardless. So area mode now records the RAW shared stream directly,
    // exactly like full-tab/full-screen mode (the one combination that has
    // always reliably produced real video here), and the crop is applied
    // AFTERWARDS to the finished file with ffmpeg.wasm — see
    // computeAreaCropRect() and cropRecordedBlobWithFfmpeg() below, and
    // ARCHITECTURE.md.
    recordStream = displayStream;

    // Mix in the real microphone alongside whatever tab/system audio
    // getDisplayMedia() granted, when audio was requested at all. Same
    // reasoning/mechanism as offscreen.ts's startTabCapture(): safe to mix
    // directly in this page since it stays open for the whole recording,
    // and mixAudioTracks() hands back the SAME track object (nothing to
    // swap/detach) whenever only one source ended up available (e.g. the
    // mic was denied).
    if (wantAudio) {
      const originalAudioTracks = recordStream.getAudioTracks();
      // Whether the BROWSER's own share dialog actually handed over a
      // tab/system audio track is a distinct question from whether the
      // final mixed track (this + the mic) carries real sound —
      // probeAudioLevel() below only ever answers the second one. This is
      // known the instant getDisplayMedia() returns (no 2.5s sampling
      // needed) and, since DevTools console lines can go missing for the
      // user, shown directly in this window's own UI instead of only
      // logged. "Share audio" not being checked/honored in the dialog is
      // exactly the "no track at all" case this catches.
      const hasTabAudioTrack = originalAudioTracks.length > 0;
      logToBackground(
        `tab/system audio from getDisplayMedia(): ${originalAudioTracks.length} track(s)${originalAudioTracks[0] ? ` (readyState=${originalAudioTracks[0].readyState}, label="${originalAudioTracks[0].label}")` : ""} — reflects whether "Share audio" was checked/honored in the browser's share dialog, independent of the microphone.`
      );
      if (tabAudioCheckEl) {
        tabAudioCheckEl.textContent = t(hasTabAudioTrack ? "recorderTabAudioGranted" : "recorderTabAudioMissing", lang);
        tabAudioCheckEl.classList.add("visible", hasTabAudioTrack ? "ok" : "silent");
      }
      activeMicMix = await mixInMicrophone(originalAudioTracks);
      if (activeMicMix.track && activeMicMix.track !== originalAudioTracks[0]) {
        originalAudioTracks.forEach((t) => recordStream!.removeTrack(t));
        recordStream.addTrack(activeMicMix.track);
        detachedTabAudioTracks = originalAudioTracks;
      }
    }

    previewEl.srcObject = recordStream;
    previewEl.style.display = "block";
    await previewEl.play().catch(() => {});

    if (mode === "area") {
      areaCropRect = await computeAreaCropRect(previewEl);
    }

    const { videoFormat = "webm" } = await chrome.storage.local.get<{ videoFormat?: string }>(["videoFormat"]);
    // Found via direct evidence, not a guess: a pixel checksum probe (see
    // below) proved real video frames were arriving and changing the whole
    // time, yet MediaRecorder produced literally 0 bytes across an 18.5s
    // hold. That's the same failure pattern already found and fixed once
    // elsewhere in this codebase — see the WEBM_VIDEO_ONLY_CANDIDATES
    // comment in lib/video-format.ts: constructing a MediaRecorder with a
    // mimeType that NAMES an audio codec (opus/aac) against a stream with
    // no actual live audio track leaves Firefox's internal muxer waiting
    // forever for audio samples that will never come, so
    // ondataavailable/onstop never fire — even though the video track
    // itself is being captured correctly. That earlier fix only ever
    // reached background.ts's frame-stitch path; `beginSharing()` here has
    // ALWAYS unconditionally called pickSupportedMimeTypeInBrowser() (the
    // audio-codec-naming picker), regardless of whether getDisplayMedia()
    // actually granted a live audio track — `wantAudio=true` only reflects
    // what was REQUESTED, not what Firefox's share dialog actually granted
    // (sharing tab/system audio needs an explicit checkbox there, easy to
    // leave unchecked, and Firefox doesn't always honor it even when
    // checked). This is almost certainly why area-mode recordings kept
    // producing 0 bytes, independent of every architecture tried (canvas,
    // raw stream) — none of them were ever the actual problem.
    const liveAudioTracks = recordStream.getAudioTracks().filter((tr) => tr.readyState === "live");
    const hasLiveAudio = liveAudioTracks.length > 0;
    logToBackground(
      `audio track check: wantAudio=${wantAudio} recordStream.getAudioTracks().length=${recordStream.getAudioTracks().length} live=${liveAudioTracks.length} → using ${hasLiveAudio ? "audio+video" : "VIDEO-ONLY"} mimeType candidates`
    );
    // Even when the recorded blob (and a successfully-recovered cropped
    // output) genuinely carries a real opus audio stream all the way
    // through, "no sound in the video" reports have kept recurring:
    // `-c:a copy` guarantees the crop step passes the SOURCE audio through
    // byte-for-byte, so if the saved file is silent, the source track
    // handed to MediaRecorder was already silent — nothing downstream of
    // this point can be the cause. Settling that used to need the person
    // to attach the actual finished video so ffprobe/volumedetect could
    // measure it directly — real, conclusive evidence, but it costs a
    // whole extra round-trip every time. This samples the live track's
    // actual signal level right here, at the moment recording starts, and
    // logs a verdict — so the very next retest's console log alone (no
    // file upload needed) says whether the mic/tab/system audio being
    // captured ever had real sound in it at the source, independent of
    // anything this file's own crop/encode pipeline does afterward.
    if (hasLiveAudio) probeAudioLevel(liveAudioTracks[0]);
    const mimeType = hasLiveAudio
      ? pickSupportedMimeTypeInBrowser(videoFormat === "mp4")
      : pickSupportedVideoOnlyMimeTypeInBrowser(videoFormat === "mp4");
    currentMimeType = mimeType || "video/webm";
    const recorderOptions: MediaRecorderOptions = mimeType ? { mimeType } : {};
    const { videoQuality = "auto" } = await chrome.storage.local.get<{ videoQuality?: VideoQuality }>(["videoQuality"]);
    const bitrate = QUALITY_BITRATES[videoQuality];
    if (bitrate) recorderOptions.videoBitsPerSecond = bitrate;

    recorder = new MediaRecorder(recordStream, recorderOptions);
    chunks = [];
    let dataEventCount = 0;
    let dataEventBytesTotal = 0;
    recorder.ondataavailable = (e) => {
      dataEventCount++;
      dataEventBytesTotal += e.data?.size || 0;
      // Logged every time (not just on failure): a report once showed
      // chunks=0 even after the onstop grace period fully elapsed, with no
      // visibility into whether ondataavailable ever fired at all before
      // then — this line makes that directly observable instead of
      // inferred from the final count.
      logToBackground(
        `ondataavailable #${dataEventCount}: size=${e.data?.size || 0} (running total=${dataEventBytesTotal}) ${Date.now() - recorderStartMs}ms after recorder.start()`
      );
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (event) => {
      // MediaRecorder moves to "inactive" and fires both "error" and "stop"
      // on a failure — onRecorderStopped() (wired below) still runs right
      // after this, so this handler only needs to log *why*, not finalize
      // anything itself.
      recorderSetupError = (event as unknown as { error?: unknown }).error || event;
      console.error("ScreenRec: MediaRecorder error", recorderSetupError);
    };
    recorder.onstop = onRecorderStopped;
    // 250ms, not 1000ms: shortens the window in which a genuinely-working
    // recording that gets stopped quickly (a fast smoke-test stop, or a
    // short real recording) can still show chunks=0 just because nothing
    // had been flushed to ondataavailable yet — the encoder may well have
    // real data queued up that a 1s timeslice simply hadn't handed over.
    // The force-flush requestData() call in finalize() still covers
    // whatever's left over at stop time either way.
    recorder.start(250);
    recorderStartedOk = true;
    recorderStartMs = Date.now();
    logToBackground(`MediaRecorder.start() ok, mimeType=${currentMimeType}`);

    // An earlier getVideoPlaybackQuality()-based probe came back
    // decisive-looking but with a catch — totalVideoFrames stayed at 0 for
    // the ENTIRE 28s hold, including the first ~4-6s while
    // document.hasFocus was still true. That's stronger than "unfocused
    // windows get throttled" would predict (frames should have flowed, at
    // least briefly, while focused) and raises a real alternative
    // explanation: getVideoPlaybackQuality() itself may simply not be
    // implemented/populated for a MediaStream (srcObject) source in this
    // Firefox build, making it a false negative rather than proof nothing
    // is arriving. A pixel-level check sidesteps that entirely: draw the
    // live preview onto a tiny offscreen canvas every probe and checksum
    // the actual pixel bytes. drawImage() from a getDisplayMedia()-backed
    // <video> is NOT canvas-tainting (this is the same technique
    // buildCroppedStream() used successfully before it was replaced — the
    // black-frame problem it had was about frame CONTENT, never about
    // drawImage()/getImageData() being blocked), so this works regardless
    // of whatever's going on with the playback-quality API. If the
    // checksum never changes across the whole recording, that's real,
    // API-independent proof nothing is being delivered to this document at
    // all; if it does change, frames ARE arriving and
    // getVideoPlaybackQuality's 0 is just this Firefox build
    // under-reporting it — a very different, much better situation.
    const probeCanvas = document.createElement("canvas");
    probeCanvas.width = 8;
    probeCanvas.height = 8;
    const probeCtx = probeCanvas.getContext("2d", { willReadFrequently: true });
    let lastPixelChecksum: number | null = null;
    let pixelChecksumChangedEver = false;

    frameProbeHandle = setInterval(() => {
      if (finished) {
        if (frameProbeHandle) clearInterval(frameProbeHandle);
        return;
      }
      const vq = previewEl.getVideoPlaybackQuality ? previewEl.getVideoPlaybackQuality() : null;
      let pixelChecksum: number | string = "n/a";
      try {
        if (probeCtx) {
          probeCtx.drawImage(previewEl, 0, 0, 8, 8);
          const data = probeCtx.getImageData(0, 0, 8, 8).data;
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          pixelChecksum = sum;
          if (lastPixelChecksum !== null && lastPixelChecksum !== sum) pixelChecksumChangedEver = true;
          lastPixelChecksum = sum;
        }
      } catch (err) {
        pixelChecksum = `error: ${String(err)}`;
      }
      logToBackground(
        `frame probe @ ${Date.now() - recorderStartMs}ms: recorder.state=${recorder ? recorder.state : "null"} ` +
          `videoTrack.readyState=${videoTrack.readyState} videoTrack.muted=${videoTrack.muted} ` +
          `document.hasFocus=${document.hasFocus()} document.visibilityState=${document.visibilityState} ` +
          `previewEl.paused=${previewEl.paused} previewEl.currentTime=${previewEl.currentTime.toFixed(2)} ` +
          `totalVideoFrames=${vq ? vq.totalVideoFrames : "n/a"} droppedVideoFrames=${vq ? vq.droppedVideoFrames : "n/a"} ` +
          `pixelChecksum=${pixelChecksum} changedSinceStart=${pixelChecksumChangedEver}`
      );
    }, 2000);

    startedAt = Date.now();
    timerHandle = setInterval(updateTimer, 250);
    statusEl.textContent = t("recorderTitle", lang);
    stopBtn.hidden = false;
    stopBtn.disabled = false;
    // Lets the popup/sidepanel's own elapsed-time display re-sync to when
    // recording actually started, instead of when this window was first
    // opened (which is when background.ts has to start it, so Cancel/Stop
    // work even before the person has clicked "Start sharing" above).
    chrome.runtime.sendMessage({ target: "background", type: "RECORDING_ACTUALLY_STARTED" }).catch(() => {});
  } catch (e) {
    logToBackground(`recorder setup failed (mode=${mode}): ${String(e)}`);
    statusEl.textContent = t("recorderErrorNoData", lang);
    statusEl.style.color = "#e04343";
    stopBtn.hidden = true;
    (displayStream?.getTracks() || []).forEach((tr) => tr.stop());
    // Setup can fail after mic-mixing already ran above — release that too,
    // same as the normal-stop cleanup in onRecorderStopped().
    stopMicMix(activeMicMix);
    activeMicMix = null;
    detachedTabAudioTracks.forEach((tr) => tr.stop());
    detachedTabAudioTracks = [];
    await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "setup_failed" }).catch(() => {});
    // Deliberately NOT auto-closing here (unlike the getDisplayMedia-denied
    // path above): this is a real, unexpected failure the user should
    // actually get to read and report, not a normal "picker was
    // dismissed" flow. They can close the window themselves once they've
    // seen it / copied the console output.
  }
}

interface PendingRectSession {
  pendingRect?: Rect;
  pendingRectDpr?: number;
  pendingRectViewportW?: number;
  pendingRectViewportH?: number;
}

// ---- Calibration-marker crop transform -------------------------------------
// An earlier approach tried to DETECT which share type the person picked and
// skip cropping (with a distinct notification) whenever it wasn't "This
// Tab" — because computing where the tab's own content actually sits inside
// a captured window/screen frame has no web API answer. That was rejected
// entirely: cropping must happen no matter which option was picked, or the
// behavior is just confusing regardless of how correctly the detection
// itself works.
//
// This measures the real answer directly instead of inferring it. Two small,
// uniquely-colored marker boxes are injected into the recorded tab at fixed
// CSS positions (their rendered centers are read back via
// getBoundingClientRect(), so the true position is known even under
// fractional-pixel layout), a video frame is captured shortly after, and the
// markers' actual pixel positions in THAT frame are found by a full-frame
// color search. Two known correspondences (CSS position -> captured pixel
// position) are enough to solve the scale + offset that maps ANY CSS-pixel
// rect on that page to the right pixel rect in the captured frame —
// regardless of whether the frame is the tab alone, the whole browser window
// (with its decorations), or the whole screen (with the tab positioned
// anywhere on it, under any OS window layout). If calibration fails for any
// reason (most likely: the recorded tab isn't actually the one visible on
// screen right now, so the markers never appear in the captured frame at
// all), computeAreaCropRect() below falls back to the older
// displaySurface/resolution-mismatch skip-and-notify logic — a safety net,
// not a guess at a wrong crop.
//
// Trade-off (called out in ARCHITECTURE.md and to the user, not hidden):
// this puts two small colored squares in the corners of the recorded tab
// for a few hundred ms while calibrating. It happens once, right at the
// start of the recording (immediately after MediaRecorder would otherwise
// begin — see beginSharing()), and the markers are removed again as soon as
// they're measured.
const CALIB_MARKER_A_ID = "__screenrec_calib_marker_a__";
const CALIB_MARKER_B_ID = "__screenrec_calib_marker_b__";
const CALIB_MARKER_SIZE = 22; // CSS px
const CALIB_COLOR_A: [number, number, number] = [255, 0, 220]; // vivid magenta — rare in real page content
const CALIB_COLOR_B: [number, number, number] = [10, 255, 120]; // vivid spring-green — likewise rare, and far from A in color space
const CALIB_COLOR_TOLERANCE = 36; // per-channel; read from the raw pre-encode video frame (not the compressed file), so this can stay tight
const CALIB_MIN_MATCH_PIXELS = 10; // rejects a stray few-pixel false match as "not found" rather than trusting it

interface CalibPoint {
  x: number;
  y: number;
}

interface CropTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

// Plain window/screen geometry, read from the recording tab, used only as a
// fallback when calibration (above) already failed. See
// measureWindowChromeGeometry() below for what each field is for.
interface WindowChromeGeometry {
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  screenX: number;
  screenY: number;
  screenLeft: number;
  screenTop: number;
  screenWidth: number;
  screenHeight: number;
}

async function getRecordingTabId(): Promise<number | null> {
  try {
    const state = await chrome.runtime.sendMessage<{ recordingTabId?: number | null }>({
      target: "background",
      type: "GET_STATE",
    });
    return typeof state?.recordingTabId === "number" ? state.recordingTabId : null;
  } catch (e) {
    logToBackground(`getRecordingTabId(): GET_STATE failed: ${String(e)}`);
    return null;
  }
}

// Waits for a captured frame that postdates "now" — so the pixel search
// below reads a frame painted AFTER the markers were injected, not one
// already in flight. requestVideoFrameCallback gives an exact per-frame
// signal where supported; the setTimeout fallback is generous (multiple
// frames even at a low capture rate) for browsers without it.
function waitForNextVideoFrame(videoEl: HTMLVideoElement): Promise<void> {
  const anyVideo = videoEl as HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
  };
  if (typeof anyVideo.requestVideoFrameCallback === "function") {
    return new Promise((resolve) => {
      anyVideo.requestVideoFrameCallback!(() => resolve());
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 150));
}

// Full-frame color search for one marker's centroid. Returns null if fewer
// than CALIB_MIN_MATCH_PIXELS pixels matched closely enough — "not found",
// not "found at (0,0)".
function findMarkerCentroid(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  target: [number, number, number]
): (CalibPoint & { count: number }) | null {
  const [tr, tg, tb] = target;
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    const rowBase = y * width * 4;
    for (let x = 0; x < width; x++) {
      const i = rowBase + x * 4;
      const dr = data[i] - tr;
      const dg = data[i + 1] - tg;
      const db = data[i + 2] - tb;
      if (Math.abs(dr) <= CALIB_COLOR_TOLERANCE && Math.abs(dg) <= CALIB_COLOR_TOLERANCE && Math.abs(db) <= CALIB_COLOR_TOLERANCE) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  if (count < CALIB_MIN_MATCH_PIXELS) return null;
  return { x: sumX / count, y: sumY / count, count };
}

// Orchestrates the whole calibration: inject markers -> wait for a fresh
// frame -> capture + color-search that frame -> remove the markers (always,
// even on failure) -> solve the transform. Returns null (never throws) on
// any failure so the caller can fall back safely.
async function calibrateAreaCropTransform(videoEl: HTMLVideoElement, videoW: number, videoH: number): Promise<CropTransform | null> {
  const tabId = await getRecordingTabId();
  if (tabId == null) {
    logToBackground("calibrateAreaCropTransform(): no recordingTabId available — skipping calibration");
    return null;
  }

  let cssPoints: { a: CalibPoint; b: CalibPoint } | null = null;
  try {
    const colorA = `rgb(${CALIB_COLOR_A.join(",")})`;
    const colorB = `rgb(${CALIB_COLOR_B.join(",")})`;
    const results = await chrome.scripting.executeScript<[string, string, number, string, string], { a: CalibPoint; b: CalibPoint }>({
      target: { tabId },
      func: (idA: string, idB: string, size: number, colorAArg: string, colorBArg: string) => {
        // Calibration used to fail ("marker color search failed — a=not
        // found b=not found") even with "This Tab" genuinely selected, for
        // content that goes into the page's own Fullscreen API mode
        // (common for browser games). While `document.fullscreenElement`
        // is set, the browser renders ONLY that element's own subtree —
        // anything else appended to `document.documentElement` (where
        // these markers always went before) is simply never painted at
        // all, not "covered by" the fullscreen content as an earlier
        // diagnosis guessed. It also explains the paired
        // resolution-mismatch symptom seen alongside that failure: a
        // fullscreen element commonly renders at the physical display's
        // native resolution, not the tab's own (pre-fullscreen) CSS
        // viewport that `pendingRectViewportW/H` captured at selection
        // time. Appending under the fullscreen element instead (falling
        // back to documentElement when nothing is fullscreen, unchanged
        // from before) keeps the markers actually on-screen either way.
        // Re-parenting on every call (not just on first creation) covers a
        // marker element that already exists from a stale run before
        // fullscreen was entered.
        const place = (id: string, color: string, css: string): HTMLDivElement => {
          let el = document.getElementById(id) as HTMLDivElement | null;
          if (!el) {
            el = document.createElement("div");
            el.id = id;
          }
          const parent = document.fullscreenElement || document.documentElement;
          if (el.parentNode !== parent) parent.appendChild(el);
          el.style.cssText =
            `all: initial; position: fixed; ${css} width: ${size}px; height: ${size}px; ` +
            `background: ${color}; z-index: 2147483647; pointer-events: none; margin: 0; padding: 0; border: 0;`;
          return el;
        };
        const a = place(idA, colorAArg, "top: 8px; left: 8px;");
        const b = place(idB, colorBArg, "right: 8px; bottom: 8px;");
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return {
          a: { x: ra.left + ra.width / 2, y: ra.top + ra.height / 2 },
          b: { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 },
        };
      },
      args: [CALIB_MARKER_A_ID, CALIB_MARKER_B_ID, CALIB_MARKER_SIZE, colorA, colorB],
    });
    cssPoints = results?.[0]?.result || null;
  } catch (e) {
    logToBackground(`calibrateAreaCropTransform(): marker injection failed: ${String(e)}`);
  }

  if (!cssPoints) {
    logToBackground("calibrateAreaCropTransform(): could not place/read calibration markers — skipping calibration");
    return null;
  }

  try {
    // Two frames, not one: the first callback/timeout can still land on a
    // frame that was already "in flight" (buffered by the capture
    // pipeline) when the markers were injected.
    await waitForNextVideoFrame(videoEl);
    await waitForNextVideoFrame(videoEl);

    const canvas = document.createElement("canvas");
    canvas.width = videoW;
    canvas.height = videoH;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      logToBackground("calibrateAreaCropTransform(): no 2d canvas context available");
      return null;
    }
    ctx.drawImage(videoEl, 0, 0, videoW, videoH);
    const frame = ctx.getImageData(0, 0, videoW, videoH);

    const pxA = findMarkerCentroid(frame.data, videoW, videoH, CALIB_COLOR_A);
    const pxB = findMarkerCentroid(frame.data, videoW, videoH, CALIB_COLOR_B);
    if (!pxA || !pxB) {
      logToBackground(
        `calibrateAreaCropTransform(): marker color search failed — a=${pxA ? `${pxA.count}px` : "not found"} b=${pxB ? `${pxB.count}px` : "not found"} (the recorded tab may not be the one actually visible on screen right now, or something is painted over the fixed-position markers)`
      );
      return null;
    }

    const cssDx = cssPoints.b.x - cssPoints.a.x;
    const cssDy = cssPoints.b.y - cssPoints.a.y;
    const pxDx = pxB.x - pxA.x;
    const pxDy = pxB.y - pxA.y;
    // Sanity bounds, not just a divide-by-zero guard: a genuine calibration
    // always has B strictly right-and-below A (that's how they're placed) at
    // a scale within a sane multiple of 1 — this catches a spurious
    // same-color false-positive match elsewhere on the page rather than
    // trusting a nonsensical transform.
    if (cssDx <= 0 || cssDy <= 0 || pxDx <= 0 || pxDy <= 0) {
      logToBackground(`calibrateAreaCropTransform(): implausible marker geometry (cssDx=${cssDx} cssDy=${cssDy} pxDx=${pxDx} pxDy=${pxDy}) — rejecting`);
      return null;
    }
    const scaleX = pxDx / cssDx;
    const scaleY = pxDy / cssDy;
    if (scaleX < 0.1 || scaleX > 12 || scaleY < 0.1 || scaleY > 12) {
      logToBackground(`calibrateAreaCropTransform(): implausible scale (scaleX=${scaleX} scaleY=${scaleY}) — rejecting`);
      return null;
    }
    const offsetX = pxA.x - cssPoints.a.x * scaleX;
    const offsetY = pxA.y - cssPoints.a.y * scaleY;
    logToBackground(
      `calibrateAreaCropTransform(): OK — cssA=${JSON.stringify(cssPoints.a)} cssB=${JSON.stringify(cssPoints.b)} pxA=(${pxA.x.toFixed(1)},${pxA.y.toFixed(1)},${pxA.count}px) pxB=(${pxB.x.toFixed(1)},${pxB.y.toFixed(1)},${pxB.count}px) -> scaleX=${scaleX.toFixed(3)} scaleY=${scaleY.toFixed(3)} offsetX=${offsetX.toFixed(1)} offsetY=${offsetY.toFixed(1)}`
    );
    return { scaleX, scaleY, offsetX, offsetY };
  } catch (e) {
    logToBackground(`calibrateAreaCropTransform(): frame capture/search failed: ${String(e)}`);
    return null;
  } finally {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (idA: string, idB: string) => {
          document.getElementById(idA)?.remove();
          document.getElementById(idB)?.remove();
        },
        args: [CALIB_MARKER_A_ID, CALIB_MARKER_B_ID],
      });
    } catch (e) {
      logToBackground(`calibrateAreaCropTransform(): marker cleanup failed (harmless, page-local only): ${String(e)}`);
    }
  }
}

// Determines what's actually being captured — screen, tab, or window — and
// applies the matching crop-offset logic for each case: measures plain
// window/screen geometry from the recording tab (outer vs inner window
// size, and the window's position on its screen) so the fallback crop math
// below can account for browser chrome (and, for a full-screen share, the
// window's position within the screen too) instead of always assuming
// offset (0,0). Parallel in structure to calibrateAreaCropTransform()'s
// marker injection, but reads existing window/screen properties instead of
// painting anything. Never throws; returns null on any failure so the
// caller degrades further to the original offset-(0,0) math, since a crop
// is always produced once Area was selected.
async function measureWindowChromeGeometry(tabId: number): Promise<WindowChromeGeometry | null> {
  try {
    const results = await chrome.scripting.executeScript<[], WindowChromeGeometry>({
      target: { tabId },
      func: () => {
        // screen.left/screen.top are non-standard but Firefox-supported —
        // they give the CURRENT screen's own origin in the virtual desktop.
        // Without them, screenX/screenY are always relative to the PRIMARY
        // monitor, which is the wrong reference point on a multi-monitor
        // setup where the captured screen isn't the primary one. Chrome
        // doesn't implement them, so this degrades to "assume primary
        // monitor" there (documented caveat, not silently wrong: see
        // ARCHITECTURE.md).
        const s = window.screen as Screen & { left?: number; top?: number };
        return {
          outerWidth: window.outerWidth,
          outerHeight: window.outerHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          screenX: window.screenX,
          screenY: window.screenY,
          screenLeft: typeof s.left === "number" ? s.left : 0,
          screenTop: typeof s.top === "number" ? s.top : 0,
          screenWidth: window.screen.width,
          screenHeight: window.screen.height,
        };
      },
      args: [],
    });
    const geo = results?.[0]?.result || null;
    if (!geo) {
      logToBackground("measureWindowChromeGeometry(): script ran but returned no result");
      return null;
    }
    logToBackground(`measureWindowChromeGeometry(): ${JSON.stringify(geo)}`);
    return geo;
  } catch (e) {
    logToBackground(`measureWindowChromeGeometry(): injection failed: ${String(e)}`);
    return null;
  }
}

// Computes the pixel rect (in the RAW recorded video's own resolution) that
// the finished recording should be cropped to, using the same selection
// data the old buildCroppedStream() read (pendingRect etc., written to
// chrome.storage.session by the area-selection overlay). Returns null if
// there's nothing to crop to (full/screen mode never calls this) or the
// selection couldn't be recovered — either way the caller just saves the
// raw, uncropped recording rather than losing it.
async function computeAreaCropRect(videoEl: HTMLVideoElement): Promise<Rect | null> {
  const { pendingRect, pendingRectDpr, pendingRectViewportW, pendingRectViewportH } =
    await chrome.storage.session.get<PendingRectSession>([
      "pendingRect",
      "pendingRectDpr",
      "pendingRectViewportW",
      "pendingRectViewportH",
    ]);
  if (!pendingRect) {
    logToBackground("computeAreaCropRect(): no pendingRect in session storage — will save the raw, uncropped recording");
    return null;
  }
  const dpr = pendingRectDpr || 1;

  // Bounded wait for the actual captured resolution to become known, same
  // reasoning as the old buildCroppedStream(): metadata normally arrives in
  // well under 1s, but this must not hang forever if it doesn't.
  const metadataOk = await new Promise<boolean>((resolve) => {
    if (videoEl.readyState >= 2) {
      resolve(true);
      return;
    }
    videoEl.onloadedmetadata = () => resolve(true);
    setTimeout(() => resolve(false), 5000);
  });
  const videoW = videoEl.videoWidth || Math.round((pendingRectViewportW || pendingRect.width) * dpr);
  const videoH = videoEl.videoHeight || Math.round((pendingRectViewportH || pendingRect.height) * dpr);
  const displaySurface = recordStream?.getVideoTracks()[0]?.getSettings().displaySurface;
  logToBackground(
    `computeAreaCropRect(): metadataOk=${metadataOk} videoW=${videoW} videoH=${videoH} pendingRect=${JSON.stringify(pendingRect)} dpr=${dpr} displaySurface=${displaySurface}`
  );

  // Primary path: measure the real transform directly via on-page
  // calibration markers (see the big comment above
  // calibrateAreaCropTransform() for the full reasoning). This works for
  // "This Tab", a specific window, or the entire screen alike, since it
  // doesn't infer the share type at all — it measures where the page's own
  // content actually landed in the captured frame.
  if (metadataOk) {
    const transform = await calibrateAreaCropTransform(videoEl, videoW, videoH);
    if (transform) {
      const { scaleX, scaleY, offsetX, offsetY } = transform;
      const outW = Math.max(2, Math.round(pendingRect.width * scaleX));
      const outH = Math.max(2, Math.round(pendingRect.height * scaleY));
      const sx = Math.min(Math.max(0, Math.round(pendingRect.x * scaleX + offsetX)), Math.max(0, videoW - 2));
      const sy = Math.min(Math.max(0, Math.round(pendingRect.y * scaleY + offsetY)), Math.max(0, videoH - 2));
      const clampedW = Math.min(outW, videoW - sx);
      const clampedH = Math.min(outH, videoH - sy);
      const result: Rect = { x: sx, y: sy, width: clampedW, height: clampedH };
      logToBackground(`computeAreaCropRect(): computed crop rect via calibration = ${JSON.stringify(result)}`);
      cropDebugTag = `calib_o${Math.round(offsetX)}x${Math.round(offsetY)}_s${Math.round(scaleX * 100)}x${Math.round(scaleY * 100)}`;
      return result;
    }
    logToBackground("computeAreaCropRect(): calibration failed — falling back to displaySurface/resolution-mismatch heuristics");
  }

  // Fallback path (calibration didn't run or didn't find its markers).
  //
  // An earlier approach used to skip cropping entirely here (return null)
  // when the share didn't look like "This Tab" — via displaySurface and a
  // resolution-mismatch check. That skip was removed: cropping must always
  // be attempted when an Area was selected, even on a share that clearly
  // isn't "This Tab" — a same-size/position crop that lands on the wrong
  // content is preferred over no crop at all. The two signals are kept only
  // as non-blocking diagnostics below, since they're still useful in the
  // logs for understanding a bad-looking crop.
  // Each capture type needs its own crop-offset logic: the single
  // displaySurface-agnostic assume-offset-(0,0) math further below is a
  // reasonable fallback for "browser" (Tab) shares, where the captured
  // frame IS the tab's own viewport. It's a poor fallback for "window" and
  // "monitor" shares, where the captured frame also includes browser
  // chrome (tab strip, address bar, bookmarks bar, and any docked side
  // panel) and, for "monitor", the rest of the screen too. This measures
  // that real geometry (measureWindowChromeGeometry()) and folds it into
  // the scale/origin used below; if the measurement itself fails for any
  // reason, scaleX/scaleY/originOffsetX/Y simply keep their original
  // assume-offset-(0,0) values, so this never blocks the crop.
  if (displaySurface && displaySurface !== "browser") {
    logToBackground(
      `computeAreaCropRect(): displaySurface=${displaySurface} (not "browser") and calibration already failed above — using displaySurface-specific fallback math.`
    );
  }
  if (pendingRectViewportW && pendingRectViewportH && metadataOk) {
    const expectedW = pendingRectViewportW * dpr;
    const expectedH = pendingRectViewportH * dpr;
    const wRatio = videoW / expectedW;
    const hRatio = videoH / expectedH;
    const TOLERANCE = 0.15;
    if (Math.abs(wRatio - 1) > TOLERANCE || Math.abs(hRatio - 1) > TOLERANCE) {
      logToBackground(
        `computeAreaCropRect(): captured resolution ${videoW}x${videoH} doesn't match the tab's own viewport (expected ~${Math.round(expectedW)}x${Math.round(expectedH)} at dpr=${dpr}) closely enough to trust as a "This Tab" capture, even though displaySurface=${displaySurface}. Proceeding with the fallback crop math anyway (cropping is always attempted when Area was selected).`
      );
    }
  }

  // Prefer a scale factor derived from the actual captured pixel size vs the
  // CSS viewport size measured at selection time, rather than assuming the
  // capture is exactly `cssPixels * devicePixelRatio`. Assumes offset (0,0)
  // — the starting point for every displaySurface; "window"/"monitor" below
  // may override scaleX/scaleY and set a non-zero origin once real geometry
  // is available. Some crop is always produced whenever pendingRect exists,
  // regardless of share type or resolution.
  let scaleX = pendingRectViewportW ? videoW / pendingRectViewportW : dpr;
  let scaleY = pendingRectViewportH ? videoH / pendingRectViewportH : dpr;
  let originOffsetX = 0;
  let originOffsetY = 0;
  let geoUsed = false; // debug tag — did the window/monitor geometry measurement actually produce numbers, or did this fall all the way back to plain (0,0)?

  if (displaySurface === "window" || displaySurface === "monitor") {
    const tabId = await getRecordingTabId();
    const geo = tabId != null ? await measureWindowChromeGeometry(tabId) : null;
    if (geo && geo.outerWidth > 0 && geo.outerHeight > 0) {
      geoUsed = true;
      // Chrome offset: the delta between the OS window frame (outerWidth/
      // outerHeight) and the page's own viewport (innerWidth/innerHeight,
      // which is what pendingRect's coordinates are relative to). Attributed
      // entirely to top+left — "смещение сайтбара и топбара" — since window
      // borders are a few px at most on modern OSes, well within this
      // fallback's existing margin of error.
      const chromeLeftCss = Math.max(0, geo.outerWidth - geo.innerWidth);
      const chromeTopCss = Math.max(0, geo.outerHeight - geo.innerHeight);

      if (displaySurface === "window") {
        // "window" capture: the recorded frame IS the browser window, chrome
        // included — so scale from the WINDOW's own outer size to the
        // captured video size ("соотношение окна и области"), not from the
        // tab's inner viewport size, which under-counts the chrome and would
        // shift the crop.
        scaleX = videoW / geo.outerWidth;
        scaleY = videoH / geo.outerHeight;
        originOffsetX = chromeLeftCss * scaleX;
        originOffsetY = chromeTopCss * scaleY;
        logToBackground(
          `computeAreaCropRect(): window-mode fallback geometry — outer=${geo.outerWidth}x${geo.outerHeight} inner=${geo.innerWidth}x${geo.innerHeight} chromeOffsetCss=(${chromeLeftCss},${chromeTopCss}) -> scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)}) origin=(${originOffsetX.toFixed(1)},${originOffsetY.toFixed(1)})`
        );
      } else {
        // "monitor" (entire screen) capture: the recorded frame is the WHOLE
        // screen, so on top of the same chrome offset, also add the browser
        // window's own position within that screen (screenX/screenY, made
        // monitor-relative via screen.left/screen.top — see
        // measureWindowChromeGeometry()'s comment on why that matters on a
        // multi-monitor setup). Scale from the screen's own CSS size to the
        // captured video size, since that's the ratio the whole frame was
        // actually built at.
        const winRelX = Math.max(0, geo.screenX - geo.screenLeft);
        const winRelY = Math.max(0, geo.screenY - geo.screenTop);
        if (geo.screenWidth > 0 && geo.screenHeight > 0) {
          scaleX = videoW / geo.screenWidth;
          scaleY = videoH / geo.screenHeight;
        }
        originOffsetX = (winRelX + chromeLeftCss) * scaleX;
        originOffsetY = (winRelY + chromeTopCss) * scaleY;
        logToBackground(
          `computeAreaCropRect(): monitor-mode fallback geometry — screen=${geo.screenWidth}x${geo.screenHeight} screenLeftTop=(${geo.screenLeft},${geo.screenTop}) windowScreenXY=(${geo.screenX},${geo.screenY}) chromeOffsetCss=(${chromeLeftCss},${chromeTopCss}) -> scale=(${scaleX.toFixed(3)},${scaleY.toFixed(3)}) origin=(${originOffsetX.toFixed(1)},${originOffsetY.toFixed(1)}). NOTE: assumes the captured monitor is the one the browser window is currently on — unverifiable from page JS alone.`
        );
      }
    } else {
      logToBackground(
        `computeAreaCropRect(): displaySurface=${displaySurface} but window/screen geometry measurement failed or returned nothing usable — falling back further to plain assume-offset-(0,0) math.`
      );
    }
  }

  const outW = Math.max(2, Math.round(pendingRect.width * scaleX));
  const outH = Math.max(2, Math.round(pendingRect.height * scaleY));
  const sx = Math.min(Math.max(0, Math.round(pendingRect.x * scaleX + originOffsetX)), Math.max(0, videoW - 2));
  const sy = Math.min(Math.max(0, Math.round(pendingRect.y * scaleY + originOffsetY)), Math.max(0, videoH - 2));
  const clampedW = Math.min(outW, videoW - sx);
  const clampedH = Math.min(outH, videoH - sy);

  const result: Rect = { x: sx, y: sy, width: clampedW, height: clampedH };
  logToBackground(
    `computeAreaCropRect(): computed crop rect via fallback math (displaySurface=${displaySurface}, origin=(${originOffsetX.toFixed(1)},${originOffsetY.toFixed(1)})) = ${JSON.stringify(result)}`
  );
  // See cropDebugTag's own declaration comment: this fallback's
  // displaySurface/geometry outcome, encoded compactly enough to survive as
  // a filename suffix rather than depend on a console log the user can
  // actually copy in full.
  const surfaceTag = displaySurface || "nosurface";
  const geoTag = displaySurface === "window" || displaySurface === "monitor" ? (geoUsed ? "geo" : "geoFAIL") : "naive";
  cropDebugTag = `${surfaceTag}-${geoTag}_o${Math.round(originOffsetX)}x${Math.round(originOffsetY)}_s${Math.round(scaleX * 100)}x${Math.round(scaleY * 100)}`;
  return result;
}

// Crops the finished recording to `rect` after the fact, using ffmpeg.wasm
// run entirely client-side inside this extension page (see ARCHITECTURE.md
// for why canvas.captureStream() was abandoned for this).
// The @ffmpeg/* packages are vendored as plain static files under
// ffmpeg-vendor/ by scripts/build.mjs (no bundler in this project, so a
// static `import "@ffmpeg/ffmpeg"` would resolve at typecheck time but fail
// at runtime — loading via a dynamic import() of a chrome.runtime.getURL()
// string sidesteps that entirely: tsc treats it as Promise<any> and never
// tries to resolve the package's own module graph, avoiding the need for
// ambient .d.ts files too). Returns null (never throws) on any failure, so
// the caller can fall back to saving the uncropped recording instead of
// losing it outright.
async function cropRecordedBlobWithFfmpeg(blob: Blob, rect: Rect, mimeType: string): Promise<Blob | null> {
  logToBackground(`cropRecordedBlobWithFfmpeg(): starting, rect=${JSON.stringify(rect)} inputBytes=${blob.size} mimeType=${mimeType}`);
  // Hoisted out of the try block (was a local `const` inside it) so the
  // catch block below can reach it: a stalled/failed exec() still leaves a
  // live ffmpeg.wasm worker running in the background otherwise, burning
  // CPU in this popup window for no further purpose. See the catch block's
  // terminate() call.
  let ffmpeg: any = null;
  try {
    const ffmpegModuleUrl = chrome.runtime.getURL("ffmpeg-vendor/ffmpeg/index.js");
    const utilModuleUrl = chrome.runtime.getURL("ffmpeg-vendor/util/index.js");
    const [ffmpegModule, utilModule] = await Promise.all([import(ffmpegModuleUrl), import(utilModuleUrl)]);
    const { FFmpeg } = ffmpegModule as { FFmpeg: new () => any };
    const { fetchFile } = utilModule as {
      fetchFile: (data: Blob) => Promise<Uint8Array>;
    };

    // Deliberately NOT wrapped in @ffmpeg/util's toBlobURL() (an earlier
    // version did, following the library's own CDN-loading examples).
    // toBlobURL() exists to dodge CORS when ffmpeg-core is hosted
    // cross-origin (a CDN); these files are vendored INSIDE this extension
    // and served from its own moz-extension://<id>/ origin — the exact
    // same origin as recorder.html itself — so there is no CORS reason to
    // blob-ify them at all. Passing the extension URLs straight through
    // means the module-type Worker's internal `import(coreURL)` targets a
    // normal 'self'-origin script, matching what script-src already
    // allows unconditionally — sidestepping the blob:-URL-as-script-source
    // restriction entirely instead of trying yet another CSP permutation
    // to permit it (adding `blob:` to different CSP directives was tried
    // and never changed the outcome — see ARCHITECTURE.md for why that
    // pointed here).
    const coreJsUrl = chrome.runtime.getURL("ffmpeg-vendor/core/ffmpeg-core.js");
    const coreWasmUrl = chrome.runtime.getURL("ffmpeg-vendor/core/ffmpeg-core.wasm");

    ffmpeg = new FFmpeg();
    // A retest with a real 4K source (3840x2160, cropped down to
    // 1258x710) surfaced a THIRD ffmpeg.wasm failure mode, worse than the
    // crash and stall modes already handled elsewhere in this function: it
    // printed emscripten's `Aborted()` partway through (right after muxing
    // only ~2kB of audio against 532kB of video for a 6.78s clip — almost
    // none of the audio track actually made it out), yet `exec()` still
    // RESOLVED normally afterward and `readFile()` still returned a
    // non-empty file, so the existing try/catch had nothing to catch and
    // this function reported success with a corrupt, nearly-silent output.
    // `onAborted` below watches every log line for that exact string and
    // is raced alongside `exec()` (see `aborted` further down) so this
    // failure mode surfaces as a real rejection — falling back to the raw
    // uncropped recording (which does have full audio — confirmed from
    // this same source file's own "Stream #0:1(eng): Audio: opus..." input
    // line) instead of silently shipping the truncated file as if it were
    // fine.
    // The progress bar would show briefly then the button would sit on
    // "Saving..." indefinitely: earlier handling already anticipated
    // ffmpeg.wasm CRASHING mid-encode (a thrown WASM RuntimeError, caught
    // by the try/catch around this whole function) but never anticipated
    // it HANGING instead — silently stopping all progress with no error
    // ever thrown, which the existing try/catch cannot help with because
    // nothing ever rejects. Nothing else in this file (or in
    // background.ts's own SAVE_WATCHDOG_MS) covers this specific step —
    // that watchdog only guards the LATER save-helper hand-off, after this
    // function has already returned — so a real stall here left
    // onRecorderStopped() awaiting forever, which is exactly "Saving…"
    // never resolving. `lastActivityAt` is refreshed on every progress
    // tick (and once more right before exec() starts); a separate
    // watchdog interval fails the whole crop the moment activity has
    // truly stopped for STALL_TIMEOUT_MS, instead of only reacting to an
    // exception that may never come. A 12s source clip re-encoding for 30s
    // with literally zero further progress is not "still working slowly",
    // it's stuck — falling back to the uncropped raw recording (the
    // existing, already-proven safety net one line below in the catch
    // block) costs the person a wrong crop, never the whole recording.
    const STALL_TIMEOUT_MS = 30000;
    let lastActivityAt = Date.now();
    // Replaces an earlier reliance on ffmpeg.wasm's own `progress` event
    // entirely. Reported symptom: the fill bar disappears almost
    // immediately, then "Saving" just sits there with no further
    // indication for the rest of the crop. Root cause, found directly in
    // this file's own ffmpeg logs: every source here is a live-muxed webm
    // straight out of MediaRecorder, and its own "Input #0" line always
    // reads `Duration: N/A` — ffmpeg genuinely has no idea how long the
    // input is. The built-in `progress` event's 0..1 fraction is computed
    // from that same unknown duration, so it can't produce a meaningful
    // value here; whatever it falls back to internally likely explains the
    // "shows briefly, then stuck" symptom, since `Number.isFinite()` would
    // only ever let an occasional accidental number through. The real
    // total duration is already known on this side, though — it's simply
    // the wall-clock length of the recording that was just stopped
    // (`recorderStartMs`, captured at `recorder.start()` above) — so
    // progress is now computed directly from the `time=HH:MM:SS.ss`
    // timestamp ffmpeg already prints on every single log line while
    // encoding, divided by that known duration, instead of trusting a
    // fraction ffmpeg itself can't actually compute. This also closes a
    // related gap in the stall watchdog: it used to refresh
    // `lastActivityAt` only from that same unreliable `progress` event, so
    // a real multi-second 4K encode producing no valid `progress` ticks
    // could in principle run the 30s stall timer down while genuinely
    // still working; parsing every log line's timestamp instead means
    // activity is tracked from the same frequent signal now driving the UI.
    const approxDurationSec = Math.max(0.1, (Date.now() - recorderStartMs) / 1000);
    const FFMPEG_TIME_RE = /time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/;
    let onAborted: (() => void) | null = null;
    ffmpeg.on("log", ({ message }: { message: string }) => {
      logToBackground(`ffmpeg: ${message}`);
      if (onAborted && typeof message === "string" && message.includes("Aborted()")) onAborted();
      const timeMatch = typeof message === "string" ? message.match(FFMPEG_TIME_RE) : null;
      if (timeMatch) {
        lastActivityAt = Date.now();
        const elapsedSec = Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3]);
        const progress = Math.min(1, Math.max(0, elapsedSec / approxDurationSec));
        chrome.runtime.sendMessage({ target: "background", type: "CROP_PROGRESS", progress }).catch(() => {});
      }
    });
    await ffmpeg.load({
      coreURL: coreJsUrl,
      wasmURL: coreWasmUrl,
    });
    lastActivityAt = Date.now();

    const ext = extensionForMimeType(mimeType) || "webm";
    const inputName = `input.${ext}`;
    const outputName = `output.${ext}`;
    await ffmpeg.writeFile(inputName, await fetchFile(blob));
    lastActivityAt = Date.now();

    // For webm, stream-COPY the audio instead of re-encoding it through
    // libopus. The crop filter (`-vf crop=...`) only ever touches the
    // VIDEO stream — Firefox's MediaRecorder always produces opus audio in
    // this webm source already (confirmed directly in this same file's
    // own ffmpeg log: "Stream #0:1(eng): Audio: opus, 48000 Hz, mono,
    // fltp"), so re-encoding opus-to-opus was pure, unnecessary extra work
    // competing for the same constrained WASM heap as the video encode. On
    // a 4K-sourced retest this showed up as ffmpeg printing `Aborted()`
    // partway through — almost none of the audio (2kB out of an expected
    // ~54kB for a 6.78s clip) actually made it into the muxed output
    // before that happened. `-c:a copy` removes the audio decode+encode
    // step entirely (a near-free stream copy instead), both curing the
    // specific memory-pressure trigger observed here and guaranteeing
    // bit-identical, full-length original audio in the cropped file. mp4
    // still re-encodes to aac — its source is still opus, and
    // opus-in-mp4 isn't reliably playable everywhere the way aac-in-mp4
    // is, so that leg keeps the re-encode.
    // Force EVEN width/height (not just >= 2). The source is always
    // yuv420p (chroma subsampled 2:1 in both dimensions), and an odd crop
    // dimension leaves the chroma planes half a pixel short, which is
    // invalid for this pixel format. Every crop rect observed so far in
    // the logs happened to already be even, so this wasn't provably the
    // cause of an earlier crash investigated here — but it's a real latent
    // bug either way, worth closing now that a crash is actually reachable
    // here to reason about.
    const w = Math.max(2, Math.round(rect.width / 2) * 2);
    const h = Math.max(2, Math.round(rect.height / 2) * 2);
    const x = Math.max(0, Math.round(rect.x));
    const y = Math.max(0, Math.round(rect.y));
    // Cropping requires re-encoding (can't "-c:v copy" through a filter).
    // For webm, re-encode to `libvpx` (VP8) instead of `libvpx-vp9` —
    // matching the SOURCE codec (Firefox's MediaRecorder always produces
    // vp8 here, see video-format.ts) rather than transcoding to a
    // different one for no reason. libvpx-vp9 is substantially more
    // memory-hungry than libvpx/vp8 in this WASM build (multi-frame
    // lookahead buffering even at default settings), and the retest that
    // reached real encoding for the first time crashed with a WASM-level
    // `RuntimeError: index out of bounds` partway into encoding a
    // 4K-sourced, single-threaded-WASM-core transcode — a memory-pressure
    // crash signature, not a CSP/loading one. `-deadline realtime
    // -cpu-used 5` on both encoders cuts internal buffering/lookahead
    // further, for the same reason. See ARCHITECTURE.md for the full
    // reasoning and the caveat that this is not fully confirmed — if it
    // still crashes, the likely next conclusion is a genuine memory
    // ceiling in this single-threaded core at 4K, not a further
    // encoder-flag tweak.
    const codecArgs =
      ext === "mp4"
        ? ["-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac"]
        : ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "5", "-c:a", "copy"];
    // Race the actual encode against the stall watchdog defined above.
    // `ffmpeg.exec()` itself has no way to be cancelled once started
    // (there's no AbortSignal support, and terminate() kills the whole
    // worker rather than just this call) — Promise.race() doesn't stop the
    // abandoned exec() call from continuing to run in the background, but
    // it DOES let this function return (and the caller fall back to the
    // raw recording) instead of awaiting it forever. `ffmpeg.terminate()`
    // afterward kills that abandoned worker outright, so it stops burning
    // CPU in a background tab instead of running to completion (or
    // crashing) unobserved.
    let stallWatchdog: ReturnType<typeof setInterval> | null = null;
    const stalled = new Promise<never>((_, reject) => {
      stallWatchdog = setInterval(() => {
        if (Date.now() - lastActivityAt > STALL_TIMEOUT_MS) {
          reject(new Error(`ffmpeg crop stalled — no progress for ${STALL_TIMEOUT_MS / 1000}s, presumed hung`));
        }
      }, 2000);
    });
    // See `onAborted` above: a third race participant that rejects the
    // instant the log stream shows emscripten's `Aborted()`, instead of
    // letting `exec()` resolve "successfully" over a truncated/corrupt
    // output.
    const aborted = new Promise<never>((_, reject) => {
      onAborted = () => reject(new Error("ffmpeg reported Aborted() mid-encode — output would be corrupt/truncated"));
    });
    // A real 4K retest showed the crop being thrown away even though the
    // encode had genuinely finished: the log's own "video:1002kB
    // audio:18kB ... muxing overhead: 0.75%" summary — which ffmpeg only
    // ever prints once a run has completely finished encoding AND
    // muxing — appeared BEFORE the `Aborted()` line, and the reported
    // duration (14.32s) matched the full recording exactly, not a
    // truncated prefix of it. So treating any `Aborted()` as proof of a
    // corrupt/truncated output was too broad: at least on this build,
    // ffmpeg.wasm's CLI wrapper appears to sometimes print this as part of
    // its own normal per-run teardown, not only as a genuine mid-encode
    // crash. The `-c:a copy` fix above (removing the audio re-encode that
    // was the real source of the memory pressure behind a genuine abort)
    // is unchanged and still in effect below — instead of discarding the
    // run outright on `Aborted()`, `aborted`/`stalled` winning the race is
    // treated as "unclear" rather than "failed", and the code falls
    // through to actually check the output file before deciding.
    let raceError: unknown = null;
    try {
      await Promise.race([
        ffmpeg.exec(["-i", inputName, "-vf", `crop=${w}:${h}:${x}:${y}`, ...codecArgs, outputName]),
        stalled,
        aborted,
      ]);
    } catch (err) {
      raceError = err;
      logToBackground(
        `cropRecordedBlobWithFfmpeg(): exec() did not settle cleanly (${String(err)}) — checking whether the output file is usable anyway before giving up on the crop`
      );
    } finally {
      if (stallWatchdog) clearInterval(stallWatchdog);
      onAborted = null;
    }

    // Left untyped (ffmpeg's own module is loaded via untyped dynamic
    // import()) rather than annotated `Uint8Array`, which TS's lib.dom
    // types as `ArrayBufferView<ArrayBuffer>` — stricter than what
    // readFile() actually returns (a view whose backing buffer type isn't
    // guaranteed) and than Blob's own BlobPart type needs. Passed straight
    // to Blob, not via `data.buffer`, since readFile() isn't guaranteed to
    // return a view that spans its whole underlying buffer.
    //
    // Always attempted, even after a raced-out exec()/aborted()/stalled()
    // above: if the encode had actually already finished writing
    // output.{ext} to the virtual FS before whatever made the race settle,
    // this recovers a perfectly good cropped file instead of discarding
    // it. If it genuinely didn't finish (a true hang, or a crash deep
    // enough to take the FS down with it), readFile() itself throws or
    // comes back empty, and the existing catch block below still falls
    // back to the raw uncropped recording exactly as before.
    const data = await ffmpeg.readFile(outputName);
    if (!data || data.length === 0) {
      throw raceError instanceof Error ? raceError : new Error(`ffmpeg produced an empty output file (race outcome: ${String(raceError)})`);
    }
    if (raceError) {
      logToBackground(
        `cropRecordedBlobWithFfmpeg(): exec() reported "${String(raceError)}", but output.${ext} has ${data.length} bytes on disk — using it rather than discarding a likely-complete crop`
      );
    }
    const croppedBlob = new Blob([data], { type: mimeType });
    logToBackground(`cropRecordedBlobWithFfmpeg(): done, outputBytes=${croppedBlob.size}`);
    return croppedBlob.size > 0 ? croppedBlob : null;
  } catch (err) {
    logToBackground(`cropRecordedBlobWithFfmpeg() FAILED — will save the UNCROPPED raw recording instead: ${String(err)}`);
    // A stalled/crashed exec() otherwise keeps its worker alive in the
    // background after this function has already given up and moved on;
    // terminate() is best-effort (never allowed to mask the real error
    // above, or to throw past this function at all).
    try {
      ffmpeg?.terminate?.();
    } catch {
      /* best effort */
    }
    return null;
  }
}

function updateTimer(): void {
  const elapsedMs = Date.now() - startedAt;
  const totalSec = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  timeEl.textContent = `${mm}:${ss}`;
}

async function finalize(reason = "unknown"): Promise<void> {
  if (finished) return;
  finished = true;
  logToBackground(
    `finalize() called (reason=${reason}) recorder=${recorder ? recorder.state : "null"} recorderStartedOk=${recorderStartedOk} chunks=${chunks.length} elapsedSinceRecorderStart=${recorderStartedOk ? Date.now() - recorderStartMs : "n/a"}ms`
  );
  // Tell the popup/sidepanel *right now*, before anything async below (the
  // MediaRecorder stop()->onstop round trip, then the save-helper.html
  // hand-off) — otherwise its own elapsed-time display keeps climbing for
  // as long as that takes (up to the 20s save watchdog in the worst case)
  // even though this window's own timer already stopped, which read as
  // "addon's timer keeps going, the recorder window's froze" (reported bug).
  chrome.runtime.sendMessage({ target: "background", type: "RECORDING_STOPPING" }).catch(() => {});
  if (timerHandle) clearInterval(timerHandle);
  if (frameProbeHandle) clearInterval(frameProbeHandle);
  stopBtn.disabled = true;
  cancelBtn.disabled = true;
  dotEl.style.animation = "none";
  dotEl.style.opacity = "0.3";

  if (recorder && recorder.state !== "inactive") {
    // Force-flush whatever's already buffered right before stop() (same
    // fix used elsewhere for the onstop-may-never-fire quirk — see
    // ARCHITECTURE.md), then don't just wait on onstop indefinitely — race
    // it against a short grace period that finishes the save from `chunks`
    // as they stand either way. onRecorderStopped() itself is
    // idempotency-guarded, so whichever of the two (onstop event, or this
    // timer) runs first wins and the other is a no-op.
    try {
      recorder.requestData?.();
    } catch {
      /* best effort */
    }
    recorder.stop();
    setTimeout(() => {
      if (recorderStopHandled) return; // onstop already fired and handled it
      console.error(
        "ScreenRec: MediaRecorder.onstop never fired within the grace period (known Firefox quirk, see ARCHITECTURE.md) — finishing from buffered chunks anyway"
      );
      onRecorderStopped();
    }, RECORDER_STOP_GRACE_MS);
  } else {
    await onRecorderStopped();
  }
  (displayStream?.getTracks() || []).forEach((tr) => tr.stop());
}

async function onRecorderStopped(): Promise<void> {
  if (recorderStopHandled) return; // already ran, via onstop or the grace-period fallback
  recorderStopHandled = true;
  // Defaults to true (the normal "saved" / "user cancelled before anything
  // started" paths still auto-close quickly) — only the genuine-failure
  // branch below turns this off, so the error message actually stays on
  // screen long enough to read/report instead of vanishing with it.
  let shouldAutoClose = true;
  try {
    if (chunks.length > 0) {
      const ext = extensionForMimeType(currentMimeType);
      let blob = new Blob(chunks, { type: currentMimeType });

      if (mode === "area" && areaCropRect) {
        statusEl.textContent = t("recorderCropping", lang);
        const cropped = await cropRecordedBlobWithFfmpeg(blob, areaCropRect, currentMimeType);
        if (cropped) {
          blob = cropped;
        }
        // cropRecordedBlobWithFfmpeg() already logged the reason on failure;
        // falling through and saving the original `blob` (uncropped) means a
        // bug in the new ffmpeg integration costs the user a wrong crop, not
        // the whole recording.
      }

      const blobId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await storeBlobRecord(blobId, { blob, createdAt: Date.now() });
      statusEl.textContent = t("recorderDone", lang);
      // Append the crop diagnosis (cropDebugTag) right into the saved
      // filename for area-mode recordings, so it survives however the file
      // reaches us (upload here, a screenshot of the downloads list,
      // anything) without depending on a console log at all. Only letters/
      // digits/hyphen/underscore/"x" by construction (see cropDebugTag's
      // assignments above), so no extra sanitizing is needed before it goes
      // into a filename.
      const baseFilename = timestampName(ext, new Date(), "ScreenRec-");
      const filename =
        mode === "area" && cropDebugTag
          ? baseFilename.replace(new RegExp(`\\.${ext}$`), `_dbg-${cropDebugTag}.${ext}`)
          : baseFilename;
      await chrome.runtime.sendMessage({
        target: "background",
        type: "SAVE_RECORDING_BLOB",
        blobId,
        filename,
        mode,
      });
    } else if (recorderStartedOk) {
      // recorder.start() genuinely ran (the user saw the timer/preview) but
      // stop() produced zero bytes of data — a real failure, not someone
      // cancelling before anything began. Previously this fell into the
      // same silent RECORDING_CANCELLED path as an intentional cancel, so
      // the window just closed a couple of seconds later with no
      // explanation and nothing saved — indistinguishable from "it's
      // broken" with no way to tell why. Now it's reported distinctly
      // (reason: "no_data") so background.ts can show an actual error
      // notification, matching what the Chrome/offscreen.ts path already
      // does for the equivalent failure.
      logToBackground(
        `recorder stopped with 0 bytes captured. ${recorderSetupError ? "Last MediaRecorder error: " + String(recorderSetupError) : "(MediaRecorder never reported an error event — the shared source likely ended on its own.)"}`
      );
      statusEl.textContent = t("recorderErrorNoData", lang);
      statusEl.style.color = "#e04343";
      await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "no_data" });
      shouldAutoClose = false;
    } else {
      // This is the third and last silent-close path in this file (no
      // console output of its own before this round) — reached whenever
      // finalize() runs before recorder.start() ever got to set
      // recorderStartedOk=true, e.g. the shared source ended (see the
      // 'ended' log above) while still inside computeAreaCropRect()'s early
      // awaits, or getDisplayMedia() itself never resolved successfully.
      logToBackground("finishing via the silent user_cancelled path — recorder never started (see the logs above for why)");
      await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "user_cancelled" });
    }
  } finally {
    // Release the mic-mixing graph (closes the AudioContext, stops the
    // getUserMedia() mic stream) before stopping the original tab-audio
    // track(s) it replaced — same ordering as offscreen.ts's cleanup, and
    // for the same reason (stopping them first would silence half the mix
    // while it might still be flushing).
    stopMicMix(activeMicMix);
    activeMicMix = null;
    detachedTabAudioTracks.forEach((t) => t.stop());
    detachedTabAudioTracks = [];
    await chrome.storage.session.remove([
      "pendingRect",
      "pendingRectDpr",
      "pendingRectViewportW",
      "pendingRectViewportH",
      "pendingRectTabId",
    ]);
    if (shouldAutoClose) setTimeout(() => window.close(), 1200);
  }
}

stopBtn.addEventListener("click", () => finalize("stop_clicked"));
cancelBtn.addEventListener("click", async () => {
  finished = true;
  // Same reasoning as the top of finalize() above: freeze the popup/
  // sidepanel's own timer immediately rather than let it keep counting
  // while this window's own MediaRecorder.stop()/onstop round trip runs.
  chrome.runtime.sendMessage({ target: "background", type: "RECORDING_STOPPING" }).catch(() => {});
  if (timerHandle) clearInterval(timerHandle);
  if (frameProbeHandle) clearInterval(frameProbeHandle);
  if (recorder && recorder.state !== "inactive") {
    chunks = []; // discard
    const finishCancel = async () => {
      if (cancelHandled) return; // onstop already fired and handled it, or the grace timer already did
      cancelHandled = true;
      await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "user_cancelled" });
      window.close();
    };
    // Same Firefox onstop-may-never-fire quirk as finalize() (see
    // ARCHITECTURE.md) — without a grace-period fallback here too,
    // cancelling an area-mode recording could leave this window stuck open
    // forever with nothing ever telling background the recording ended.
    recorder.onstop = finishCancel;
    recorder.stop();
    setTimeout(finishCancel, RECORDER_STOP_GRACE_MS);
  } else {
    await chrome.runtime.sendMessage({ target: "background", type: "RECORDING_CANCELLED", reason: "user_cancelled" });
    window.close();
  }
  (displayStream?.getTracks() || []).forEach((tr) => tr.stop());
});

// Allow the background script to ask us to stop (e.g. via hotkey).
chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === "RECORDER_STOP_REQUEST") {
    finalize("stop_request_message");
    sendResponse({ ok: true });
  }
});

init();
