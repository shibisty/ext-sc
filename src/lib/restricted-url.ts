// Pages the extension must never try to inject scripts or capture into
// (chrome.scripting / chrome.tabCapture throw on these anyway, but we check
// up front so we can show a friendly notification instead of a raw error).
//
// Only lived in background.js before; extracted so it can be unit-tested
// without pulling in chrome.tabs/chrome.notifications.
//
// v2 (bugfix round): the original implementation matched every entry with
// a plain `url.includes(p)`. That has two real failure modes that users hit
// in practice:
//   1. False NEGATIVE — Chrome moved the Web Store to a new origin,
//      chromewebstore.google.com (the old chrome.google.com/webstore is now
//      mostly just a redirect). That new origin wasn't in the list, so
//      isRestrictedUrl() said a Web Store tab was fine to inject into. It
//      isn't — chrome.scripting.executeScript / chrome.tabCapture throw
//      "The extensions gallery cannot be scripted", and because that threw
//      from deep inside an async message handler with no matching catch, it
//      surfaced as an uncaught promise rejection and could leave recording
//      state stuck (see background.ts's onMessage listener).
//   2. False POSITIVE — matching by plain substring means a perfectly
//      normal URL that merely *contains* one of these strings (e.g.
//      "https://example.com/redirect?to=about:blank" or a page whose path
//      happens to contain "chrome-extension://") gets flagged as
//      restricted, even though it's a normal page chrome.scripting can
//      inject into fine.
//
// Fixing both means actually parsing the URL and checking its scheme/host,
// rather than searching the raw string.

export const RESTRICTED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "about:",
  "moz-extension:",
  "view-source:",
  "devtools:",
  "data:",
];

// Extension-gallery / add-on-store hosts. `paths` (optional) narrows the
// match to a path prefix on that host, for hosts that also serve ordinary
// content outside the store section (chrome.google.com hosts more than the
// webstore).
const RESTRICTED_HOSTS: Array<{ host: string; pathPrefix?: string }> = [
  { host: "chrome.google.com", pathPrefix: "/webstore" },
  { host: "chromewebstore.google.com" },
  { host: "microsoftedge.microsoft.com", pathPrefix: "/addons" },
  { host: "addons.mozilla.org" },
];

function hostMatches(hostname: string, target: string): boolean {
  return hostname === target || hostname.endsWith(`.${target}`);
}

export function isRestrictedUrl(url: string | undefined | null): boolean {
  if (!url) return true;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable absolute URL — be conservative and fall back to a
    // scheme-prefix check rather than assuming it's safe.
    return RESTRICTED_SCHEMES.some((s) => url.startsWith(s));
  }

  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return true;

  return RESTRICTED_HOSTS.some(({ host, pathPrefix }) => {
    if (!hostMatches(parsed.hostname, host)) return false;
    return !pathPrefix || parsed.pathname.startsWith(pathPrefix);
  });
}
