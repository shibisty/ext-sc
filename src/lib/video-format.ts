// Recording format/quality selection — duplicated between offscreen.js and
// recorder.js (the Firefox fallback recorder window), extracted here.

export const WEBM_CANDIDATES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export const MP4_CANDIDATES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4;codecs=h264,aac",
  "video/mp4",
];

// Video-ONLY counterparts of the two lists above, for a stream that
// genuinely has no audio track — background.ts's frame-stitch
// canvas.captureStream() path for Firefox area-mode recording (a
// still-image capture API has no audio to offer, unlike tabCapture/
// getDisplayMedia). Reusing WEBM_CANDIDATES/MP4_CANDIDATES there turned out
// to be the actual root cause of that path's long-standing "0 bytes" bug,
// which earlier investigation had chased through onstop-timing and
// canvas-compositing theories instead: constructing a MediaRecorder with a
// mimeType that names an audio codec (opus/aac) against a stream with zero
// audio tracks left Firefox's internal muxer waiting on audio data that
// would never arrive, so MediaRecorder.ondataavailable never fired — even
// though the video track itself was being drawn to correctly the whole
// time (confirmed via diagnostics showing framesDrawn was non-zero while
// chunks stayed empty regardless).
export const WEBM_VIDEO_ONLY_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export const MP4_VIDEO_ONLY_CANDIDATES = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=h264", "video/mp4"];

// The MediaRecorder.isTypeSupported check is what makes this DOM-dependent;
// it's taken as a parameter (rather than read from `window.MediaRecorder`
// directly) so the ordering/fallback logic itself can be unit-tested with a
// fake predicate, independent of any particular browser's real codec
// support.
function pickSupportedMimeTypeFrom(
  webmCandidates: readonly string[],
  mp4Candidates: readonly string[],
  preferMp4: boolean,
  isTypeSupported: (candidate: string) => boolean
): string | null {
  const ordered = preferMp4 ? [...mp4Candidates, ...webmCandidates] : [...webmCandidates, ...mp4Candidates];
  for (const c of ordered) {
    if (isTypeSupported(c)) return c;
  }
  return null;
}

export function pickSupportedMimeType(
  preferMp4: boolean,
  isTypeSupported: (candidate: string) => boolean
): string | null {
  return pickSupportedMimeTypeFrom(WEBM_CANDIDATES, MP4_CANDIDATES, preferMp4, isTypeSupported);
}

// Same as pickSupportedMimeType, but only ever returns a codec combination
// with no audio codec named — for MediaRecorder instances backed by a
// stream that has no audio track (see the comment above on the
// VIDEO_ONLY_CANDIDATES lists).
export function pickSupportedVideoOnlyMimeType(
  preferMp4: boolean,
  isTypeSupported: (candidate: string) => boolean
): string | null {
  return pickSupportedMimeTypeFrom(WEBM_VIDEO_ONLY_CANDIDATES, MP4_VIDEO_ONLY_CANDIDATES, preferMp4, isTypeSupported);
}

// Real-browser wrapper around pickSupportedMimeType, used by offscreen.ts
// and recorder.ts (both of those streams can carry audio).
export function pickSupportedMimeTypeInBrowser(preferMp4: boolean): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return pickSupportedMimeType(preferMp4, (c) => MediaRecorder.isTypeSupported(c));
}

// Real-browser wrapper around pickSupportedVideoOnlyMimeType, used by
// background.ts's frame-stitch (video-only) recording path.
export function pickSupportedVideoOnlyMimeTypeInBrowser(preferMp4: boolean): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return pickSupportedVideoOnlyMimeType(preferMp4, (c) => MediaRecorder.isTypeSupported(c));
}

export function extensionForMimeType(mimeType: string | null): "mp4" | "webm" {
  return mimeType != null && mimeType.includes("mp4") ? "mp4" : "webm";
}

export type VideoQuality = "low" | "medium" | "high" | "auto";

export const QUALITY_BITRATES: Partial<Record<VideoQuality, number>> = {
  low: 1_000_000,
  medium: 2_500_000,
  high: 6_000_000,
  // "auto" (or anything else) → no explicit bitrate, browser default
};

export async function getVideoBitrate(): Promise<number | null> {
  try {
    const { videoQuality = "auto" } = await chrome.storage.local.get<{ videoQuality?: VideoQuality }>([
      "videoQuality",
    ]);
    return QUALITY_BITRATES[videoQuality] ?? null;
  } catch {
    return null;
  }
}

export async function getPreferredVideoFormat(): Promise<string> {
  try {
    const { videoFormat = "webm" } = await chrome.storage.local.get<{ videoFormat?: string }>([
      "videoFormat",
    ]);
    return videoFormat;
  } catch {
    return "webm";
  }
}
