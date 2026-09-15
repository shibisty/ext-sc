import { test } from "node:test";
import assert from "node:assert/strict";
import { isRestrictedUrl } from "../../build/ts/lib/restricted-url.js";

test("isRestrictedUrl treats missing/empty urls as restricted", () => {
  assert.equal(isRestrictedUrl(undefined), true);
  assert.equal(isRestrictedUrl(null), true);
  assert.equal(isRestrictedUrl(""), true);
});

test("isRestrictedUrl flags internal browser pages", () => {
  assert.equal(isRestrictedUrl("chrome://extensions"), true);
  assert.equal(isRestrictedUrl("chrome-extension://abcdef/popup.html"), true);
  assert.equal(isRestrictedUrl("edge://settings"), true);
  assert.equal(isRestrictedUrl("about:blank"), true);
  assert.equal(isRestrictedUrl("moz-extension://abcdef/page.html"), true);
  assert.equal(isRestrictedUrl("view-source:https://example.com"), true);
  assert.equal(isRestrictedUrl("devtools://devtools/bundled/inspector.html"), true);
  assert.equal(isRestrictedUrl("data:text/html,<h1>hi</h1>"), true);
});

test("isRestrictedUrl flags extension store pages, old and new Chrome Web Store domain alike", () => {
  assert.equal(isRestrictedUrl("https://chrome.google.com/webstore/detail/x"), true);
  // Regression test: chromewebstore.google.com is the *current* Chrome Web
  // Store origin. Missing this was the actual cause of "Uncaught (in
  // promise) Error: The extensions gallery cannot be scripted" — the guard
  // let a Web Store tab through as "safe", so background.ts went ahead and
  // called chrome.scripting/chrome.tabCapture on it, which Chrome refuses.
  assert.equal(isRestrictedUrl("https://chromewebstore.google.com/detail/x"), true);
  assert.equal(isRestrictedUrl("https://microsoftedge.microsoft.com/addons/detail/x"), true);
  assert.equal(isRestrictedUrl("https://addons.mozilla.org/en-US/firefox/addon/x"), true);
});

test("isRestrictedUrl allows ordinary pages", () => {
  assert.equal(isRestrictedUrl("https://example.com"), false);
  assert.equal(isRestrictedUrl("https://github.com/anthropics"), false);
  assert.equal(isRestrictedUrl("http://localhost:3000"), false);
  // chrome.google.com serves plenty of non-Web-Store pages too.
  assert.equal(isRestrictedUrl("https://chrome.google.com/intl/en/chrome/"), false);
});

test("isRestrictedUrl does not false-positive on ordinary URLs that merely contain a restricted-looking substring", () => {
  // Regression test: the old implementation matched with a plain
  // `url.includes(p)`, so any normal page whose URL happened to *contain*
  // one of these substrings (query params, redirects, hash fragments) was
  // wrongly treated as a restricted browser/system page.
  assert.equal(isRestrictedUrl("https://example.com/redirect?to=about:blank"), false);
  assert.equal(isRestrictedUrl("https://example.com/go?url=chrome-extension://abc/x.html"), false);
  assert.equal(isRestrictedUrl("https://example.com/page#data:text/plain,hi"), false);
});
