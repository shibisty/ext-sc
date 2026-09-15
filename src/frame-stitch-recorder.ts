// Owns the canvas + MediaRecorder for Firefox area-mode video recording,
// injected into the RECORDED TAB itself via chrome.scripting.executeScript
// — exactly like annotate-overlay.ts and select-overlay.ts. (See the
// comment on canvas.style below for how this canvas is sized/positioned
// within the tab.)
//
// This canvas/MediaRecorder pair does not live in background.ts, inside the
// extension's own background page, because that was the actual root cause
// of a "Saving…"/"Stopping…" hang: a background page is never composited as
// a visible surface, and canvas.captureStream() + MediaRecorder need one to
// produce anything at all. Confirmed empirically — the recording produced
// exactly 0 bytes, not just at the stop/cutover moment, meaning
// MediaRecorder.ondataavailable never fired even once during minutes of
// "recording". The recorded tab itself IS a real, rendering document, so
// this file recreates the same canvas/MediaRecorder machinery there
// instead. Like select-overlay.ts, this must compile to a classic
// (non-module) script — chrome.scripting.executeScript can only inject
// those — so every declaration lives inside the top-level IIFE.
//
// Division of labor with background.ts:
// - background.ts still does the privileged chrome.tabs.captureVisibleTab()
//   screenshots (content scripts can't call that at all) on the same
//   ~500ms interval as before, crops each one down to the recording rect
//   itself (a plain synchronous 2D canvas crop — that part never needed a
//   real rendering surface, only captureStream()/MediaRecorder did), and
//   pushes the resulting small PNG over to this module via
//   chrome.tabs.sendMessage — as raw bytes (an ArrayBuffer), not a data:
//   URL string. Any string-URL-based decode inside this content script (an
//   <img> src, a fetch() call) runs in the RECORDED PAGE's own context and
//   is subject to that page's CSP, which can silently kill frame decoding.
//   This module just builds a Blob from the raw bytes it's handed and draws
//   each decoded frame onto its own canvas — see drawFrame's comment below.
// - Handing the FINISHED video blob back to the extension is the one part
//   that's genuinely harder from here: IndexedDB is origin-scoped, and a
//   content script's IndexedDB is the PAGE's origin (e.g. https://
//   example.com), not the extension's moz-extension:// origin — so this
//   can't call into src/lib/blob-db.ts's storeBlobRecord() directly the way
//   background.ts used to. Instead the finished blob is base64-encoded via
//   FileReader and streamed back to background in bounded-size chunks over
//   chrome.runtime.sendMessage (well under any plausible message-size
//   limit, chunked defensively since a raw video blob could otherwise be
//   large), where it's reassembled and handed to the existing
//   blob-db.ts/saveRecordingBlobDirectly pipeline unchanged.

