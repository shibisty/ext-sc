import { test } from "node:test";
import assert from "node:assert/strict";
import { clampRect, MIN_SELECTION_SIZE } from "../../build/ts/lib/rect.js";

const VIEWPORT = { width: 1000, height: 800 };

test("clampRect leaves an in-bounds rect untouched", () => {
  const r = { x: 10, y: 20, width: 100, height: 50 };
  assert.deepEqual(clampRect(r, VIEWPORT), r);
});

test("clampRect enforces a minimum size", () => {
  const r = { x: 0, y: 0, width: 2, height: 3 };
  const out = clampRect(r, VIEWPORT);
  assert.equal(out.width, MIN_SELECTION_SIZE);
  assert.equal(out.height, MIN_SELECTION_SIZE);
});

test("clampRect pulls a rect back inside the viewport on the right/bottom edges", () => {
  const r = { x: 950, y: 780, width: 100, height: 100 };
  const out = clampRect(r, VIEWPORT);
  assert.equal(out.x + out.width, VIEWPORT.width);
  assert.equal(out.y + out.height, VIEWPORT.height);
});

test("clampRect pulls a rect back inside the viewport on negative x/y", () => {
  const r = { x: -50, y: -30, width: 100, height: 60 };
  const out = clampRect(r, VIEWPORT);
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
});

test("clampRect shrinks width/height that overflow the viewport even from x=0", () => {
  const r = { x: 0, y: 0, width: 5000, height: 4000 };
  const out = clampRect(r, VIEWPORT);
  assert.equal(out.width, VIEWPORT.width);
  assert.equal(out.height, VIEWPORT.height);
});
