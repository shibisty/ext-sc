// Every recording path in this codebase only ever captured tab or system
// audio (whatever a chromeMediaSource:"tab" grant or getDisplayMedia()'s own
// share-audio checkbox handed over) despite the "Include audio" setting's
// own label always having promised "mic/tab/system" — an actual microphone
// (for narrating over a demo, say) was never requested anywhere. This module
// adds that.
//
// Combining two independent live audio sources into the single track
// MediaRecorder needs (feeding it a stream with two separate, un-mixed
// audio tracks has inconsistent cross-browser encoding behavior; one track
// does not) always goes through the Web Audio API
// (MediaStreamAudioSourceNode -> MediaStreamAudioDestinationNode) — see
// mixAudioTracks() below. Where that mixing needs to happen is NOT always
// where the microphone itself is requested, though: an AudioContext is a
// page-scoped object that browsers tear down when its page unloads, same
// as any other page-owned resource — fine for offscreen.ts's tabCapture
// path and recorder.ts's popup window, both of which stay alive for the
// whole recording, but NOT fine for app.ts's screen-mode relay flow, which
// explicitly tells the person they can close that popup once the WebRTC
// connection is up (a raw hardware-backed MediaStreamTrack keeps flowing
// through an already-established RTCPeerConnection after its page
// unloads — that's the entire reason the relay architecture exists — but
// an AudioContext's synthesized output track does not survive its page
// going away). So: requestMicrophone() is safe to call anywhere: it only
// ever opens a raw getUserMedia() stream, never an AudioContext. The
// mixing itself (mixAudioTracks(), mixInMicrophone()) belongs only in a
// context that will still be running for the rest of the recording — see
// each caller for which one it is.

export interface MicMixResult {
  // The single audio track to feed into the recording — a genuinely mixed
  // track when two real sources were available, just the one that was
  // available when only one was, or null when neither was.
  track: MediaStreamTrack | null;
  // Present only when actual mixing happened — the caller must close()
  // this once the recording ends, to release its audio graph.
  audioContext: AudioContext | null;
  // Present only when THIS call opened the microphone itself (via
  // mixInMicrophone(), not the lower-level mixAudioTracks()) — the caller
  // must stop() its tracks once the recording ends, same as any other
  // stream it opened directly.
  micStream: MediaStream | null;
}

// Never throws: returns null on denial/failure/no device, so a microphone
// permission problem costs audio, never the whole recording.
export async function requestMicrophone(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    // See app.ts's primeMicrophonePermission() for why this spells out
    // .name/.message instead of logging the raw DOMException: it doesn't
    // extend Error, and logging it as a bare object argument prints
    // "[object DOMException]" once copy-pasted as plain text.
    const detail = e instanceof DOMException || e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`ScreenRec: microphone request failed — recording will only include tab/system audio, if any: ${detail}`);
    return null;
  }
}

// Pure mixing of two already-available tracks — opens no microphone of its
// own. Skips the AudioContext graph entirely whenever only one (or
// neither) side is actually present, which is both simpler and avoids
// that graph being able to introduce a NEW bug (added latency, resampling
// artifacts) for what's actually the common case: a silent tab with
// narration-only audio, or vice versa.
export function mixAudioTracks(a: MediaStreamTrack | null, b: MediaStreamTrack | null): { track: MediaStreamTrack | null; audioContext: AudioContext | null } {
  if (a && !b) return { track: a, audioContext: null };
  if (!a && b) return { track: b, audioContext: null };
  if (!a && !b) return { track: null, audioContext: null };
  try {
    const audioContext = new AudioContext();
    const destination = audioContext.createMediaStreamDestination();
    audioContext.createMediaStreamSource(new MediaStream([a as MediaStreamTrack])).connect(destination);
    audioContext.createMediaStreamSource(new MediaStream([b as MediaStreamTrack])).connect(destination);
    return { track: destination.stream.getAudioTracks()[0] || null, audioContext };
  } catch (e) {
    console.error("ScreenRec: mixing two audio tracks failed — falling back to just the first one", e);
    return { track: a, audioContext: null };
  }
}

// requestMicrophone() + mixAudioTracks() combined, for a context that can
// safely own both the getUserMedia() call and the resulting AudioContext
// itself (see this file's header comment for which contexts that is).
export async function mixInMicrophone(existingAudioTracks: MediaStreamTrack[]): Promise<MicMixResult> {
  const micStream = await requestMicrophone();
  const micTrack = micStream ? micStream.getAudioTracks()[0] || null : null;
  const { track, audioContext } = mixAudioTracks(micTrack, existingAudioTracks[0] || null);
  return { track, audioContext, micStream };
}

// Releases everything a MicMixResult holds. Safe to call on one where
// nothing was actually granted/mixed (every field already null), and safe
// to call with null itself (nothing was ever attempted).
export function stopMicMix(result: MicMixResult | null): void {
  if (!result) return;
  if (result.micStream) result.micStream.getTracks().forEach((t) => t.stop());
  if (result.audioContext) result.audioContext.close().catch(() => {});
}
