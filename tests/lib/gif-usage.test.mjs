import { test } from "node:test";
import assert from "node:assert/strict";
import { rankGifFiles } from "../../build/ts/lib/gif-usage.js";

test("rankGifFiles keeps manifest order when nothing has usage yet", () => {
  const files = ["a.gif", "b.gif", "c.gif"];
  assert.deepEqual(rankGifFiles(files, {}), files);
});

test("rankGifFiles floats the most-used file to the top", () => {
  const files = ["a.gif", "b.gif", "c.gif"];
  const usage = { c: 5, "c.gif": 5 };
  assert.deepEqual(rankGifFiles(files, usage), ["c.gif", "a.gif", "b.gif"]);
});

test("rankGifFiles breaks ties by original manifest order", () => {
  const files = ["a.gif", "b.gif", "c.gif", "d.gif"];
  const usage = { "a.gif": 2, "b.gif": 2, "c.gif": 1 };
  // a and b tie at count=2 -> a stays before b (lower original index);
  // c comes next at count=1; d (unused) comes last.
  assert.deepEqual(rankGifFiles(files, usage), ["a.gif", "b.gif", "c.gif", "d.gif"]);
});

test("rankGifFiles ignores usage entries for files no longer in the manifest", () => {
  const files = ["a.gif", "b.gif"];
  const usage = { "ghost.gif": 99, "a.gif": 1 };
  assert.deepEqual(rankGifFiles(files, usage), ["a.gif", "b.gif"]);
});
