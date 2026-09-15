// Rectangle clamping for the area-selection overlay.
//
// The original (select-overlay.js) reached for `window.innerWidth` /
// `window.innerHeight` directly inside clampRect, which is correct for a
// content script but impossible to unit-test without a DOM. Here the
// viewport is passed in explicitly — select-overlay.ts calls this with
// `{ width: window.innerWidth, height: window.innerHeight }`, and tests
// call it with fixed numbers.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export const MIN_SELECTION_SIZE = 20;

export function clampRect(r: Rect, viewport: Viewport, minSize: number = MIN_SELECTION_SIZE): Rect {
  let { x, y, width, height } = r;
  width = Math.max(minSize, width);
  height = Math.max(minSize, height);
  x = Math.min(Math.max(0, x), Math.max(0, viewport.width - width));
  y = Math.min(Math.max(0, y), Math.max(0, viewport.height - height));
  width = Math.min(width, viewport.width - x);
  height = Math.min(height, viewport.height - y);
  return { x, y, width, height };
}