(() => {
  type ScreenrecWindow = Window &
    typeof globalThis & {
      __screenrecFrameStitchLoaded__?: boolean;
      __screenrecStartFrameStitch__?: (
        outW: number,
        outH: number,
        mimeType: string,
        bitrate: number | undefined,
        fps: number,
        dpr: number
      ) => void;
    };
  const win = window as ScreenrecWindow;

  // Re-injected per recording start (background.ts always injects the file
  // fresh via executeScript before calling the start function below), but
  // guard anyway in case of a stray double-injection — same pattern as
  // annotate-overlay.ts/select-overlay.ts.
  if (win.__screenrecFrameStitchLoaded__) return;
  win.__screenrecFrameStitchLoaded__ = true;

  // TypeScript's DOM lib doesn't know about CanvasCaptureMediaStreamTrack
  // (the video track canvas.captureStream() returns) or its requestFrame()
  // method — declared locally, same pattern as ScreenrecWindow above.
  interface CanvasCaptureTrack extends MediaStreamTrack {
    requestFrame(): void;
  }

  interface Session {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    recorder: MediaRecorder;
    track: CanvasCaptureTrack;
    requestFrameIntervalHandle: ReturnType<typeof setInterval> | null;
    chunks: Blob[];
    finished: boolean;
    framesDrawn: number; // diagnostic only — see finishSession's "empty" branch
    dataAvailableEvents: number; // diagnostic only — every ondataavailable call, even 0-byte ones
    dataAvailableBytesTotal: number; // diagnostic only
    frameDecodeErrors: number; // diagnostic only — see drawFrame's frame-decode handling below
    diagSamplesLogged: number; // see the pixel-brightness diagnostic in drawFrame
  }

  // Mirrors background.ts's sampleBrightness() — downscales a source into
  // an 8x8 thumbnail and reports max/avg brightness. The cropped frame
  // background.ts sends is already known to have real content; this
  // samples the CANVAS ITSELF right after drawImage, in the exact same tab
  // context where captureStream()/MediaRecorder actually run, to confirm
  // the canvas's own backing buffer holds that same real content right up
  // to the moment it's handed to the recorder.
  function sampleBrightness(source: CanvasImageSource, sw: number, sh: number): { max: number; avg: number } {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx.drawImage(source, 0, 0, sw, sh, 0, 0, 8, 8);
    const data = ctx.getImageData(0, 0, 8, 8).data;
    let max = 0;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = Math.max(data[i], data[i + 1], data[i + 2]);
      if (v > max) max = v;
      sum += v;
    }
    return { max, avg: Math.round(sum / (data.length / 4)) };
  }

  let session: Session | null = null;

  // Same grace period as background.ts used to run internally before this
  // module existed — short enough to feel instant to whoever clicked "Stop
  // recording".
  const STOP_GRACE_MS = 2500;
  // Comfortably under any sane runtime.sendMessage payload limit, chunked
  // defensively since a full recording's base64 data URL can be large.
  const BLOB_CHUNK_SIZE = 6 * 1024 * 1024;

  function tellBackground(msg: Record<string, unknown>): void {
    try {
      chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});
    } catch {
      // Extension context can vanish mid-recording (extension reloaded,
      // tab navigating away right now) — nothing more to do from here.
    }
  }

  async function finishSession(s: Session, source: string): Promise<void> {
    if (s.finished) return;
    s.finished = true;
    if (s.requestFrameIntervalHandle !== null) {
      clearInterval(s.requestFrameIntervalHandle);
      s.requestFrameIntervalHandle = null;
    }
    try {
      s.canvas.width = 0; // release the backing buffer promptly
      if (s.chunks.length === 0) {
        // Diagnostic fields only, not used for control flow. recorderState
        // is close to useless on its own — stop() sets it to "inactive"
        // essentially immediately, whether or not anything was ever
        // actually captured — but dataAvailableEvents/BytesTotal answer the
        // question recorderState can't: did ondataavailable fire AT ALL
        // (even with 0-byte payloads), or did it never fire once? Checking
        // only chunks.length (which only counts NON-EMPTY payloads) would
        // make "event fired but always empty" and "event never fired" look
        // identical, so both counters are tracked separately.
        tellBackground({
          type: "FRAME_STITCH_TAB_RESULT",
          ok: false,
          reason: "empty",
          source,
          framesDrawn: s.framesDrawn,
          recorderState: s.recorder.state,
          dataAvailableEvents: s.dataAvailableEvents,
          dataAvailableBytesTotal: s.dataAvailableBytesTotal,
          frameDecodeErrors: s.frameDecodeErrors,
        });
        return;
      }
      // Log the same diagnostics on the SUCCESS path too, not just the
      // "empty" failure above — a correct-length file can still be a
      // solid-black video with framesDrawn genuinely at 0 the whole time,
      // and without this there'd be no way to see that after the fact.
      // Cheap to always send; expensive to have to add after the next
      // surprise.
      tellBackground({
        type: "FRAME_STITCH_TAB_LOG",
        message: `frame-stitch session succeeding: framesDrawn=${s.framesDrawn} frameDecodeErrors=${s.frameDecodeErrors} dataAvailableEvents=${s.dataAvailableEvents} dataAvailableBytesTotal=${s.dataAvailableBytesTotal}`,
      });
      const mimeType = s.recorder.mimeType || "video/webm";
      const blob = new Blob(s.chunks, { type: mimeType });
      const dataUrl: string = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error || new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
      const total = Math.max(1, Math.ceil(dataUrl.length / BLOB_CHUNK_SIZE));
      for (let i = 0; i < total; i++) {
        tellBackground({
          type: "FRAME_STITCH_TAB_BLOB_CHUNK",
          index: i,
          total,
          mimeType,
          chunk: dataUrl.slice(i * BLOB_CHUNK_SIZE, (i + 1) * BLOB_CHUNK_SIZE),
        });
      }
      tellBackground({ type: "FRAME_STITCH_TAB_RESULT", ok: true, source });
    } catch (e) {
      tellBackground({ type: "FRAME_STITCH_TAB_RESULT", ok: false, reason: "exception", message: String(e), source });
    } finally {
      if (session === s) session = null;
      try {
        s.canvas.remove();
      } catch {
        /* already gone */
      }
    }
  }

  win.__screenrecStartFrameStitch__ = (outW, outH, mimeType, bitrate, fps, dpr) => {
    if (session) return; // a start message arriving twice shouldn't spawn a second recorder
    const canvas = document.createElement("canvas");
    canvas.width = outW;
    canvas.height = outH;
    // Positioning this canvas off the visible viewport, and separately
    // shrinking its CSS display size down to 1px×1px to stay invisible,
    // both still produced a 0-byte recording — even with frames confirmed
    // drawn (framesDrawn > 0) and a video-only mimeType. The CSS-shrink
    // case is suspect on its own: a canvas with a large backing resolution
    // (outW×outH, which for a high-DPR display can be several times the CSS
    // pixel dimensions of the selected area) displayed at a forced 1×1 CSS
    // box asks the browser to downscale it enormously for paint — plausibly
    // enough for a compositor-driven captureStream() to end up sampling a
    // degenerate/empty surface.
    //
    // So instead: no CSS scaling at all. The canvas is shown at its true
    // 1:1 device-pixel size — CSS width/height set to outW/dpr and
    // outH/dpr, i.e. exactly the recording rect's own CSS pixel
    // dimensions, the same relationship any normal high-DPR canvas uses
    // (canvas.width = cssWidth * dpr, style.width = cssWidth + "px") — so
    // there's no scaling operation between the drawing buffer and what's
    // actually painted. Pinned to the viewport's top-left corner (always
    // within the viewport by construction, since the recording rect is by
    // definition a crop of what's currently visible).
    const cssW = Math.max(1, Math.round(outW / dpr));
    const cssH = Math.max(1, Math.round(outH / dpr));
    canvas.style.position = "fixed";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    // An earlier experiment forced opacity to 1, making the canvas
    // genuinely visible on-screen, to test whether captureStream() was
    // sampling the canvas's COMPOSITED (opacity-multiplied) appearance
    // instead of its raw backing buffer. That was disproven: the canvas
    // painted correct, real content on-screen (visible as a "duplicated
    // window" effect, since the canvas is a near-full-viewport screenshot
    // of the very page it's overlaid on) — background.ts's and this
    // module's own pixel diagnostics agreed — and the saved video was
    // STILL solid black regardless, so compositing/opacity is eliminated
    // as a cause. Reverted to imperceptible (0.02) since there's no reason
    // to keep the UX regression — see the comment on canvas.captureStream()
    // below for where the investigation goes next.
    canvas.style.opacity = "0.02";
    canvas.style.pointerEvents = "none";
    canvas.style.zIndex = "2147483647";
    (document.documentElement || document.body).appendChild(canvas);
    // Pixel diagnostics in background.ts proved real, non-trivial image
    // content (max/avg brightness well above 0) is present at BOTH the raw
    // chrome.tabs.captureVisibleTab() screenshot AND the cropped PNG
    // actually sent to this content script — ruling out a blank capture or
    // a broken crop rectangle. Combined with framesDrawn>0/
    // frameDecodeErrors=0, every step up to and including ctx.drawImage()
    // is independently confirmed to have real data flowing through it.
    // That leaves the canvas→captureStream()→MediaRecorder leg itself as
    // the only unverified link — and this canvas's 2D context was created
    // with the DEFAULT { alpha: true }, meaning captureStream() may treat
    // the stream as carrying an alpha channel. Canvas-sourced alpha over
    // WebM/VP8 is a non-standard, rarely-exercised path (real alpha support
    // requires an OS-specific codec extension most players, including VLC,
    // don't handle) — exactly the kind of edge case that would silently
    // produce empty-looking (black) output despite genuinely-drawn source
    // content. This canvas never needs transparency — it's a
    // solid-black-filled recording surface — so alpha is explicitly turned
    // off at creation, removing any opportunity for the encoder to treat
    // this as anything but a plain opaque RGB stream.
    const ctx = canvas.getContext("2d", { alpha: false }) as CanvasRenderingContext2D;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, outW, outH);

    const recorderOptions: MediaRecorderOptions = { mimeType };
    if (bitrate) recorderOptions.videoBitsPerSecond = bitrate;
    // canvas.captureStream(fps) leaves it up to the browser's own internal
    // timer to decide when to sample the canvas. Real draws WERE landing on
    // this canvas — framesDrawn>0, frameDecodeErrors=0, and MediaRecorder
    // genuinely encoding a real volume of bytes (dataAvailableBytesTotal in
    // the megabytes) — yet the saved video was still solid black for its
    // entire length. The only remaining explanation is that automatic
    // captureStream(fps) sampling itself wasn't actually seeing those draws
    // on this canvas (plausibly tied to how the browser schedules
    // paint/compositing for an almost-fully-transparent element, though the
    // exact internal reason is moot). Fix: captureStream(0) turns OFF
    // automatic sampling entirely, and this module instead calls the
    // resulting CanvasCaptureMediaStreamTrack's requestFrame() itself — once
    // immediately after every successful drawImage (see drawFrame below)
    // and once on an fps-paced timer as a heartbeat. Per spec,
    // requestFrame() captures the canvas's actual current drawing-buffer
    // content at the moment it's called, which is exactly what automatic
    // sampling was apparently failing to do here.
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0] as unknown as CanvasCaptureTrack;
    // With decode, drawImage, the canvas's own backing buffer, AND its
    // on-screen composited appearance now all independently proven correct
    // and the video still solid black regardless, a completely different
    // mechanism is worth checking directly: a MediaStreamTrack has a
    // `muted` state, distinct from `enabled`/`readyState`. Per spec, a
    // MUTED video track outputs solid BLACK frames instead of its real
    // source content, while still reporting as "live" and still delivering
    // data downstream (a recorder included) — meaning a muted track would
    // explain every symptom seen so far (correct source, correct canvas,
    // still-black output) without caring at all about opacity, visibility,
    // alpha, or automatic vs. manual frame requests. Logging only for now,
    // not yet acted on:
    tellBackground({
      type: "FRAME_STITCH_TAB_LOG",
      message: `frame-stitch track state at creation: muted=${track.muted} enabled=${track.enabled} readyState=${track.readyState}`,
    });
    track.onmute = () => {
      tellBackground({ type: "FRAME_STITCH_TAB_LOG", message: "frame-stitch track MUTED" });
    };
    track.onunmute = () => {
      tellBackground({ type: "FRAME_STITCH_TAB_LOG", message: "frame-stitch track UNMUTED" });
    };
    const recorder = new MediaRecorder(stream, recorderOptions);
    const chunks: Blob[] = [];
    const s: Session = {
      canvas,
      ctx,
      recorder,
      track,
      requestFrameIntervalHandle: null,
      chunks,
      finished: false,
      framesDrawn: 0,
      dataAvailableEvents: 0,
      dataAvailableBytesTotal: 0,
      frameDecodeErrors: 0,
      diagSamplesLogged: 0,
    };
    recorder.ondataavailable = (e) => {
      // Counted regardless of size — see the comment in finishSession's
      // "empty" branch on why this matters more than chunks.length alone.
      s.dataAvailableEvents++;
      if (e.data) s.dataAvailableBytesTotal += e.data.size;
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onerror = (event) => {
      tellBackground({
        type: "FRAME_STITCH_TAB_LOG",
        message: "MediaRecorder error: " + String((event as unknown as { error?: unknown }).error || event),
      });
    };
    recorder.onstop = () => {
      finishSession(s, "onstop").catch(() => {});
    };

    session = s;
    // Manual heartbeat: requests a frame at roughly the requested fps even
    // if drawFrame() itself hasn't been called recently (e.g. a slow tick
    // from background.ts), so the stream never goes completely silent.
    // drawFrame() below also requests a frame immediately after every
    // successful draw, for minimal latency between an incoming frame and
    // it actually landing in the recording.
    s.requestFrameIntervalHandle = setInterval(() => {
      try {
        s.track.requestFrame();
      } catch {
        /* best-effort — a missed heartbeat tick isn't fatal */
      }
    }, Math.max(1, Math.round(1000 / fps)));
    // Diagnostic: confirms which build actually ran, and with what
    // mimeType/resolution/CSS size, without needing another guess-and-
    // redeploy round to find out.
    tellBackground({
      type: "FRAME_STITCH_TAB_LOG",
      message: `frame-stitch recorder (forced direct getImageData flush + toDataURL taint check before requestFrame) started: mimeType=${mimeType} outW=${outW} outH=${outH} cssW=${cssW} cssH=${cssH} dpr=${dpr} fps=${fps}`,
    });
    recorder.start(1000);
  };

  function stopFrameStitch(): void {
    const s = session;
    if (!s) return;
    try {
      // Force-flush whatever's currently buffered before stopping, so the
      // grace-period fallback below has as much of the tail end of the
      // recording as possible.
      s.recorder.requestData?.();
    } catch {
      /* best-effort */
    }
    let stopCalled = false;
    try {
      if (s.recorder.state !== "inactive") {
        s.recorder.stop();
        stopCalled = true;
      }
    } catch {
      /* fall through to immediate finish below */
    }
    if (stopCalled) {
      setTimeout(() => finishSession(s, "grace-period-fallback").catch(() => {}), STOP_GRACE_MS);
    } else {
      finishSession(s, "already-inactive").catch(() => {});
    }
  }

  // A decode approach through a plain <img> element (img.onload / img.src =
  // dataUrl) produced a video that saved at the correct length but with
  // every frame solid black — just the canvas's initial fillRect, for the
  // entire duration, with no error appearing anywhere: not in this content
  // script's own diagnostics, not in background.ts's console. Loading a
  // data: URL through an <img> element is subject to the RECORDED PAGE's
  // own CSP img-src directive — a content script's DOM insertions still
  // follow the host page's CSP for resource loading — and a page that
  // restricts img-src silently fails that load: onload never fires, and
  // there's no onerror handler either to surface the failure, so
  // framesDrawn stays at 0 with literally nothing to log.
  //
  // Switching to fetch()+createImageBitmap() to decode the same data:
  // payload didn't fix it either, for a closely related reason: fetch(dataUrl)
  // still runs INSIDE this content script, i.e. in the recorded page's own
  // context, so it's still subject to that page's CSP — just a different
  // directive (connect-src/default-src instead of img-src). Any page
  // restrictive enough to block one was often restrictive enough to block
  // the other, reproducing the exact same "framesDrawn stays 0, nothing to
  // log" failure. There is no string-URL-based decode that reliably escapes
  // an arbitrary page's CSP — the actual fix is to never hand this function
  // a URL at all. background.ts instead sends the cropped frame as a raw
  // ArrayBuffer (PNG bytes) instead of a data: URL string (see the comment
  // on its sendMessage call). This function builds a Blob directly from
  // those already-in-hand bytes and decodes it with createImageBitmap(blob)
  // — no URL, no fetch, nothing left for any CSP directive to intercept.
  //
  // That fix worked as intended — framesDrawn>0, frameDecodeErrors=0,
  // MediaRecorder genuinely encoding megabytes of data — but the video was
  // STILL solid black throughout, which showed decoding and drawing were
  // never the problem; canvas.captureStream(fps)'s own automatic sampling
  // was apparently never actually seeing these draws. This function
  // explicitly calls the capture track's requestFrame() right after every
  // successful draw (see the comment on canvas.captureStream(0) above) —
  // capturing this exact canvas content at this exact moment, rather than
  // leaving it to the browser's own sampling schedule to notice.
  async function drawFrame(frameBuffer: ArrayBuffer): Promise<void> {
    const s = session;
    if (!s) return;
    try {
      const blob = new Blob([frameBuffer], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      try {
        if (session !== s) return; // stopped/replaced while this frame was decoding
        s.ctx.drawImage(bitmap, 0, 0, s.canvas.width, s.canvas.height);
        s.framesDrawn++;
        // Verified with ffprobe/ffmpeg — independent of this extension's
        // own JS-level checks entirely — that the actual encoded VP8 frames
        // are pure (0,0,0) black from the very first keyframe, even though
        // everything this content script can observe about the canvas
        // (getImageData sampling, on-screen appearance) checks out correct.
        // Known Firefox captureStream() bugs (bugzilla 1653983, 1177793,
        // 1557980) document a near-identical failure mode: canvas.toDataURL()
        // showed real content, but MediaRecorder captured almost nothing,
        // because captureStream()'s internal surface-snapshot mechanism
        // wasn't reading the same surface the canvas's own JS-visible APIs
        // read from — a genuine disconnect between "what this canvas
        // exposes to JS" and "what captureStream() actually samples
        // internally", in a different but closely analogous canvas context
        // type.
        //
        // Notably, the pixel diagnostics elsewhere in this file read this
        // canvas's content by passing it as a *source* into a SEPARATE
        // scratch canvas (sampleBrightness() below draws `s.canvas` onto
        // its own temporary 8x8 canvas, then reads THAT). That's a
        // different code path than reading directly from this canvas's own
        // 2D context — plausibly a different (possibly zero-copy/GPU-side)
        // internal path than whatever a direct getImageData() call on this
        // exact canvas forces. This canvas's own context had never been
        // read from directly until now. A direct getImageData() call is
        // specified to force a full readback of a canvas's actual backing
        // surface — doing that here, right on the canvas captureStream()
        // was called on, before requesting a capture frame, may force
        // Firefox to flush/sync whatever internal surface captureStream()
        // reads from too, in a way the existing secondary-canvas
        // diagnostic never exercised.
        try {
          s.ctx.getImageData(0, 0, 1, 1);
        } catch {
          /* best-effort forced flush — see comment above; a failure here isn't otherwise fatal */
        }
        if (s.diagSamplesLogged < 3) {
          s.diagSamplesLogged++;
          try {
            const canvasSample = sampleBrightness(s.canvas, s.canvas.width, s.canvas.height);
            tellBackground({
              type: "FRAME_STITCH_TAB_LOG",
              message: `frame-stitch canvas pixel diagnostic #${s.diagSamplesLogged}: canvas(max=${canvasSample.max},avg=${canvasSample.avg}) canvasWH=${s.canvas.width}x${s.canvas.height}`,
            });
          } catch (diagErr) {
            tellBackground({ type: "FRAME_STITCH_TAB_LOG", message: "canvas pixel diagnostic failed: " + String(diagErr) });
          }
          // Direct canvas-taint check. If this canvas were origin-tainted
          // (origin-clean=false), toDataURL() would throw a SecurityError —
          // which would also fully explain black captureStream() output by
          // spec (a tainted canvas's stream is required to be
          // blocked/blanked). createImageBitmap(Blob) is specified to never
          // taint a canvas, so this is expected to succeed, but it's cheap
          // and worth checking directly on this exact canvas.
          try {
            const url = s.canvas.toDataURL("image/png");
            tellBackground({
              type: "FRAME_STITCH_TAB_LOG",
              message: `frame-stitch canvas taint check #${s.diagSamplesLogged}: toDataURL ok, length=${url.length}`,
            });
          } catch (taintErr) {
            tellBackground({
              type: "FRAME_STITCH_TAB_LOG",
              message: `frame-stitch canvas taint check #${s.diagSamplesLogged}: toDataURL FAILED (canvas may be tainted): ${String(taintErr)}`,
            });
          }
        }
        try {
          s.track.requestFrame();
        } catch {
          /* best-effort — the fps-paced heartbeat interval still covers this frame */
        }
      } finally {
        bitmap.close();
      }
    } catch (e) {
      // A single missed frame isn't fatal for the recording as a whole,
      // but this path can actually report a failure instead of silently
      // producing a black frame forever. Capped so a persistently failing
      // page can't flood messaging.
      s.frameDecodeErrors++;
      if (s.frameDecodeErrors <= 3) {
        tellBackground({ type: "FRAME_STITCH_TAB_LOG", message: "drawFrame failed: " + String(e) });
      }
    }
  }

  chrome.runtime.onMessage.addListener((message: any) => {
    if (!message) return;
    if (message.type === "FRAME_STITCH_FRAME") {
      drawFrame(message.frameBuffer).catch(() => {});
    } else if (message.type === "FRAME_STITCH_STOP") {
      stopFrameStitch();
    }
  });
})();
