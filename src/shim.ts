// Cross-browser compatibility shim.
//
// This extension's code is written entirely against the `chrome.*`
// namespace, called with `await` (Promise style) — the way Chrome's
// Manifest V3 APIs work. Firefox instead exposes its WebExtension APIs
// only under the `browser` namespace, already Promise-based, and does not
// provide a reliable `chrome.*` alias of its own. Rather than rewriting
// every call site, we point `chrome` at the native `browser` object before
// anything else runs — after that, every existing `await chrome.xxx()`
// call in this codebase works unchanged, because `browser.xxx()` already
// returns a promise.
//
// In Chrome (and other Chromium-based browsers) this is a no-op: `browser`
// is undefined there, so nothing is overwritten.
//
// This file has no imports/exports on purpose: that keeps it valid both as
// a native ES module (`import "./shim.js"`, used by every background/page
// entry point) and as a classic script (prepended in the `files` array of
// every `chrome.scripting.executeScript()` call that injects a content
// script — those can't be ES modules). Load it FIRST in either case.
if (typeof browser !== "undefined" && typeof chrome === "undefined") {
  (globalThis as any).chrome = browser;
}
