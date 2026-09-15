import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pickSupportedMimeType,
  pickSupportedVideoOnlyMimeType,
  extensionForMimeType,
  QUALITY_BITRATES,
  WEBM_CANDIDATES,
  MP4_CANDIDATES,
  WEBM_VIDEO_ONLY_CANDIDATES,
  MP4_VIDEO_ONLY_CANDIDATES,
} from "../../build/ts/lib/video-format.js";

function supports(...allowed) {
  return (candidate) => allowed.includes(candidate);
}

test("pickSupportedMimeType prefers webm order when mp4 isn't requested", () => {
  const isSupported = supports(...WEBM_CANDIDATES, ...MP4_CANDIDATES);
  assert.equal(pickSupportedMimeType(false, isSupported), WEBM_CANDIDATES[0]);
});

test("pickSupportedMimeType prefers mp4 order when mp4 is requested", () => {
  const isSupported = supports(...WEBM_CANDIDATES, ...MP4_CANDIDATES);
  assert.equal(pickSupportedMimeType(true, isSupported), MP4_CANDIDATES[0]);
});

test("pickSupportedMimeType falls back to the other family when the preferred one is unsupported", () => {
  const isSupported = supports(WEBM_CANDIDATES[2]); // only the bare "video/webm"
  assert.equal(pickSupportedMimeType(true, isSupported), WEBM_CANDIDATES[2]);
});

test("pickSupportedMimeType returns null when nothing is supported", () => {
  assert.equal(pickSupportedMimeType(false, () => false), null);
});

test("extensionForMimeType maps mp4 vs everything else", () => {
  assert.equal(extensionForMimeType("video/mp4;codecs=h264,aac"), "mp4");
  assert.equal(extensionForMimeType("video/webm;codecs=vp9,opus"), "webm");
  assert.equal(extensionForMimeType(null), "webm");
});

test("WEBM_VIDEO_ONLY_CANDIDATES and MP4_VIDEO_ONLY_CANDIDATES never name an audio codec (regression guard)", () => {
  // This is the exact bug: a candidate here naming an audio codec (opus,
  // aac, mp4a) would get picked for background.ts's frame-stitch stream,
  // which has no audio track, and silently produce 0-byte recordings again
  // — see the comment on WEBM_VIDEO_ONLY_CANDIDATES in video-format.ts.
  for (const candidate of [...WEBM_VIDEO_ONLY_CANDIDATES, ...MP4_VIDEO_ONLY_CANDIDATES]) {
    assert.doesNotMatch(candidate, /opus|aac|mp4a/i, `${candidate} names an audio codec`);
  }
});

test("pickSupportedVideoOnlyMimeType prefers webm order when mp4 isn't requested", () => {
  const isSupported = supports(...WEBM_VIDEO_ONLY_CANDIDATES, ...MP4_VIDEO_ONLY_CANDIDATES);
  assert.equal(pickSupportedVideoOnlyMimeType(false, isSupported), WEBM_VIDEO_ONLY_CANDIDATES[0]);
});

test("pickSupportedVideoOnlyMimeType prefers mp4 order when mp4 is requested", () => {
  const isSupported = supports(...WEBM_VIDEO_ONLY_CANDIDATES, ...MP4_VIDEO_ONLY_CANDIDATES);
  assert.equal(pickSupportedVideoOnlyMimeType(true, isSupported), MP4_VIDEO_ONLY_CANDIDATES[0]);
});

test("pickSupportedVideoOnlyMimeType falls back to the other family when the preferred one is unsupported", () => {
  const isSupported = supports(WEBM_VIDEO_ONLY_CANDIDATES[2]); // only the bare "video/webm"
  assert.equal(pickSupportedVideoOnlyMimeType(true, isSupported), WEBM_VIDEO_ONLY_CANDIDATES[2]);
});

test("pickSupportedVideoOnlyMimeType returns null when nothing is supported", () => {
  assert.equal(pickSupportedVideoOnlyMimeType(false, () => false), null);
});

test("QUALITY_BITRATES has no entry for auto (browser default applies)", () => {
  assert.equal(QUALITY_BITRATES.auto, undefined);
  assert.equal(QUALITY_BITRATES.low, 1_000_000);
  assert.equal(QUALITY_BITRATES.medium, 2_500_000);
  assert.equal(QUALITY_BITRATES.high, 6_000_000);
});
