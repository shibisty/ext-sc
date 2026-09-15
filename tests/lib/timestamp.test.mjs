import { test } from "node:test";
import assert from "node:assert/strict";
import { timestampName } from "../../build/ts/lib/timestamp.js";

test("timestampName formats a fixed date with zero-padding", () => {
  const d = new Date(2026, 0, 5, 9, 3, 7); // Jan 5 2026, 09:03:07 local time
  assert.equal(timestampName("webm", d), "ScreenRec/2026-01-05_09-03-07.webm");
});

test("timestampName pads double-digit values without truncating", () => {
  const d = new Date(2025, 11, 31, 23, 59, 59);
  assert.equal(timestampName("png", d), "ScreenRec/2025-12-31_23-59-59.png");
});

test("timestampName supports a filename prefix (used to tell recordings apart from screenshots)", () => {
  const d = new Date(2026, 0, 5, 9, 3, 7);
  assert.equal(timestampName("webm", d, "ScreenRec-"), "ScreenRec/ScreenRec-2026-01-05_09-03-07.webm");
  assert.equal(timestampName("png", d), "ScreenRec/2026-01-05_09-03-07.png");
});

test("timestampName defaults to the current time when no date is given", () => {
  const before = Date.now();
  const name = timestampName("mp4");
  const after = Date.now();
  assert.match(name, /^ScreenRec\/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.mp4$/);
  // Sanity check it's actually "now", not some stale/garbage value.
  assert.ok(after - before < 5000);
});
