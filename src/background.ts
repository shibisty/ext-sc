// Background service worker (MV3). Coordinates hotkeys, screenshots and
// video recording. Recording itself happens in a persistent "offscreen"
// document (chrome.offscreen) so it keeps running after the popup/side
// panel is closed. Falls back to a small recorder window on browsers that
// don't support chrome.offscreen / chrome.tabCapture (e.g. Firefox).
//
// IMPORTANT: MV3 service workers can be unloaded by the browser at any time
// after a short idle period. Any state kept only in plain JS variables here
// would be silently lost mid-recording (the offscreen document keeps
// recording, but the service worker "forgets" about it). To avoid that,
// all recording state is mirrored into chrome.storage.session, which
// survives service worker restarts within the same browser session.

import { deleteBlobRecord, getBlobRecord, storeBlobRecord, blobToDataURL, purgeStaleBlobRecords } from "./lib/blob-db.js";
import { timestampName } from "./lib/timestamp.js";
import { isRestrictedUrl } from "./lib/restricted-url.js";
import { resolveLang, type Lang, type LangPref } from "./i18n.js";
import {
  pickSupportedMimeTypeInBrowser,
  pickSupportedVideoOnlyMimeTypeInBrowser,
  extensionForMimeType,
  getVideoBitrate,
  getPreferredVideoFormat,
} from "./lib/video-format.js";

const HAS_OFFSCREEN = !!(chrome.offscreen && chrome.offscreen.createDocument);
const HAS_TAB_CAPTURE = !!(chrome.tabCapture && chrome.tabCapture.getMediaStreamId);
// `chrome.clipboard.setImageData` throws "Access to extension API denied" on
// real Chrome (Windows) even though it's documented by Chrome itself as
// "works only on ChromeOS" — the `chrome.clipboard` object and its methods
// still EXIST (non-undefined) on regular desktop Chrome, they just throw
// this exact error the instant they're actually called there. So the old
// `!!(chrome.clipboard && chrome.clipboard.setImageData)` check
// (mere existence) always evaluated true on desktop Chrome too, not just
// Firefox, even though — per this function's own usage below and its
// surrounding comment — it was only ever meant to detect Firefox's real,
// working `browser.clipboard.setImageData()`. Gated on the same
// Firefox-detection idiom app.ts already uses elsewhere in this codebase
// (openShortcutsPage()) rather than trusting the API object's mere
// presence.
const IS_FIREFOX = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
const HAS_CLIPBOARD_API = IS_FIREFOX && !!(chrome.clipboard && chrome.clipboard.setImageData);

interface RecordingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RecordingState {
  isRecording: boolean;
  isSaving: boolean; // true from "Stop" click until the file is actually saved (or fails)
  recordingStartedAt: number | null;
  recorderWindowId: number | null; // fallback path only
  recordingTabId: number | null; // set for "tab"/"area" modes so the UI can jump back to it
  recordingTabTitle: string | null;
  // Only set for "area" mode recordings — kept around (not just passed as a
  // local variable) so the tabs.onUpdated listener below can re-inject the
  // annotation overlay with the same crop if the recorded page reloads or
  // navigates out from under an in-progress recording (see that listener's
  // comment for why that happens and why losing the overlay looked like the
  // extension "stopped responding").
  recordingRect: RecordingRect | null;
  recordingDpr: number | null;
  // 0..1 fraction reported by recorder.ts's ffmpeg.wasm crop step (relayed
  // via the "CROP_PROGRESS" message, straight from FFmpeg's own
  // `on("progress", ...)` event) so the popup/side panel can show a real
  // filling progress bar, inside the button itself, instead of a static
  // "Saving…" the person has no way to gauge. null whenever there's no crop
  // step to report on (full-tab/full-screen saves, or area-mode with
  // cropping skipped) — the UI falls back to an indeterminate animation
  // in that case rather than a bar stuck at 0%.
  savingProgress: number | null;
  // Prevents starting more than one area selection at once — without this,
  // repeatedly triggering area selection could open several overlapping
  // selection overlays. True from the moment an area-selection overlay is
  // injected until it's confirmed, cancelled, or its tab goes away. Shared
  // (not a local variable in startAreaSelection()) so it's the single
  // source of truth every trigger — the popup's and side panel's own
  // button, both keyboard shortcuts, and the toggle-recording hotkey's
  // "area" branch — checks before starting another one, AND so the
  // popup/side panel's 1s GET_STATE poll (the same mechanism already used
  // for isRecording/isSaving) can hide the trigger buttons in both
  // surfaces at once while it's true.
  isSelectingArea: boolean;
  selectingAreaTabId: number | null;
  // Which tab (if any) actually has the on-page draw/GIF
  // annotation overlay injected right now, for teardown ONLY. Deliberately
  // separate from recordingTabId: that field means "the tab being
  // recorded" (shown in the UI, used by FOCUS_RECORDING_TAB) and is
  // intentionally left null for screen mode, since the share picker can
  // capture a different tab/window/the entire screen — showing a
  // misleading "Recording: <tab>" or jumping to a tab that isn't actually
  // what's being captured would be worse than showing nothing. But screen
  // mode CAN still get a draw-tool overlay injected into whichever tab the
  // popup/side panel was open on when recording started (app.ts's own
  // INJECT_VIDEO_ANNOTATION_OVERLAY message) — this field is what lets
  // resetRecordingState() find and tear that overlay down too, without
  // touching recordingTabId's own meaning at all.
  annotationOverlayTabId: number | null;
}

const DEFAULT_STATE: RecordingState = {
  isRecording: false,
  isSaving: false,
  recordingStartedAt: null,
  recorderWindowId: null,
  recordingTabId: null,
  recordingTabTitle: null,
  recordingRect: null,
  recordingDpr: null,
  savingProgress: null,
  isSelectingArea: false,
  selectingAreaTabId: null,
  annotationOverlayTabId: null,
};

let state: RecordingState = { ...DEFAULT_STATE };

// Watchdog for the SAVE_RECORDING_BLOB -> save-helper.html -> SAVE_RECORDING_RESULT
// round trip (see that handler below). If the helper window never reports
// back at all — e.g. it silently fails to load/run, with no exception for
// us to catch — nothing would otherwise ever clear "isSaving"/notify the
// user: the save would just vanish with no trace, no error, no log entry.
// Keyed by blobId so a result (however late) can cancel its own watchdog.
const SAVE_WATCHDOG_MS = 20000;
const pendingSaveWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();

// A hard ceiling on recording length exists because, without one, a person
// has no way to know in advance that a very long recording might fail to
// save at all — they would just keep recording and only find out the hard
// way, at the least convenient possible moment, exactly what this cap
// exists to prevent. Every recording path in this codebase (recorder.ts's
// `chunks: Blob[]`, offscreen.ts's `recordedChunks: Blob[]`) buffers the
// ENTIRE recording in memory for its whole duration — nothing here streams
// to disk — so there was never actually an unlimited amount of recording
// time available; there was just no visible limit.
//
// 20 minutes, chosen from the two concrete memory-pressure data points this
// project actually has, not an arbitrary round number:
//   - At "high" quality (6 Mbps, the top explicit tier in
//     QUALITY_BITRATES — "auto" leaves it to the browser's own default,
//     which can go considerably higher at e.g. 4K) a 20-minute recording is
//     already ~900 MB of buffered Blob chunks alone, before anything else.
//   - Area mode's ffmpeg.wasm crop step (Firefox) needs the ENTIRE raw blob
//     AND its own internal encode buffers AND the output blob in memory
//     simultaneously — a real WASM memory-ceiling crash was hit cropping a
//     single 4K recording, well under this cap's length.
// Longer than this multiplies both risks for comparatively little benefit
// (most screen recordings/demos this extension is built for run well under
// 20 minutes) — but this is a considered engineering estimate, not an
// empirically-tested ceiling; if it's wrong for real usage, it's one
// constant to change, not a redesign.
//
// Enforced from setState() below (the single funnel every recording-start
// already goes through) rather than from each individual start-recording
// function — schedules once, the instant `isRecording` actually flips
// true, and is cleared the instant it flips false, so it can never fire
// against a LATER, unrelated recording. DURATION_WARNING_LEAD_MS is when
// the popup/side panel switches its timer to a visible countdown warning
// (see app.ts's refreshRecordingState()) — the whole point being that the
// person sees this coming and can wrap up on their own terms, rather than
// just being cut off with no notice. Reaching the cap itself calls the
// same stopRecording() the Stop button calls — never a silent truncation —
// so whatever was recorded up to that point is still properly cropped/
// saved, exactly as if the person had clicked Stop themselves.
const MAX_RECORDING_DURATION_MS = 20 * 60 * 1000;
const DURATION_WARNING_LEAD_MS = 2 * 60 * 1000;
let durationCapTimer: ReturnType<typeof setTimeout> | null = null;

function clearDurationCapTimer(): void {
  if (durationCapTimer) {
    clearTimeout(durationCapTimer);
    durationCapTimer = null;
  }
}

const stateReady = chrome.storage.session
  .get<Partial<RecordingState>>(Object.keys(DEFAULT_STATE))
  .then((stored) => {
    state = { ...DEFAULT_STATE, ...stored };
  })
  .catch(() => {});

// Fire-and-forget: clears out any blob records left behind by a recording
// whose save never completed in a previous session (see purgeStaleBlobRecords'
// own comment in blob-db.ts for why this matters especially on Firefox,
// where this background page can stay alive — and accumulating these —
// for a whole long browsing session).
purgeStaleBlobRecords().catch(() => {});

async function setState(partial: Partial<RecordingState>): Promise<void> {
  state = { ...state, ...partial };
  try {
    await chrome.storage.session.set(partial);
  } catch (e) {
    console.error("ScreenRec: failed to persist state", e);
  }
  // The video-duration cap (see MAX_RECORDING_DURATION_MS's own
  // comment above for why 20 minutes and why this is enforced from here).
  // Scheduled exactly once, the instant `isRecording` actually flips to
  // true — not on every setState() call while it's already true (a fresh
  // recording's very first setState() is always the one that sets
  // `isRecording: true` in its `partial`, so this condition alone is
  // enough to fire only once per recording) — and cleared the instant it
  // flips to false, so a stale timer from an earlier, already-finished
  // recording can never fire against a later, unrelated one.
  if (partial.isRecording === true) {
    clearDurationCapTimer();
    durationCapTimer = setTimeout(() => {
      durationCapTimer = null;
      console.error(`ScreenRec: recording reached the ${MAX_RECORDING_DURATION_MS / 60000}-minute cap — stopping and saving automatically`);
      stopRecording().catch((e) => console.error("ScreenRec: auto-stop at duration cap failed", e));
    }, MAX_RECORDING_DURATION_MS);
  } else if (partial.isRecording === false) {
    clearDurationCapTimer();
  }
  // Without this, the loading bar could behave strangely — sometimes not
  // appearing, or disappearing while processing was still ongoing.
  // popup.html/sidepanel.html's own refreshRecordingState() used to run
  // ONLY on a 1s setInterval poll —
  // every setState() call (isSaving flipping true/false, each ffmpeg-crop
  // savingProgress tick, ...) simply waited for the next tick to ever be
  // seen there. A save that finishes in well under a second (no crop step
  // — most full-tab/full-screen saves) could complete entirely between two
  // polls, so the "Saving…" state was sometimes never shown at all; crop
  // progress ticks (which arrive much faster than 1/sec) could look stale
  // or jump in visible steps rather than filling smoothly. Broadcasting
  // here — from the one function every state change already funnels
  // through — means every open popup/side panel refreshes itself the
  // instant something actually changes, matching the same push pattern
  // already used for the on-page overlay's own Stop button
  // (notifyTabSaving() below). Best-effort/fire-and-forget: if nothing is
  // listening (no popup or side panel currently open) this rejects and is
  // ignored, same as every other sendMessage() in this file — the 1s poll
  // in app.ts stays in place as a fallback for whenever a surface was
  // closed and just got reopened.
  chrome.runtime.sendMessage({ target: "popup", type: "STATE_CHANGED" }).catch(() => {});
}

// Keeps the on-page annotation overlay's "Stop recording" button in sync
// with the rest of the UI. The overlay's own button only ever updates
// itself (disables + shows "Stopping…") from its OWN click handler. Stop
// can equally be triggered from the popup/side panel's button, the
// recorder.html popup window's own "Stop & Save" button, or the shared
// source simply ending — none of which touch the overlay at all, so
// without this it keeps showing a fully live, clickable-looking "Stop
// recording" for the entire crop+save round trip (a real, multi-second
// wait once ffmpeg.wasm is actually running) while the popup/side panel
// has already flipped to "Saving…" — a visible mismatch between the two.
// Call this anywhere `isSaving` flips true, alongside `setState()`, so
// every UI surface moves together regardless of which one triggered the
// stop.
async function notifyTabSaving(): Promise<void> {
  const tabId = state.recordingTabId;
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "RECORDING_SAVING" });
  } catch {
    // tab may be closed, or never had the annotation overlay injected — fine
  }
}

// Clears the "an area-selection overlay is in progress" flag.
// Called from every place a selection can legitimately end: confirmed
// (handleAreaSelected), cancelled (the "RECORDING_CANCELLED" message
// select-overlay.ts's own Cancel/Esc handling sends), or the tab it was
// running in went away (tabs.onRemoved) or navigated to a different page
// out from under it (tabs.onUpdated below — a content script, and
// everything it was tracking, dies on navigation with no message sent at
// all). Without that last pair, closing or navigating the tab mid-selection
// would leave isSelectingArea stuck true forever, permanently hiding the
// trigger buttons in both surfaces — exactly the kind of stuck state this
// whole fix exists to prevent.
async function clearAreaSelectionState(): Promise<void> {
  if (!state.isSelectingArea && state.selectingAreaTabId == null) return;
  await setState({ isSelectingArea: false, selectingAreaTabId: null });
}

async function resetRecordingState(): Promise<void> {
  const tabId = state.recordingTabId;
  // See annotationOverlayTabId's own comment: for tab/area
  // modes this is always the same tab as `tabId` above (so the second
  // send below is a harmless no-op repeat); for screen mode it's the ONLY
  // record of which tab (if any) actually has an overlay to tear down,
  // since recordingTabId is deliberately null there.
  const overlayTabId = state.annotationOverlayTabId;
  await setState({
    isRecording: false,
    isSaving: false,
    recordingStartedAt: null,
    recorderWindowId: null,
    recordingTabId: null,
    recordingTabTitle: null,
    recordingRect: null,
    recordingDpr: null,
    savingProgress: null,
    annotationOverlayTabId: null,
  });
  for (const id of new Set([tabId, overlayTabId])) {
    if (id == null) continue;
    try {
      await chrome.tabs.sendMessage(id, { type: "STOP_ANNOTATION" });
    } catch {
      // tab may be closed, or never had the annotation overlay injected — fine
    }
  }
}

// ---------- Activity log (persistent — helps users find where things were saved) ----------

const ACTIVITY_LOG_KEY = "activityLog";
const ACTIVITY_LOG_MAX = 10;

interface ActivityLogEntry {
  id?: string;
  downloadId: number;
  type: "screenshot" | "video";
  filename: string;
  timestamp: number;
  mode?: string;
}

async function appendLogEntry(entry: Omit<ActivityLogEntry, "id">): Promise<void> {
  try {
    const { [ACTIVITY_LOG_KEY]: existing = [] } = await chrome.storage.local.get<{
      [ACTIVITY_LOG_KEY]: ActivityLogEntry[];
    }>([ACTIVITY_LOG_KEY]);
    const updated = [
      { ...entry, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
      ...existing,
    ].slice(0, ACTIVITY_LOG_MAX);
    await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: updated });
  } catch (e) {
    console.error("ScreenRec: failed to write activity log", e);
  }
}

// Firefox's downloads.download() has a long-standing, documented problem
// with data: URLs: MDN notes it didn't work at all before Firefox 96, and
// in practice it remains unreliable for larger payloads even afterwards —
// a base64 data: URL beyond some internal length threshold fails with
// "Type error for parameter options (Error processing url: Error: Access
// denied for URL data:...)" instead of downloading. An annotated area
// screenshot (especially with a GIF layer composited in, which inflates
// the PNG a lot) easily produces a multi-megabyte base64 string, which is
// exactly what triggered this for a real user. Converting the data: URL to
// a Blob and downloading that as a blob: URL instead — the fix MDN itself
// recommends — sidesteps the whole problem, and is exactly what
// save-helper.ts already does for recorded videos (for a different reason:
// Chrome's MV3 service worker there has no URL.createObjectURL). We only
// fall back to the raw data: URL when this context has no
// URL.createObjectURL at all (older Chrome service workers before M108) —
// that was the previously-working Chrome behavior, so it's a safe fallback
// rather than a regression.
async function toDownloadableUrl(dataUrl: string): Promise<{ url: string; revoke: () => void }> {
  if (typeof URL !== "undefined" && typeof URL.createObjectURL === "function") {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const objectUrl = URL.createObjectURL(blob);
      return { url: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl) };
    } catch (e) {
      console.error("ScreenRec: failed to convert data URL to a blob URL for download, falling back to the raw data URL", e);
    }
  }
  return { url: dataUrl, revoke: () => {} };
}

// All actual chrome.downloads.download() calls happen here, in the
// background script — some contexts (e.g. offscreen documents) don't have
// reliable access to chrome.downloads, so offscreen.js/recorder.js send us
// the data instead of downloading it themselves.
async function downloadAndLog(
  dataUrl: string,
  filename: string,
  type: "screenshot" | "video",
  extra: Partial<ActivityLogEntry> = {}
): Promise<number> {
  const { url, revoke } = await toDownloadableUrl(dataUrl);
  try {
    const downloadId = await chrome.downloads.download({ url, filename, saveAs: false });
    await appendLogEntry({ downloadId, type, filename, timestamp: Date.now(), ...extra });
    return downloadId;
  } finally {
    // Give the download manager a moment to actually start reading the
    // blob before revoking it — mirrors save-helper.ts's video-save path.
    setTimeout(revoke, 4000);
  }
}

// ---------- Settings ----------

type ScreenshotFormat = "png" | "webp";

async function getSettings(): Promise<{
  lang: string;
  autoClipboard: boolean;
  screenshotFormat: ScreenshotFormat;
  screenshotDrawToolEnabled: boolean;
  videoDrawToolEnabled: boolean;
}> {
  const {
    lang = "auto",
    autoClipboard = true,
    screenshotFormat = "png",
    // See i18n.ts's Settings interface for the full reasoning; both
    // default true (opt-out).
    screenshotDrawToolEnabled = true,
    videoDrawToolEnabled = true,
  } = await chrome.storage.local.get<{
    lang?: string;
    autoClipboard?: boolean;
    screenshotFormat?: ScreenshotFormat;
    screenshotDrawToolEnabled?: boolean;
    videoDrawToolEnabled?: boolean;
  }>(["lang", "autoClipboard", "screenshotFormat", "screenshotDrawToolEnabled", "videoDrawToolEnabled"]);
  return { lang, autoClipboard, screenshotFormat, screenshotDrawToolEnabled, videoDrawToolEnabled };
}

function screenshotMimeAndExt(format: ScreenshotFormat): { mime: string; ext: string } {
  return format === "webp" ? { mime: "image/webp", ext: "webp" } : { mime: "image/png", ext: "png" };
}

async function getUILang(): Promise<Lang> {
  // Delegates to i18n.ts's resolveLang()/matchBrowserLang() so OS
  // notifications follow the same 54-locale resolution (including "auto"
  // browser-language detection) as the rest of the UI, rather than a
  // separate, narrower hand-rolled "en"/"ru"-only check.
  const { lang } = await getSettings();
  return resolveLang(lang as LangPref);
}

type NotifKey =
  | "screenshotSavedTitle"
  | "screenshotSavedMsg"
  | "screenshotSavedClipboardMsg"
  | "clipboardFailedTitle"
  | "clipboardFailedMsg"
  | "recordingSavedTitle"
  | "recordingSavedMsg"
  | "errorTitle"
  | "errorRestrictedMsg"
  | "selectAreaTitle"
  | "selectAreaMsg";

const NOTIF_STRINGS: Record<Lang, Record<NotifKey, string>> = {
  en: {
    screenshotSavedTitle: "Screenshot saved",
    screenshotSavedMsg: "Your screenshot was downloaded.",
    screenshotSavedClipboardMsg: "Downloaded and copied to clipboard.",
    clipboardFailedTitle: "Clipboard copy failed",
    clipboardFailedMsg: "The screenshot was saved, but couldn't be copied to the clipboard.",
    recordingSavedTitle: "Recording saved",
    recordingSavedMsg: "Your video was downloaded.",
    errorTitle: "Something went wrong",
    errorRestrictedMsg:
      "This isn't possible on the browser's own internal pages or extension/add-on store pages. Please switch to a regular website tab.",
    selectAreaTitle: "Select an area",
    selectAreaMsg: "Drag on the page to select the region, then confirm.",
  },
  ru: {
    screenshotSavedTitle: "Скриншот сохранён",
    screenshotSavedMsg: "Скриншот загружен в папку загрузок.",
    screenshotSavedClipboardMsg: "Загружен и скопирован в буфер обмена.",
    clipboardFailedTitle: "Не удалось скопировать в буфер",
    clipboardFailedMsg: "Скриншот сохранён, но не удалось скопировать его в буфер обмена.",
    recordingSavedTitle: "Запись сохранена",
    recordingSavedMsg: "Видео загружено в папку загрузок.",
    errorTitle: "Что-то пошло не так",
    errorRestrictedMsg:
      "Это невозможно на служебных страницах браузера или страницах магазина расширений/дополнений. Переключитесь на обычную вкладку сайта.",
    selectAreaTitle: "Выделите область",
    selectAreaMsg: "Выделите регион на странице и подтвердите.",
  },
  "ar": {
    screenshotSavedTitle: "تم حفظ لقطة الشاشة",
    screenshotSavedMsg: "تم تنزيل لقطة الشاشة.",
    screenshotSavedClipboardMsg: "تم التنزيل والنسخ إلى الحافظة.",
    clipboardFailedTitle: "فشل النسخ إلى الحافظة",
    clipboardFailedMsg: "تم حفظ لقطة الشاشة، لكن تعذّر نسخها إلى الحافظة.",
    recordingSavedTitle: "تم حفظ التسجيل",
    recordingSavedMsg: "تم تنزيل الفيديو.",
    errorTitle: "حدث خطأ ما",
    errorRestrictedMsg: "هذا غير ممكن على الصفحات الداخلية للمتصفح أو صفحات متجر الإضافات. يُرجى الانتقال إلى تبويب موقع ويب عادي.",
    selectAreaTitle: "حدد منطقة",
    selectAreaMsg: "اسحب على الصفحة لتحديد المنطقة، ثم أكّد.",
  },
  "am": {
    screenshotSavedTitle: "ቅጽበታዊ ገጽ እይታ ተቀምጧል",
    screenshotSavedMsg: "ቅጽበታዊ ገጽ እይታዎ ወርዷል።",
    screenshotSavedClipboardMsg: "ወርዷል እና ወደ ቅንጥብ ሰሌዳ ተቀድቷል።",
    clipboardFailedTitle: "ወደ ቅንጥብ ሰሌዳ መቅዳት አልተሳካም",
    clipboardFailedMsg: "ቅጽበታዊ ገጽ እይታው ተቀምጧል፣ ነገር ግን ወደ ቅንጥብ ሰሌዳ መቅዳት አልተቻለም።",
    recordingSavedTitle: "ቅረጻ ተቀምጧል",
    recordingSavedMsg: "ቪዲዮዎ ወርዷል።",
    errorTitle: "የሆነ ስህተት ተከስቷል",
    errorRestrictedMsg: "ይህ በአሳሹ ውስጣዊ ገጾች ወይም በተጨማሪ ፕሮግራም መደብር ገጾች ላይ አይቻልም። እባክዎ ወደ መደበኛ ድር ጣቢያ ትር ይቀይሩ።",
    selectAreaTitle: "ቦታ ይምረጡ",
    selectAreaMsg: "ቦታውን ለመምረጥ በገጹ ላይ ይጎትቱ፣ ከዚያ ያረጋግጡ።",
  },
  "bg": {
    screenshotSavedTitle: "Екранната снимка е запазена",
    screenshotSavedMsg: "Снимката ви беше изтеглена.",
    screenshotSavedClipboardMsg: "Изтеглено и копирано в клипборда.",
    clipboardFailedTitle: "Копирането в клипборда се провали",
    clipboardFailedMsg: "Снимката беше запазена, но не можа да се копира в клипборда.",
    recordingSavedTitle: "Записът е запазен",
    recordingSavedMsg: "Видеото ви беше изтеглено.",
    errorTitle: "Нещо се обърка",
    errorRestrictedMsg: "Това не е възможно на вътрешните страници на браузъра или страниците на магазина за разширения. Моля, превключете към обикновен раздел на уебсайт.",
    selectAreaTitle: "Изберете област",
    selectAreaMsg: "Изтеглете върху страницата, за да изберете областта, след което потвърдете.",
  },
  "bn": {
    screenshotSavedTitle: "স্ক্রিনশট সংরক্ষিত হয়েছে",
    screenshotSavedMsg: "আপনার স্ক্রিনশট ডাউনলোড হয়েছে।",
    screenshotSavedClipboardMsg: "ডাউনলোড হয়েছে এবং ক্লিপবোর্ডে কপি হয়েছে।",
    clipboardFailedTitle: "ক্লিপবোর্ডে কপি ব্যর্থ হয়েছে",
    clipboardFailedMsg: "স্ক্রিনশট সংরক্ষিত হয়েছে, তবে ক্লিপবোর্ডে কপি করা যায়নি।",
    recordingSavedTitle: "রেকর্ডিং সংরক্ষিত হয়েছে",
    recordingSavedMsg: "আপনার ভিডিও ডাউনলোড হয়েছে।",
    errorTitle: "কিছু ভুল হয়েছে",
    errorRestrictedMsg: "ব্রাউজারের নিজস্ব অভ্যন্তরীণ পৃষ্ঠা বা এক্সটেনশন/অ্যাড-অন স্টোর পৃষ্ঠায় এটি সম্ভব নয়। অনুগ্রহ করে একটি সাধারণ ওয়েবসাইট ট্যাবে স্যুইচ করুন।",
    selectAreaTitle: "একটি এলাকা নির্বাচন করুন",
    selectAreaMsg: "অঞ্চলটি নির্বাচন করতে পৃষ্ঠায় টেনে আনুন, তারপর নিশ্চিত করুন।",
  },
  "ca": {
    screenshotSavedTitle: "Captura de pantalla desada",
    screenshotSavedMsg: "La captura s'ha baixat.",
    screenshotSavedClipboardMsg: "Baixada i copiada al porta-retalls.",
    clipboardFailedTitle: "Ha fallat la còpia al porta-retalls",
    clipboardFailedMsg: "La captura s'ha desat, però no s'ha pogut copiar al porta-retalls.",
    recordingSavedTitle: "Enregistrament desat",
    recordingSavedMsg: "El vídeo s'ha baixat.",
    errorTitle: "Alguna cosa ha anat malament",
    errorRestrictedMsg: "Això no és possible a les pàgines internes del navegador o a les pàgines de la botiga d'extensions. Canvia a una pestanya de lloc web normal.",
    selectAreaTitle: "Selecciona una àrea",
    selectAreaMsg: "Arrossega sobre la pàgina per seleccionar la regió i després confirma.",
  },
  "cs": {
    screenshotSavedTitle: "Snímek obrazovky uložen",
    screenshotSavedMsg: "Snímek obrazovky byl stažen.",
    screenshotSavedClipboardMsg: "Staženo a zkopírováno do schránky.",
    clipboardFailedTitle: "Kopírování do schránky se nezdařilo",
    clipboardFailedMsg: "Snímek obrazovky byl uložen, ale nepodařilo se ho zkopírovat do schránky.",
    recordingSavedTitle: "Nahrávka uložena",
    recordingSavedMsg: "Video bylo staženo.",
    errorTitle: "Něco se pokazilo",
    errorRestrictedMsg: "Toto není možné na interních stránkách prohlížeče nebo stránkách obchodu s rozšířeními. Přepněte prosím na běžnou kartu webu.",
    selectAreaTitle: "Vyberte oblast",
    selectAreaMsg: "Tažením na stránce vyberte oblast a poté potvrďte.",
  },
  "da": {
    screenshotSavedTitle: "Skærmbillede gemt",
    screenshotSavedMsg: "Dit skærmbillede blev downloadet.",
    screenshotSavedClipboardMsg: "Downloadet og kopieret til udklipsholderen.",
    clipboardFailedTitle: "Kopiering til udklipsholder mislykkedes",
    clipboardFailedMsg: "Skærmbilledet blev gemt, men kunne ikke kopieres til udklipsholderen.",
    recordingSavedTitle: "Optagelse gemt",
    recordingSavedMsg: "Din video blev downloadet.",
    errorTitle: "Noget gik galt",
    errorRestrictedMsg: "Dette er ikke muligt på browserens egne interne sider eller sider i butikken for udvidelser/tilføjelser. Skift venligst til en almindelig webstedsfane.",
    selectAreaTitle: "Vælg et område",
    selectAreaMsg: "Træk på siden for at vælge området, og bekræft derefter.",
  },
  "de": {
    screenshotSavedTitle: "Screenshot gespeichert",
    screenshotSavedMsg: "Ihr Screenshot wurde heruntergeladen.",
    screenshotSavedClipboardMsg: "Heruntergeladen und in die Zwischenablage kopiert.",
    clipboardFailedTitle: "Kopieren in die Zwischenablage fehlgeschlagen",
    clipboardFailedMsg: "Der Screenshot wurde gespeichert, konnte aber nicht in die Zwischenablage kopiert werden.",
    recordingSavedTitle: "Aufnahme gespeichert",
    recordingSavedMsg: "Ihr Video wurde heruntergeladen.",
    errorTitle: "Etwas ist schiefgelaufen",
    errorRestrictedMsg: "Dies ist auf den internen Seiten des Browsers oder Seiten des Add-on-/Erweiterungs-Stores nicht möglich. Bitte wechseln Sie zu einem normalen Website-Tab.",
    selectAreaTitle: "Bereich auswählen",
    selectAreaMsg: "Ziehen Sie auf der Seite, um den Bereich auszuwählen, und bestätigen Sie dann.",
  },
  "el": {
    screenshotSavedTitle: "Το στιγμιότυπο αποθηκεύτηκε",
    screenshotSavedMsg: "Το στιγμιότυπό σας λήφθηκε.",
    screenshotSavedClipboardMsg: "Λήφθηκε και αντιγράφηκε στο πρόχειρο.",
    clipboardFailedTitle: "Η αντιγραφή στο πρόχειρο απέτυχε",
    clipboardFailedMsg: "Το στιγμιότυπο αποθηκεύτηκε, αλλά δεν ήταν δυνατή η αντιγραφή του στο πρόχειρο.",
    recordingSavedTitle: "Η εγγραφή αποθηκεύτηκε",
    recordingSavedMsg: "Το βίντεό σας λήφθηκε.",
    errorTitle: "Κάτι πήγε στραβά",
    errorRestrictedMsg: "Αυτό δεν είναι δυνατό στις εσωτερικές σελίδες του προγράμματος περιήγησης ή στις σελίδες του καταστήματος επεκτάσεων/πρόσθετων. Μεταβείτε σε μια κανονική καρτέλα ιστότοπου.",
    selectAreaTitle: "Επιλέξτε μια περιοχή",
    selectAreaMsg: "Σύρετε στη σελίδα για να επιλέξετε την περιοχή και μετά επιβεβαιώστε.",
  },
  "en_GB": {
    screenshotSavedTitle: "Screenshot saved",
    screenshotSavedMsg: "Your screenshot was downloaded.",
    screenshotSavedClipboardMsg: "Downloaded and copied to clipboard.",
    clipboardFailedTitle: "Clipboard copy failed",
    clipboardFailedMsg: "The screenshot was saved, but couldn't be copied to the clipboard.",
    recordingSavedTitle: "Recording saved",
    recordingSavedMsg: "Your video was downloaded.",
    errorTitle: "Something went wrong",
    errorRestrictedMsg: "This isn't possible on the browser's own internal pages or extension/add-on store pages. Please switch to a regular website tab.",
    selectAreaTitle: "Select an area",
    selectAreaMsg: "Drag on the page to select the region, then confirm.",
  },
  "en_US": {
    screenshotSavedTitle: "Screenshot saved",
    screenshotSavedMsg: "Your screenshot was downloaded.",
    screenshotSavedClipboardMsg: "Downloaded and copied to clipboard.",
    clipboardFailedTitle: "Clipboard copy failed",
    clipboardFailedMsg: "The screenshot was saved, but couldn't be copied to the clipboard.",
    recordingSavedTitle: "Recording saved",
    recordingSavedMsg: "Your video was downloaded.",
    errorTitle: "Something went wrong",
    errorRestrictedMsg: "This isn't possible on the browser's own internal pages or extension/add-on store pages. Please switch to a regular website tab.",
    selectAreaTitle: "Select an area",
    selectAreaMsg: "Drag on the page to select the region, then confirm.",
  },
  "es": {
    screenshotSavedTitle: "Captura de pantalla guardada",
    screenshotSavedMsg: "Tu captura de pantalla se ha descargado.",
    screenshotSavedClipboardMsg: "Descargada y copiada al portapapeles.",
    clipboardFailedTitle: "Error al copiar al portapapeles",
    clipboardFailedMsg: "La captura se guardó, pero no se pudo copiar al portapapeles.",
    recordingSavedTitle: "Grabación guardada",
    recordingSavedMsg: "Tu vídeo se ha descargado.",
    errorTitle: "Algo salió mal",
    errorRestrictedMsg: "Esto no es posible en las páginas internas del navegador ni en las páginas de la tienda de extensiones/complementos. Cambia a una pestaña de sitio web normal.",
    selectAreaTitle: "Selecciona un área",
    selectAreaMsg: "Arrastra sobre la página para seleccionar la región y luego confirma.",
  },
  "es_419": {
    screenshotSavedTitle: "Captura de pantalla guardada",
    screenshotSavedMsg: "Tu captura de pantalla se ha descargado.",
    screenshotSavedClipboardMsg: "Descargada y copiada al portapapeles.",
    clipboardFailedTitle: "Error al copiar al portapapeles",
    clipboardFailedMsg: "La captura se guardó, pero no se pudo copiar al portapapeles.",
    recordingSavedTitle: "Grabación guardada",
    recordingSavedMsg: "Tu video se ha descargado.",
    errorTitle: "Algo salió mal",
    errorRestrictedMsg: "Esto no es posible en las páginas internas del navegador ni en las páginas de la tienda de extensiones/complementos. Cambia a una pestaña de sitio web normal.",
    selectAreaTitle: "Selecciona un área",
    selectAreaMsg: "Arrastra sobre la página para seleccionar la región y luego confirma.",
  },
  "et": {
    screenshotSavedTitle: "Ekraanipilt salvestatud",
    screenshotSavedMsg: "Sinu ekraanipilt laaditi alla.",
    screenshotSavedClipboardMsg: "Alla laaditud ja kopeeritud lõikelauale.",
    clipboardFailedTitle: "Lõikelauale kopeerimine ebaõnnestus",
    clipboardFailedMsg: "Ekraanipilt salvestati, kuid seda ei õnnestunud lõikelauale kopeerida.",
    recordingSavedTitle: "Salvestus salvestatud",
    recordingSavedMsg: "Sinu video laaditi alla.",
    errorTitle: "Midagi läks valesti",
    errorRestrictedMsg: "See pole võimalik brauseri enda sisemistel lehtedel ega laienduste/lisandmoodulite poe lehtedel. Palun lülitu tavalisele veebisaidi vahekaardile.",
    selectAreaTitle: "Vali ala",
    selectAreaMsg: "Ala valimiseks lohista lehel, seejärel kinnita.",
  },
  "fa": {
    screenshotSavedTitle: "عکس صفحه ذخیره شد",
    screenshotSavedMsg: "عکس صفحه شما دانلود شد.",
    screenshotSavedClipboardMsg: "دانلود شد و در کلیپ‌بورد کپی شد.",
    clipboardFailedTitle: "کپی در کلیپ‌بورد ناموفق بود",
    clipboardFailedMsg: "عکس صفحه ذخیره شد، اما کپی آن در کلیپ‌بورد ممکن نشد.",
    recordingSavedTitle: "ضبط ذخیره شد",
    recordingSavedMsg: "ویدیوی شما دانلود شد.",
    errorTitle: "مشکلی پیش آمد",
    errorRestrictedMsg: "این کار در صفحات داخلی خود مرورگر یا صفحات فروشگاه افزونه‌ها امکان‌پذیر نیست. لطفاً به یک تب وب‌سایت معمولی بروید.",
    selectAreaTitle: "یک ناحیه انتخاب کنید",
    selectAreaMsg: "برای انتخاب ناحیه روی صفحه بکشید، سپس تأیید کنید.",
  },
  "fi": {
    screenshotSavedTitle: "Kuvakaappaus tallennettu",
    screenshotSavedMsg: "Kuvakaappauksesi ladattiin.",
    screenshotSavedClipboardMsg: "Ladattu ja kopioitu leikepöydälle.",
    clipboardFailedTitle: "Kopiointi leikepöydälle epäonnistui",
    clipboardFailedMsg: "Kuvakaappaus tallennettiin, mutta sitä ei voitu kopioida leikepöydälle.",
    recordingSavedTitle: "Tallenne tallennettu",
    recordingSavedMsg: "Videosi ladattiin.",
    errorTitle: "Jokin meni pieleen",
    errorRestrictedMsg: "Tämä ei ole mahdollista selaimen omilla sisäisillä sivuilla tai laajennus-/lisäosakaupan sivuilla. Vaihda tavalliselle verkkosivustovälilehdelle.",
    selectAreaTitle: "Valitse alue",
    selectAreaMsg: "Vedä sivulla valitaksesi alueen ja vahvista sitten.",
  },
  "fil": {
    screenshotSavedTitle: "Na-save ang screenshot",
    screenshotSavedMsg: "Na-download ang iyong screenshot.",
    screenshotSavedClipboardMsg: "Na-download at nakopya sa clipboard.",
    clipboardFailedTitle: "Nabigo ang pagkopya sa clipboard",
    clipboardFailedMsg: "Na-save ang screenshot, pero hindi ito nakopya sa clipboard.",
    recordingSavedTitle: "Na-save ang recording",
    recordingSavedMsg: "Na-download ang iyong video.",
    errorTitle: "May nangyaring mali",
    errorRestrictedMsg: "Hindi ito posible sa sarili ng browser na internal na mga page o sa mga page ng extension/add-on store. Mangyaring lumipat sa isang regular na website tab.",
    selectAreaTitle: "Pumili ng bahagi",
    selectAreaMsg: "I-drag sa pahina para piliin ang rehiyon, pagkatapos kumpirmahin.",
  },
  "fr": {
    screenshotSavedTitle: "Capture d'écran enregistrée",
    screenshotSavedMsg: "Votre capture d'écran a été téléchargée.",
    screenshotSavedClipboardMsg: "Téléchargée et copiée dans le presse-papiers.",
    clipboardFailedTitle: "Échec de la copie dans le presse-papiers",
    clipboardFailedMsg: "La capture d'écran a été enregistrée, mais n'a pas pu être copiée dans le presse-papiers.",
    recordingSavedTitle: "Enregistrement enregistré",
    recordingSavedMsg: "Votre vidéo a été téléchargée.",
    errorTitle: "Un problème est survenu",
    errorRestrictedMsg: "Ceci n'est pas possible sur les pages internes du navigateur ni sur les pages de la boutique d'extensions/modules complémentaires. Veuillez passer à un onglet de site web normal.",
    selectAreaTitle: "Sélectionnez une zone",
    selectAreaMsg: "Faites glisser sur la page pour sélectionner la région, puis confirmez.",
  },
  "gu": {
    screenshotSavedTitle: "સ્ક્રીનશોટ સેવ થયો",
    screenshotSavedMsg: "તમારો સ્ક્રીનશોટ ડાઉનલોડ થયો.",
    screenshotSavedClipboardMsg: "ડાઉનલોડ થયું અને ક્લિપબોર્ડમાં કૉપિ થયું.",
    clipboardFailedTitle: "ક્લિપબોર્ડમાં કૉપિ કરવામાં નિષ્ફળ",
    clipboardFailedMsg: "સ્ક્રીનશોટ સેવ થયો, પણ ક્લિપબોર્ડમાં કૉપિ કરી શકાયો નહીં.",
    recordingSavedTitle: "રેકોર્ડિંગ સેવ થયું",
    recordingSavedMsg: "તમારો વિડિયો ડાઉનલોડ થયો.",
    errorTitle: "કંઈક ખોટું થયું",
    errorRestrictedMsg: "આ બ્રાઉઝરના પોતાના આંતરિક પેજ પર અથવા એક્સટેન્શન/ઍડ-ઑન સ્ટોર પેજ પર શક્ય નથી. કૃપા કરીને સામાન્ય વેબસાઇટ ટૅબ પર સ્વિચ કરો.",
    selectAreaTitle: "એક વિસ્તાર પસંદ કરો",
    selectAreaMsg: "વિસ્તાર પસંદ કરવા માટે પેજ પર ડ્રૅગ કરો, પછી પુષ્ટિ કરો.",
  },
  "he": {
    screenshotSavedTitle: "צילום המסך נשמר",
    screenshotSavedMsg: "צילום המסך שלך הורד.",
    screenshotSavedClipboardMsg: "הורד והועתק ללוח העריכה.",
    clipboardFailedTitle: "ההעתקה ללוח העריכה נכשלה",
    clipboardFailedMsg: "צילום המסך נשמר, אך לא ניתן היה להעתיק אותו ללוח העריכה.",
    recordingSavedTitle: "ההקלטה נשמרה",
    recordingSavedMsg: "הווידאו שלך הורד.",
    errorTitle: "משהו השתבש",
    errorRestrictedMsg: "לא ניתן לבצע פעולה זו בעמודי המערכת הפנימיים של הדפדפן או בעמודי חנות התוספים. אנא עבור לכרטיסיית אתר רגילה.",
    selectAreaTitle: "בחר אזור",
    selectAreaMsg: "גרור על העמוד כדי לבחור את האזור, ולאחר מכן אשר.",
  },
  "hi": {
    screenshotSavedTitle: "स्क्रीनशॉट सेव हुआ",
    screenshotSavedMsg: "आपका स्क्रीनशॉट डाउनलोड हो गया।",
    screenshotSavedClipboardMsg: "डाउनलोड हो गया और क्लिपबोर्ड में कॉपी हो गया।",
    clipboardFailedTitle: "क्लिपबोर्ड कॉपी विफल रही",
    clipboardFailedMsg: "स्क्रीनशॉट सेव हो गया, लेकिन उसे क्लिपबोर्ड में कॉपी नहीं किया जा सका।",
    recordingSavedTitle: "रिकॉर्डिंग सेव हुई",
    recordingSavedMsg: "आपका वीडियो डाउनलोड हो गया।",
    errorTitle: "कुछ गड़बड़ हो गई",
    errorRestrictedMsg: "यह ब्राउज़र के अपने आंतरिक पेजों या एक्सटेंशन/ऐड-ऑन स्टोर पेजों पर संभव नहीं है। कृपया किसी सामान्य वेबसाइट टैब पर स्विच करें।",
    selectAreaTitle: "एक क्षेत्र चुनें",
    selectAreaMsg: "क्षेत्र चुनने के लिए पेज पर ड्रैग करें, फिर पुष्टि करें।",
  },
  "hr": {
    screenshotSavedTitle: "Snimka zaslona spremljena",
    screenshotSavedMsg: "Vaša snimka zaslona preuzeta je.",
    screenshotSavedClipboardMsg: "Preuzeto i kopirano u međuspremnik.",
    clipboardFailedTitle: "Kopiranje u međuspremnik nije uspjelo",
    clipboardFailedMsg: "Snimka zaslona spremljena je, ali nije se mogla kopirati u međuspremnik.",
    recordingSavedTitle: "Snimanje spremljeno",
    recordingSavedMsg: "Vaš videozapis preuzet je.",
    errorTitle: "Nešto je pošlo po zlu",
    errorRestrictedMsg: "Ovo nije moguće na internim stranicama preglednika ili na stranicama trgovine proširenja/dodataka. Prijeđite na karticu obične web-stranice.",
    selectAreaTitle: "Odaberite područje",
    selectAreaMsg: "Povucite po stranici da biste odabrali područje, a zatim potvrdite.",
  },
  "hu": {
    screenshotSavedTitle: "Képernyőkép elmentve",
    screenshotSavedMsg: "A képernyőképe letöltve.",
    screenshotSavedClipboardMsg: "Letöltve és a vágólapra másolva.",
    clipboardFailedTitle: "A vágólapra másolás sikertelen",
    clipboardFailedMsg: "A képernyőkép elmentve, de nem sikerült a vágólapra másolni.",
    recordingSavedTitle: "Felvétel elmentve",
    recordingSavedMsg: "A videója letöltve.",
    errorTitle: "Valami hiba történt",
    errorRestrictedMsg: "Ez nem lehetséges a böngésző saját belső oldalain vagy a bővítmény-/kiegészítőáruház oldalain. Váltson egy normál weboldal lapra.",
    selectAreaTitle: "Terület kijelölése",
    selectAreaMsg: "Húzza az egeret az oldalon a terület kijelöléséhez, majd erősítse meg.",
  },
  "id": {
    screenshotSavedTitle: "Tangkapan layar disimpan",
    screenshotSavedMsg: "Tangkapan layar Anda telah diunduh.",
    screenshotSavedClipboardMsg: "Diunduh dan disalin ke clipboard.",
    clipboardFailedTitle: "Gagal menyalin ke clipboard",
    clipboardFailedMsg: "Tangkapan layar telah disimpan, tetapi tidak dapat disalin ke clipboard.",
    recordingSavedTitle: "Rekaman disimpan",
    recordingSavedMsg: "Video Anda telah diunduh.",
    errorTitle: "Terjadi kesalahan",
    errorRestrictedMsg: "Ini tidak dapat dilakukan pada halaman internal browser sendiri atau halaman toko ekstensi/add-on. Silakan beralih ke tab situs web biasa.",
    selectAreaTitle: "Pilih area",
    selectAreaMsg: "Seret pada halaman untuk memilih area, lalu konfirmasi.",
  },
  "it": {
    screenshotSavedTitle: "Screenshot salvato",
    screenshotSavedMsg: "Lo screenshot è stato scaricato.",
    screenshotSavedClipboardMsg: "Scaricato e copiato negli appunti.",
    clipboardFailedTitle: "Copia negli appunti non riuscita",
    clipboardFailedMsg: "Lo screenshot è stato salvato, ma non è stato possibile copiarlo negli appunti.",
    recordingSavedTitle: "Registrazione salvata",
    recordingSavedMsg: "Il video è stato scaricato.",
    errorTitle: "Si è verificato un errore",
    errorRestrictedMsg: "Non è possibile sulle pagine interne del browser o sulle pagine dello store delle estensioni/componenti aggiuntivi. Passa a una normale scheda di un sito web.",
    selectAreaTitle: "Seleziona un'area",
    selectAreaMsg: "Trascina sulla pagina per selezionare la zona, poi conferma.",
  },
  "ja": {
    screenshotSavedTitle: "スクリーンショットを保存しました",
    screenshotSavedMsg: "スクリーンショットをダウンロードしました。",
    screenshotSavedClipboardMsg: "ダウンロードし、クリップボードにコピーしました。",
    clipboardFailedTitle: "クリップボードへのコピーに失敗しました",
    clipboardFailedMsg: "スクリーンショットは保存されましたが、クリップボードにはコピーできませんでした。",
    recordingSavedTitle: "録画を保存しました",
    recordingSavedMsg: "動画をダウンロードしました。",
    errorTitle: "問題が発生しました",
    errorRestrictedMsg: "ブラウザ自体の内部ページや拡張機能/アドオンストアのページでは実行できません。通常のウェブサイトのタブに切り替えてください。",
    selectAreaTitle: "エリアを選択",
    selectAreaMsg: "ページ上をドラッグしてエリアを選択し、確定してください。",
  },
  "kn": {
    screenshotSavedTitle: "ಸ್ಕ್ರೀನ್‌ಶಾಟ್ ಉಳಿಸಲಾಗಿದೆ",
    screenshotSavedMsg: "ನಿಮ್ಮ ಸ್ಕ್ರೀನ್‌ಶಾಟ್ ಡೌನ್‌ಲೋಡ್ ಆಗಿದೆ.",
    screenshotSavedClipboardMsg: "ಡೌನ್‌ಲೋಡ್ ಮಾಡಿ ಕ್ಲಿಪ್‌ಬೋರ್ಡ್‌ಗೆ ನಕಲಿಸಲಾಗಿದೆ.",
    clipboardFailedTitle: "ಕ್ಲಿಪ್‌ಬೋರ್ಡ್ ನಕಲು ವಿಫಲವಾಗಿದೆ",
    clipboardFailedMsg: "ಸ್ಕ್ರೀನ್‌ಶಾಟ್ ಉಳಿಸಲಾಗಿದೆ, ಆದರೆ ಕ್ಲಿಪ್‌ಬೋರ್ಡ್‌ಗೆ ನಕಲಿಸಲು ಸಾಧ್ಯವಾಗಲಿಲ್ಲ.",
    recordingSavedTitle: "ರೆಕಾರ್ಡಿಂಗ್ ಉಳಿಸಲಾಗಿದೆ",
    recordingSavedMsg: "ನಿಮ್ಮ ವೀಡಿಯೊ ಡೌನ್‌ಲೋಡ್ ಆಗಿದೆ.",
    errorTitle: "ಏನೋ ತಪ್ಪಾಗಿದೆ",
    errorRestrictedMsg: "ಬ್ರೌಸರ್‌ನ ಸ್ವಂತ ಆಂತರಿಕ ಪುಟಗಳಲ್ಲಿ ಅಥವಾ ವಿಸ್ತರಣೆ/ಆಡ್-ಆನ್ ಸ್ಟೋರ್ ಪುಟಗಳಲ್ಲಿ ಇದು ಸಾಧ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ಸಾಮಾನ್ಯ ವೆಬ್‌ಸೈಟ್ ಟ್ಯಾಬ್‌ಗೆ ಬದಲಾಯಿಸಿ.",
    selectAreaTitle: "ಒಂದು ಪ್ರದೇಶ ಆಯ್ಕೆಮಾಡಿ",
    selectAreaMsg: "ಪ್ರದೇಶವನ್ನು ಆಯ್ಕೆಮಾಡಲು ಪುಟದಲ್ಲಿ ಡ್ರ್ಯಾಗ್ ಮಾಡಿ, ನಂತರ ದೃಢೀಕರಿಸಿ.",
  },
  "ko": {
    screenshotSavedTitle: "스크린샷 저장됨",
    screenshotSavedMsg: "스크린샷이 다운로드되었습니다.",
    screenshotSavedClipboardMsg: "다운로드 후 클립보드에 복사했습니다.",
    clipboardFailedTitle: "클립보드 복사 실패",
    clipboardFailedMsg: "스크린샷은 저장되었지만 클립보드에는 복사하지 못했습니다.",
    recordingSavedTitle: "녹화 저장됨",
    recordingSavedMsg: "동영상이 다운로드되었습니다.",
    errorTitle: "문제가 발생했습니다",
    errorRestrictedMsg: "브라우저 자체의 내부 페이지나 확장 프로그램/부가 기능 스토어 페이지에서는 사용할 수 없습니다. 일반 웹사이트 탭으로 전환해 주세요.",
    selectAreaTitle: "영역 선택",
    selectAreaMsg: "페이지에서 드래그하여 영역을 선택한 다음 확인하세요.",
  },
  "lt": {
    screenshotSavedTitle: "Ekrano nuotrauka išsaugota",
    screenshotSavedMsg: "Jūsų ekrano nuotrauka atsisiųsta.",
    screenshotSavedClipboardMsg: "Atsisiųsta ir nukopijuota į iškarpinę.",
    clipboardFailedTitle: "Nepavyko kopijuoti į iškarpinę",
    clipboardFailedMsg: "Ekrano nuotrauka išsaugota, tačiau nepavyko jos nukopijuoti į iškarpinę.",
    recordingSavedTitle: "Įrašas išsaugotas",
    recordingSavedMsg: "Jūsų vaizdo įrašas atsisiųstas.",
    errorTitle: "Kažkas nutiko ne taip",
    errorRestrictedMsg: "Tai neįmanoma pačios naršyklės vidiniuose puslapiuose ar plėtinių / priedų parduotuvės puslapiuose. Persijunkite į įprastą svetainės skirtuką.",
    selectAreaTitle: "Pasirinkite sritį",
    selectAreaMsg: "Nuvilkite pele puslapyje, kad pažymėtumėte sritį, tada patvirtinkite.",
  },
  "lv": {
    screenshotSavedTitle: "Ekrānuzņēmums saglabāts",
    screenshotSavedMsg: "Jūsu ekrānuzņēmums tika lejupielādēts.",
    screenshotSavedClipboardMsg: "Lejupielādēts un nokopēts starpliktuvē.",
    clipboardFailedTitle: "Neizdevās kopēt starpliktuvē",
    clipboardFailedMsg: "Ekrānuzņēmums tika saglabāts, taču to neizdevās nokopēt starpliktuvē.",
    recordingSavedTitle: "Ieraksts saglabāts",
    recordingSavedMsg: "Jūsu video tika lejupielādēts.",
    errorTitle: "Kaut kas nogāja greizi",
    errorRestrictedMsg: "Tas nav iespējams pārlūka paša iekšējās lapās vai paplašinājumu/papildinājumu veikala lapās. Lūdzu, pārslēdzieties uz parastu vietnes cilni.",
    selectAreaTitle: "Atlasiet apgabalu",
    selectAreaMsg: "Velciet pa lapu, lai atlasītu apgabalu, tad apstipriniet.",
  },
  "ml": {
    screenshotSavedTitle: "സ്ക്രീൻഷോട്ട് സേവ് ചെയ്തു",
    screenshotSavedMsg: "നിങ്ങളുടെ സ്ക്രീൻഷോട്ട് ഡൗൺലോഡ് ചെയ്തു.",
    screenshotSavedClipboardMsg: "ഡൗൺലോഡ് ചെയ്ത് ക്ലിപ്ബോർഡിലേക്ക് പകർത്തി.",
    clipboardFailedTitle: "ക്ലിപ്ബോർഡിലേക്ക് പകർത്താൻ കഴിഞ്ഞില്ല",
    clipboardFailedMsg: "സ്ക്രീൻഷോട്ട് സേവ് ചെയ്തു, പക്ഷേ ക്ലിപ്ബോർഡിലേക്ക് പകർത്താൻ കഴിഞ്ഞില്ല.",
    recordingSavedTitle: "റെക്കോർഡിംഗ് സേവ് ചെയ്തു",
    recordingSavedMsg: "നിങ്ങളുടെ വീഡിയോ ഡൗൺലോഡ് ചെയ്തു.",
    errorTitle: "എന്തോ പിഴവ് സംഭവിച്ചു",
    errorRestrictedMsg: "ബ്രൗസറിന്റെ സ്വന്തം ഇന്റേണൽ പേജുകളിലോ എക്സ്റ്റൻഷൻ/ആഡ്-ഓൺ സ്റ്റോർ പേജുകളിലോ ഇത് സാധ്യമല്ല. ദയവായി സാധാരണ വെബ്സൈറ്റ് ടാബിലേക്ക് മാറുക.",
    selectAreaTitle: "ഒരു ഭാഗം തിരഞ്ഞെടുക്കുക",
    selectAreaMsg: "ഭാഗം തിരഞ്ഞെടുക്കാൻ പേജിൽ ഡ്രാഗ് ചെയ്ത് സ്ഥിരീകരിക്കുക.",
  },
  "mr": {
    screenshotSavedTitle: "स्क्रीनशॉट सेव्ह झाला",
    screenshotSavedMsg: "तुमचा स्क्रीनशॉट डाउनलोड झाला.",
    screenshotSavedClipboardMsg: "डाउनलोड झाले आणि क्लिपबोर्डवर कॉपी झाले.",
    clipboardFailedTitle: "क्लिपबोर्डवर कॉपी करणे अयशस्वी झाले",
    clipboardFailedMsg: "स्क्रीनशॉट सेव्ह झाला, पण तो क्लिपबोर्डवर कॉपी करता आला नाही.",
    recordingSavedTitle: "रेकॉर्डिंग सेव्ह झाले",
    recordingSavedMsg: "तुमचा व्हिडिओ डाउनलोड झाला.",
    errorTitle: "काहीतरी चुकले",
    errorRestrictedMsg: "ब्राउझरच्या स्वतःच्या अंतर्गत पेजेसवर किंवा एक्स्टेंशन/अ‍ॅड-ऑन स्टोअर पेजेसवर हे शक्य नाही. कृपया सामान्य वेबसाइट टॅबवर जा.",
    selectAreaTitle: "एक भाग निवडा",
    selectAreaMsg: "भाग निवडण्यासाठी पेजवर ड्रॅग करा, नंतर पुष्टी करा.",
  },
  "ms": {
    screenshotSavedTitle: "Tangkapan skrin disimpan",
    screenshotSavedMsg: "Tangkapan skrin anda telah dimuat turun.",
    screenshotSavedClipboardMsg: "Dimuat turun dan disalin ke papan keratan.",
    clipboardFailedTitle: "Gagal menyalin ke papan keratan",
    clipboardFailedMsg: "Tangkapan skrin telah disimpan, tetapi tidak dapat disalin ke papan keratan.",
    recordingSavedTitle: "Rakaman disimpan",
    recordingSavedMsg: "Video anda telah dimuat turun.",
    errorTitle: "Sesuatu telah berlaku",
    errorRestrictedMsg: "Ini tidak boleh dilakukan pada halaman dalaman pelayar sendiri atau halaman kedai sambungan/tambahan. Sila beralih ke tab laman web biasa.",
    selectAreaTitle: "Pilih kawasan",
    selectAreaMsg: "Seret pada halaman untuk memilih kawasan, kemudian sahkan.",
  },
  "nl": {
    screenshotSavedTitle: "Schermafbeelding opgeslagen",
    screenshotSavedMsg: "Je schermafbeelding is gedownload.",
    screenshotSavedClipboardMsg: "Gedownload en naar klembord gekopieerd.",
    clipboardFailedTitle: "Kopiëren naar klembord mislukt",
    clipboardFailedMsg: "De schermafbeelding is opgeslagen, maar kon niet naar het klembord worden gekopieerd.",
    recordingSavedTitle: "Opname opgeslagen",
    recordingSavedMsg: "Je video is gedownload.",
    errorTitle: "Er is iets misgegaan",
    errorRestrictedMsg: "Dit is niet mogelijk op de eigen systeempagina's van de browser of op pagina's van de extensie-/add-on store. Ga naar een gewone website-tab.",
    selectAreaTitle: "Selecteer een gebied",
    selectAreaMsg: "Sleep op de pagina om het gebied te selecteren en bevestig daarna.",
  },
  "no": {
    screenshotSavedTitle: "Skjermbilde lagret",
    screenshotSavedMsg: "Skjermbildet ditt ble lastet ned.",
    screenshotSavedClipboardMsg: "Lastet ned og kopiert til utklippstavlen.",
    clipboardFailedTitle: "Kunne ikke kopiere til utklippstavlen",
    clipboardFailedMsg: "Skjermbildet ble lagret, men kunne ikke kopieres til utklippstavlen.",
    recordingSavedTitle: "Opptak lagret",
    recordingSavedMsg: "Videoen din ble lastet ned.",
    errorTitle: "Noe gikk galt",
    errorRestrictedMsg: "Dette er ikke mulig på nettleserens egne systemsider eller på sider i utvidelses-/tilleggsbutikken. Bytt til en vanlig nettside-fane.",
    selectAreaTitle: "Velg et område",
    selectAreaMsg: "Dra på siden for å velge området, og bekreft deretter.",
  },
  "pl": {
    screenshotSavedTitle: "Zrzut ekranu zapisany",
    screenshotSavedMsg: "Zrzut ekranu został pobrany.",
    screenshotSavedClipboardMsg: "Pobrano i skopiowano do schowka.",
    clipboardFailedTitle: "Nie udało się skopiować do schowka",
    clipboardFailedMsg: "Zrzut ekranu został zapisany, ale nie udało się skopiować go do schowka.",
    recordingSavedTitle: "Nagranie zapisane",
    recordingSavedMsg: "Wideo zostało pobrane.",
    errorTitle: "Coś poszło nie tak",
    errorRestrictedMsg: "Nie jest to możliwe na wewnętrznych stronach systemowych przeglądarki ani na stronach sklepu z rozszerzeniami/dodatkami. Przełącz się na kartę zwykłej strony internetowej.",
    selectAreaTitle: "Zaznacz obszar",
    selectAreaMsg: "Przeciągnij kursor po stronie, aby zaznaczyć obszar, a następnie zatwierdź.",
  },
  "pt_BR": {
    screenshotSavedTitle: "Captura de tela salva",
    screenshotSavedMsg: "Sua captura de tela foi baixada.",
    screenshotSavedClipboardMsg: "Baixada e copiada para a área de transferência.",
    clipboardFailedTitle: "Falha ao copiar para a área de transferência",
    clipboardFailedMsg: "A captura de tela foi salva, mas não pôde ser copiada para a área de transferência.",
    recordingSavedTitle: "Gravação salva",
    recordingSavedMsg: "Seu vídeo foi baixado.",
    errorTitle: "Algo deu errado",
    errorRestrictedMsg: "Isso não é possível nas páginas internas do navegador ou nas páginas da loja de extensões. Mude para uma aba de site comum.",
    selectAreaTitle: "Selecione uma área",
    selectAreaMsg: "Arraste na página para selecionar a região e depois confirme.",
  },
  "pt_PT": {
    screenshotSavedTitle: "Captura de ecrã guardada",
    screenshotSavedMsg: "A sua captura de ecrã foi transferida.",
    screenshotSavedClipboardMsg: "Transferida e copiada para a área de transferência.",
    clipboardFailedTitle: "Falha ao copiar para a área de transferência",
    clipboardFailedMsg: "A captura de ecrã foi guardada, mas não foi possível copiá-la para a área de transferência.",
    recordingSavedTitle: "Gravação guardada",
    recordingSavedMsg: "O seu vídeo foi transferido.",
    errorTitle: "Ocorreu um problema",
    errorRestrictedMsg: "Isto não é possível nas páginas internas do browser ou nas páginas da loja de extensões. Mude para um separador de um site normal.",
    selectAreaTitle: "Selecione uma área",
    selectAreaMsg: "Arraste na página para selecionar a região e depois confirme.",
  },
  "ro": {
    screenshotSavedTitle: "Captură de ecran salvată",
    screenshotSavedMsg: "Captura ta de ecran a fost descărcată.",
    screenshotSavedClipboardMsg: "Descărcată și copiată în clipboard.",
    clipboardFailedTitle: "Copierea în clipboard a eșuat",
    clipboardFailedMsg: "Captura de ecran a fost salvată, dar nu a putut fi copiată în clipboard.",
    recordingSavedTitle: "Înregistrare salvată",
    recordingSavedMsg: "Videoclipul tău a fost descărcat.",
    errorTitle: "Ceva nu a mers bine",
    errorRestrictedMsg: "Acest lucru nu este posibil pe paginile interne ale browserului sau pe paginile magazinului de extensii. Comută la o filă cu un site obișnuit.",
    selectAreaTitle: "Selectează o zonă",
    selectAreaMsg: "Trage pe pagină pentru a selecta regiunea, apoi confirmă.",
  },
  "sk": {
    screenshotSavedTitle: "Snímka obrazovky uložená",
    screenshotSavedMsg: "Vaša snímka obrazovky bola stiahnutá.",
    screenshotSavedClipboardMsg: "Stiahnuté a skopírované do schránky.",
    clipboardFailedTitle: "Kopírovanie do schránky zlyhalo",
    clipboardFailedMsg: "Snímka obrazovky bola uložená, ale nepodarilo sa ju skopírovať do schránky.",
    recordingSavedTitle: "Nahrávka uložená",
    recordingSavedMsg: "Vaše video bolo stiahnuté.",
    errorTitle: "Niečo sa pokazilo",
    errorRestrictedMsg: "Toto nie je možné na interných stránkach prehliadača ani na stránkach obchodu s rozšíreniami. Prepnite prosím na kartu s bežnou webovou stránkou.",
    selectAreaTitle: "Vyberte oblasť",
    selectAreaMsg: "Potiahnutím na stránke vyberte oblasť a potom potvrďte.",
  },
  "sl": {
    screenshotSavedTitle: "Posnetek zaslona shranjen",
    screenshotSavedMsg: "Vaš posnetek zaslona je bil prenesen.",
    screenshotSavedClipboardMsg: "Preneseno in kopirano v odložišče.",
    clipboardFailedTitle: "Kopiranje v odložišče ni uspelo",
    clipboardFailedMsg: "Posnetek zaslona je bil shranjen, vendar ga ni bilo mogoče kopirati v odložišče.",
    recordingSavedTitle: "Posnetek shranjen",
    recordingSavedMsg: "Vaš videoposnetek je bil prenesen.",
    errorTitle: "Nekaj je šlo narobe",
    errorRestrictedMsg: "To ni mogoče na internih straneh brskalnika ali straneh trgovine z razširitvami. Preklopite na zavihek z običajnim spletnim mestom.",
    selectAreaTitle: "Izberite območje",
    selectAreaMsg: "Povlecite po strani, da izberete območje, nato potrdite.",
  },
  "sr": {
    screenshotSavedTitle: "Снимак екрана сачуван",
    screenshotSavedMsg: "Ваш снимак екрана је преузет.",
    screenshotSavedClipboardMsg: "Преузето и копирано у клипборд.",
    clipboardFailedTitle: "Копирање у клипборд није успело",
    clipboardFailedMsg: "Снимак екрана је сачуван, али није могао да се копира у клипборд.",
    recordingSavedTitle: "Снимак сачуван",
    recordingSavedMsg: "Ваш видео запис је преузет.",
    errorTitle: "Нешто није у реду",
    errorRestrictedMsg: "Ово није могуће на интерним страницама прегледача или страницама продавнице екстензија. Пређите на картицу са обичним веб-сајтом.",
    selectAreaTitle: "Изаберите област",
    selectAreaMsg: "Превуците на страници да изаберете регион, а затим потврдите.",
  },
  "sv": {
    screenshotSavedTitle: "Skärmbild sparad",
    screenshotSavedMsg: "Din skärmbild laddades ner.",
    screenshotSavedClipboardMsg: "Nedladdad och kopierad till urklipp.",
    clipboardFailedTitle: "Kopiering till urklipp misslyckades",
    clipboardFailedMsg: "Skärmbilden sparades, men kunde inte kopieras till urklipp.",
    recordingSavedTitle: "Inspelning sparad",
    recordingSavedMsg: "Din video laddades ner.",
    errorTitle: "Något gick fel",
    errorRestrictedMsg: "Detta är inte möjligt på webbläsarens egna interna sidor eller sidor för tillägg/butiker. Byt till en vanlig webbplatsflik.",
    selectAreaTitle: "Markera ett område",
    selectAreaMsg: "Dra på sidan för att markera området och bekräfta sedan.",
  },
  "sw": {
    screenshotSavedTitle: "Picha ya skrini imehifadhiwa",
    screenshotSavedMsg: "Picha yako ya skrini imepakuliwa.",
    screenshotSavedClipboardMsg: "Imepakuliwa na kunakiliwa kwenye ubao wa kunakili.",
    clipboardFailedTitle: "Kunakili kwenye ubao wa kunakili kumeshindwa",
    clipboardFailedMsg: "Picha ya skrini imehifadhiwa, lakini haikuweza kunakiliwa kwenye ubao wa kunakili.",
    recordingSavedTitle: "Urekodi umehifadhiwa",
    recordingSavedMsg: "Video yako imepakuliwa.",
    errorTitle: "Hitilafu imetokea",
    errorRestrictedMsg: "Hii haiwezekani kwenye kurasa za ndani za kivinjari au kurasa za duka la programu-jalizi/nyongeza. Tafadhali badilisha kwenda kichupo cha kawaida cha tovuti.",
    selectAreaTitle: "Chagua eneo",
    selectAreaMsg: "Buruta kwenye ukurasa ili kuchagua eneo, kisha uthibitishe.",
  },
  "ta": {
    screenshotSavedTitle: "ஸ்கிரீன்ஷாட் சேமிக்கப்பட்டது",
    screenshotSavedMsg: "உங்கள் ஸ்கிரீன்ஷாட் பதிவிறக்கப்பட்டது.",
    screenshotSavedClipboardMsg: "பதிவிறக்கப்பட்டு கிளிப்போர்டுக்கு நகலெடுக்கப்பட்டது.",
    clipboardFailedTitle: "கிளிப்போர்டு நகலெடுப்பு தோல்வியடைந்தது",
    clipboardFailedMsg: "ஸ்கிரீன்ஷாட் சேமிக்கப்பட்டது, ஆனால் கிளிப்போர்டுக்கு நகலெடுக்க முடியவில்லை.",
    recordingSavedTitle: "பதிவு சேமிக்கப்பட்டது",
    recordingSavedMsg: "உங்கள் வீடியோ பதிவிறக்கப்பட்டது.",
    errorTitle: "ஏதோ தவறாகிவிட்டது",
    errorRestrictedMsg: "உலாவியின் சொந்த உள்ளக பக்கங்களிலோ அல்லது நீட்டிப்பு/ஆட்-ஆன் ஸ்டோர் பக்கங்களிலோ இது சாத்தியமில்லை. வழக்கமான இணையதளத் தாவலுக்கு மாறவும்.",
    selectAreaTitle: "ஒரு பகுதியைத் தேர்ந்தெடு",
    selectAreaMsg: "பகுதியைத் தேர்ந்தெடுக்க பக்கத்தில் இழுத்து, பின் உறுதிப்படுத்தவும்.",
  },
  "te": {
    screenshotSavedTitle: "స్క్రీన్‌షాట్ సేవ్ చేయబడింది",
    screenshotSavedMsg: "మీ స్క్రీన్‌షాట్ డౌన్‌లోడ్ చేయబడింది.",
    screenshotSavedClipboardMsg: "డౌన్‌లోడ్ చేయబడింది మరియు క్లిప్‌బోర్డ్‌కు కాపీ చేయబడింది.",
    clipboardFailedTitle: "క్లిప్‌బోర్డ్ కాపీ విఫలమైంది",
    clipboardFailedMsg: "స్క్రీన్‌షాట్ సేవ్ చేయబడింది, కానీ క్లిప్‌బోర్డ్‌కు కాపీ చేయబడలేదు.",
    recordingSavedTitle: "రికార్డింగ్ సేవ్ చేయబడింది",
    recordingSavedMsg: "మీ వీడియో డౌన్‌లోడ్ చేయబడింది.",
    errorTitle: "ఏదో తప్పు జరిగింది",
    errorRestrictedMsg: "బ్రౌజర్ యొక్క స్వంత అంతర్గత పేజీలలో లేదా ఎక్స్‌టెన్షన్/యాడ్-ఆన్ స్టోర్ పేజీలలో ఇది సాధ్యం కాదు. దయచేసి సాధారణ వెబ్‌సైట్ ట్యాబ్‌కు మారండి.",
    selectAreaTitle: "ఒక ప్రాంతాన్ని ఎంచుకోండి",
    selectAreaMsg: "ప్రాంతాన్ని ఎంచుకోవడానికి పేజీపై డ్రాగ్ చేసి, తర్వాత నిర్ధారించండి.",
  },
  "th": {
    screenshotSavedTitle: "บันทึกภาพหน้าจอแล้ว",
    screenshotSavedMsg: "ดาวน์โหลดภาพหน้าจอของคุณแล้ว",
    screenshotSavedClipboardMsg: "ดาวน์โหลดและคัดลอกไปยังคลิปบอร์ดแล้ว",
    clipboardFailedTitle: "คัดลอกไปยังคลิปบอร์ดไม่สำเร็จ",
    clipboardFailedMsg: "บันทึกภาพหน้าจอแล้ว แต่ไม่สามารถคัดลอกไปยังคลิปบอร์ดได้",
    recordingSavedTitle: "บันทึกวิดีโอแล้ว",
    recordingSavedMsg: "ดาวน์โหลดวิดีโอของคุณแล้ว",
    errorTitle: "เกิดข้อผิดพลาดบางอย่าง",
    errorRestrictedMsg: "ไม่สามารถใช้งานได้บนหน้าระบบภายในของเบราว์เซอร์ หรือหน้าร้านค้าส่วนขยาย/ส่วนเสริม กรุณาสลับไปที่แท็บเว็บไซต์ปกติ",
    selectAreaTitle: "เลือกพื้นที่",
    selectAreaMsg: "ลากบนหน้าเว็บเพื่อเลือกพื้นที่ แล้วยืนยัน",
  },
  "tr": {
    screenshotSavedTitle: "Ekran görüntüsü kaydedildi",
    screenshotSavedMsg: "Ekran görüntünüz indirildi.",
    screenshotSavedClipboardMsg: "İndirildi ve panoya kopyalandı.",
    clipboardFailedTitle: "Panoya kopyalama başarısız oldu",
    clipboardFailedMsg: "Ekran görüntüsü kaydedildi, ancak panoya kopyalanamadı.",
    recordingSavedTitle: "Kayıt kaydedildi",
    recordingSavedMsg: "Videonuz indirildi.",
    errorTitle: "Bir şeyler ters gitti",
    errorRestrictedMsg: "Bu, tarayıcının kendi dahili sayfalarında veya uzantı/eklenti mağazası sayfalarında mümkün değil. Lütfen normal bir web sitesi sekmesine geçin.",
    selectAreaTitle: "Bir alan seçin",
    selectAreaMsg: "Bölgeyi seçmek için sayfada sürükleyin, ardından onaylayın.",
  },
  "uk": {
    screenshotSavedTitle: "Знімок екрана збережено",
    screenshotSavedMsg: "Ваш знімок екрана завантажено.",
    screenshotSavedClipboardMsg: "Завантажено і скопійовано в буфер обміну.",
    clipboardFailedTitle: "Не вдалося скопіювати в буфер обміну",
    clipboardFailedMsg: "Знімок екрана збережено, але не вдалося скопіювати його в буфер обміну.",
    recordingSavedTitle: "Запис збережено",
    recordingSavedMsg: "Ваше відео завантажено.",
    errorTitle: "Щось пішло не так",
    errorRestrictedMsg: "Це неможливо на внутрішніх сторінках браузера чи в магазині розширень/додатків. Перейдіть на звичайну вкладку сайту.",
    selectAreaTitle: "Виділіть область",
    selectAreaMsg: "Перетягніть на сторінці, щоб виділити область, потім підтвердьте.",
  },
  "vi": {
    screenshotSavedTitle: "Đã lưu ảnh chụp màn hình",
    screenshotSavedMsg: "Ảnh chụp màn hình của bạn đã được tải xuống.",
    screenshotSavedClipboardMsg: "Đã tải xuống và sao chép vào clipboard.",
    clipboardFailedTitle: "Sao chép vào clipboard thất bại",
    clipboardFailedMsg: "Ảnh chụp màn hình đã được lưu, nhưng không thể sao chép vào clipboard.",
    recordingSavedTitle: "Đã lưu bản ghi",
    recordingSavedMsg: "Video của bạn đã được tải xuống.",
    errorTitle: "Đã xảy ra sự cố",
    errorRestrictedMsg: "Không thể thực hiện trên các trang nội bộ của trình duyệt hoặc trang cửa hàng tiện ích mở rộng. Vui lòng chuyển sang một tab trang web thông thường.",
    selectAreaTitle: "Chọn một vùng",
    selectAreaMsg: "Kéo trên trang để chọn vùng, sau đó xác nhận.",
  },
  "zh_CN": {
    screenshotSavedTitle: "截图已保存",
    screenshotSavedMsg: "您的截图已下载。",
    screenshotSavedClipboardMsg: "已下载并复制到剪贴板。",
    clipboardFailedTitle: "复制到剪贴板失败",
    clipboardFailedMsg: "截图已保存，但无法复制到剪贴板。",
    recordingSavedTitle: "录制已保存",
    recordingSavedMsg: "您的视频已下载。",
    errorTitle: "出了点问题",
    errorRestrictedMsg: "无法在浏览器自带的内部页面或扩展商店页面执行此操作。请切换到普通网页标签页。",
    selectAreaTitle: "选择区域",
    selectAreaMsg: "在页面上拖动以选择区域，然后确认。",
  },
  "zh_TW": {
    screenshotSavedTitle: "截圖已儲存",
    screenshotSavedMsg: "您的截圖已下載完成。",
    screenshotSavedClipboardMsg: "已下載並複製到剪貼簿。",
    clipboardFailedTitle: "複製到剪貼簿失敗",
    clipboardFailedMsg: "截圖已儲存，但無法複製到剪貼簿。",
    recordingSavedTitle: "錄影已儲存",
    recordingSavedMsg: "您的影片已下載完成。",
    errorTitle: "發生錯誤",
    errorRestrictedMsg: "無法在瀏覽器本身的內部頁面或擴充功能商店頁面執行此操作，請切換到一般網站分頁。",
    selectAreaTitle: "選取區域",
    selectAreaMsg: "在頁面上拖曳以選取區域，然後確認。",
  },
};

async function notify(titleKey: NotifKey, messageKey: NotifKey): Promise<void> {
  const lang = await getUILang();
  const s = NOTIF_STRINGS[lang];
  try {
    // chrome.notifications.create() returns a Promise in MV3 when called
    // without a callback. The previous version didn't await or catch it —
    // a rejection (missing "notifications" permission at runtime, an
    // unreadable icon file, notifications disabled for the browser at the
    // OS level, etc.) became a silent, disconnected unhandled promise
    // rejection instead of something we could log or that callers could
    // see. Nothing in this codebase depends on notify() throwing (every
    // call site treats it as fire-and-forget), so we still swallow the
    // error here — but now it's at least logged, instead of vanishing
    // without a trace the way it could look identical to "nothing
    // happened at all" when debugging a silent failure elsewhere.
    await chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: s[titleKey],
      message: s[messageKey],
    });
  } catch (e) {
    console.error("ScreenRec: chrome.notifications.create failed", e);
  }
}

async function updateBadge(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: state.isSaving ? "#f2a900" : "#e04343" });
  await chrome.action.setBadgeText({ text: state.isSaving ? "..." : state.isRecording ? "REC" : "" });
}

async function guardActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isRestrictedUrl(tab.url)) {
    await notify("errorTitle", "errorRestrictedMsg");
    return null;
  }
  return tab;
}

// ---------- Offscreen document (recording + clipboard) ----------

async function ensureOffscreenDocument(): Promise<boolean> {
  if (!HAS_OFFSCREEN) return false;
  let alreadyExists = false;
  try {
    if (chrome.offscreen.hasDocument) {
      alreadyExists = await chrome.offscreen.hasDocument();
    } else if (chrome.runtime.getContexts) {
      const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
      alreadyExists = !!(existing && existing.length > 0);
    }
  } catch {
    alreadyExists = false;
  }
  if (alreadyExists) return true;

  const reasonSets: chrome.offscreen.Reason[][] = [
    ["USER_MEDIA", "DISPLAY_MEDIA"],
    ["USER_MEDIA"],
  ];
  let lastErr: unknown = null;
  for (const reasons of reasonSets) {
    try {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons,
        justification: "Recording screen/tab video with audio, which needs to keep running after the popup closes.",
      });
      return true;
    } catch (e) {
      lastErr = e;
      if (/already exists/i.test(String(e))) return true;
    }
  }
  console.error("ScreenRec: could not create offscreen document", lastErr);
  throw lastErr || new Error("offscreen document creation failed");
}

async function closeOffscreenDocumentIfIdle(): Promise<void> {
  if (!HAS_OFFSCREEN) return;
  if (state.isRecording) return; // still needed
  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
}

// Freshly-created offscreen documents can have a brief window where
// chrome.offscreen.createDocument() has resolved but the document's own
// script hasn't attached its onMessage listener yet, so the very first
// sendMessage can race and fail with "receiving end does not exist" even
// though the document exists. Retry a couple of times before giving up.
async function sendToOffscreen(message: Record<string, unknown>, attempts = 4): Promise<unknown> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", ...message });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 120 + i * 120));
    }
  }
  throw lastErr;
}

// ---------- Clipboard ----------
//
// Root cause (confirmed via Chromium's own bug tracker, crbug.com/40252021 —
// still open): navigator.clipboard.write() only succeeds in a document that
// currently holds real OS focus. A chrome.offscreen document is invisible by
// design and can NEVER gain focus, so the previous implementation — creating
// an offscreen document with reason "CLIPBOARD" and calling
// navigator.clipboard.write() from inside it — was guaranteed to fail with
// "Document is not focused" every single time, on every screenshot, on
// Chrome. That's a dead end; there is no timing fix or retry that works
// around it.
//
// Firefox never went through that path at all (HAS_OFFSCREEN is false
// there), which is why clipboard copy silently did nothing on Firefox
// before this fix — not a regression, just never implemented.
//
// Fixed approach, per browser:
//  - Firefox: browser.clipboard.setImageData() is a privileged WebExtension
//    API (requires the "clipboardWrite" permission) that writes directly
//    from the background page, with no document-focus requirement at all.
//  - Chrome: there's no equivalent privileged API, so instead we inject a
//    small script into the tab the screenshot came from and do the write
//    there — that tab's document normally *does* hold focus (the user was
//    just looking at it, whether the shot was triggered by a keyboard
//    shortcut or a popup button that closes itself on click).

async function getActiveTabIdForClipboard(): Promise<number | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || tab.id == null || isRestrictedUrl(tab.url)) return null;
    return tab.id;
  } catch {
    return null;
  }
}

// Chromium's Async Clipboard API only accepts a small allow-list of image
// MIME types for writes (in practice, just image/png) — so regardless of
// what format the user picked for saved files (jpeg/webp), always convert
// to PNG before writing to the clipboard, or the write throws
// "Type <mime> not supported on write".
async function ensurePngDataUrlForClipboard(dataUrl: string): Promise<string> {
  if (dataUrl.startsWith("data:image/png")) return dataUrl;
  return await reencodeDataUrl(dataUrl, "image/png", 1);
}

async function copyDataUrlToClipboard(dataUrl: string, tabId?: number | null): Promise<boolean> {
  try {
    const pngDataUrl = await ensurePngDataUrlForClipboard(dataUrl);

    if (HAS_CLIPBOARD_API) {
      const resp = await fetch(pngDataUrl);
      const buf = await resp.arrayBuffer();
      await chrome.clipboard.setImageData(buf, "png");
      return true;
    }

    const targetTabId = tabId ?? (await getActiveTabIdForClipboard());
    if (targetTabId == null) throw new Error("no focusable tab available for clipboard write");

    const [injection] = await chrome.scripting.executeScript<[string], { ok: boolean; detail?: string }>({
      target: { tabId: targetTabId },
      func: async (url: string) => {
        try {
          const resp = await fetch(url);
          const blob = await resp.blob();
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return { ok: true };
        } catch (e) {
          return { ok: false, detail: e instanceof Error ? e.message : String(e) };
        }
      },
      args: [pngDataUrl],
    });
    const result = injection && injection.result;
    if (!result || !result.ok) throw new Error((result && result.detail) || "clipboard write failed in page context");
    return true;
  } catch (e) {
    console.error("ScreenRec: clipboard copy failed", e);
    await notify("clipboardFailedTitle", "clipboardFailedMsg");
    return false;
  }
}

// ---------- Screenshot: visible area ----------

async function captureVisibleTabPng(windowId: number): Promise<string> {
  return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

// chrome.tabs.captureVisibleTab is rate-limited (roughly 2 calls/sec per
// profile). The full-page screenshot loop calls this many times in a row,
// so retry with backoff instead of failing outright on
// MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND.
async function captureVisibleTabPngSafe(windowId: number, maxAttempts = 6): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await captureVisibleTabPng(windowId);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const isQuota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(message);
      if (isQuota && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 700 + attempt * 250));
        continue;
      }
      throw e;
    }
  }
  throw new Error("captureVisibleTabPngSafe: exhausted attempts");
}

async function finishScreenshot(dataUrl: string, filename: string, mode: string, tabId?: number | null): Promise<number> {
  const downloadId = await downloadAndLog(dataUrl, filename, "screenshot", { mode });
  const { autoClipboard } = await getSettings();
  // Always keep the last screenshot around (regardless of autoClipboard),
  // so the manual "copy to clipboard" button in the popup/side panel always
  // has something to act on — previously this was only stored when
  // autoClipboard was off, which meant the manual button had nothing to
  // copy under the (default) autoClipboard-on setting, e.g. if auto-copy
  // silently couldn't run (a restricted page with no injectable tab).
  //
  // This is the one place in the whole file that puts a potentially large
  // blob — a full data URL, which for a tall "Capture full page" screenshot
  // can run into multiple MB — into chrome.storage.session, whose byte
  // quota is much smaller than a few such screenshots, so writing it here
  // can throw an uncaught "QuotaExceededError: storage.session API call
  // exceeded its quota limitations." Left unhandled, that throw would
  // propagate straight out of finishScreenshot() uncaught by its own
  // callers' try/catch (they wrap the whole call and report "errorTitle" on
  // ANY failure) — meaning the download at the line above had already
  // fully succeeded, but the person would see an error notification
  // instead of "screenshot saved" purely because of this non-essential
  // convenience write failing. Isolated in
  // its own try/catch so a quota failure only costs the "copy last
  // screenshot" button's data (which already degrades gracefully — see
  // COPY_LAST_SCREENSHOT's "no_screenshot" case below) rather than the
  // entire save.
  try {
    await chrome.storage.session.set({ lastScreenshotDataUrl: dataUrl });
  } catch (e) {
    console.error("ScreenRec: could not cache lastScreenshotDataUrl (screenshot itself already saved fine)", e);
  }
  if (autoClipboard) {
    // Fire-and-forget: failure surfaces via its own notification instead of
    // blocking/delaying the "screenshot saved" notification below.
    copyDataUrlToClipboard(dataUrl, tabId ?? null);
  }
  await notify("screenshotSavedTitle", "screenshotSavedMsg");
  return downloadId;
}

// chrome.tabs.captureVisibleTab only ever returns PNG or JPEG — re-encode
// through a canvas when the user wants WebP instead.
async function reencodeDataUrl(dataUrl: string, mime: string, quality: number): Promise<string> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, 0, 0);
  const outBlob = await canvas.convertToBlob({ type: mime, quality });
  return await blobToDataURL(outBlob);
}

async function doCaptureVisible(tab: chrome.tabs.Tab): Promise<void> {
  try {
    const dataUrl = await captureVisibleTabPngSafe(tab.windowId);
    const { screenshotDrawToolEnabled } = await getSettings();
    // Keeps the drawing tools available for full-viewport screenshots too,
    // not just area-mode ones: reuses the exact same composited-screenshot
    // flow area-mode screenshots already use (backgroundImg + strokes,
    // see annotate-overlay.ts), just with `rect` covering the WHOLE
    // viewport instead of a selected sub-rect and no cropping needed —
    // the just-captured full-tab image is the background as-is.
    if (screenshotDrawToolEnabled && tab.id != null) {
      try {
        const [{ result: info }] = await chrome.scripting.executeScript<[], { viewportWidth: number; viewportHeight: number; dpr: number }>({
          target: { tabId: tab.id },
          func: () => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
        });
        const rect: Rect = { x: 0, y: 0, width: info.viewportWidth, height: info.viewportHeight };
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shim.js", "annotate-overlay.js"] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (r: Rect, d: number, img: string) =>
            (window as any).__screenrecStartAnnotation__(r, d, { mode: "screenshot", imageDataUrl: img, floatingToolbar: true, logMode: "visible" }),
          args: [rect, info.dpr || 1, dataUrl],
        });
        return; // SCREENSHOT_ANNOTATION_SAVE/_CANCEL (handleScreenshotAnnotationSave) finishes this off
      } catch (e) {
        console.error("ScreenRec: failed to inject visible-screenshot annotation overlay, falling back to instant save", e);
        // fall through to the instant-save path below
      }
    }
    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    const finalDataUrl = screenshotFormat === "webp" ? await reencodeDataUrl(dataUrl, mime, 0.92) : dataUrl;
    await finishScreenshot(finalDataUrl, timestampName(ext), "visible", tab.id ?? null);
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// ---------- Screenshot / video: selected area ----------

// Guards against starting more than one area selection at once. Every call
// used to inject select-overlay.js and invoke its entry point
// unconditionally, with nothing to stop a second click — the same popup
// reopened and clicked again, a fast double-click in the side panel (which
// doesn't auto-close), or the same hotkey firing twice — from doing it
// again while the first selection overlay was still open/undismissed.
// select-overlay.ts's own __screenrecSelectionLoaded__ guard only stops its
// *setup code* from re-running on re-injection; it does NOT stop the
// exposed __screenrecStartSelection__ entry point from being invoked
// again, so each repeat call built an entirely new, independent overlay
// stacked on top of the others — several at once, each with its own
// Cancel/"Use this area" buttons.
//
// Guarded here rather than in each caller: this is the single choke point
// every trigger funnels through (doCaptureArea, the START_RECORDING_AREA_
// SELECT message handler, and toggleRecordingViaHotkey's "area" branch),
// so one guard covers all of them, and the check-then-set below is
// synchronous (no `await` between reading state.isSelectingArea and
// setState() applying the new value) — two messages arriving back-to-back
// still can't both pass it, since setState() mutates the module-level
// `state` object immediately, before yielding to the event loop.
// Returns false (and does nothing) when a selection is already in
// progress, so callers can skip showing a second "Select an area"
// notification for a click that had no effect.
async function startAreaSelection(tabId: number, purpose: string, audio?: boolean): Promise<boolean> {
  if (state.isSelectingArea) return false;
  await setState({ isSelectingArea: true, selectingAreaTabId: tabId });
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      // shim.js first: aliases chrome -> browser in this injected page
      // context too, so select-overlay.js's chrome.* calls work in Firefox.
      files: ["shim.js", "select-overlay.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (p: string, a: boolean) => (window as any).__screenrecStartSelection__(p, a),
      args: [purpose, !!audio],
    });
  } catch (e) {
    // Injection failed (restricted page, tab closed mid-call, etc.) — don't
    // leave the trigger buttons stuck hidden for a selection that never
    // actually started.
    await clearAreaSelectionState();
    throw e;
  }
  return true;
}

async function doCaptureArea(tab: chrome.tabs.Tab): Promise<void> {
  try {
    // No OS notification fires here (this used to also fire one — "Select
    // an area — drag on the page..." — every time a selection started).
    // The on-page overlay's own on-screen hint already says this, and OS
    // notifications are otherwise reserved for save-completed or error
    // cases, so a second, separate notification for it was just noise.
    // startAreaSelection() itself is
    // unchanged — still returns false (and this stays silent) if a
    // selection was already in progress.
    await startAreaSelection(tab.id as number, "screenshot", false);
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function cropDataUrl(
  dataUrl: string,
  rect: Rect,
  dpr: number,
  viewportWidth: number | undefined,
  viewportHeight: number | undefined,
  mime?: string
): Promise<string> {
  const resp = await fetch(dataUrl);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);

  // Prefer a scale factor derived from the actual captured pixel size vs
  // the CSS viewport size measured at selection time — more reliable than
  // assuming the capture is exactly `cssPixels * devicePixelRatio` (browser
  // capture pipelines don't always guarantee that exact relationship).
  const scaleX = viewportWidth ? bitmap.width / viewportWidth : dpr;
  const scaleY = viewportHeight ? bitmap.height / viewportHeight : dpr;

  const sx = Math.max(0, Math.round(rect.x * scaleX));
  const sy = Math.max(0, Math.round(rect.y * scaleY));
  const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(rect.width * scaleX)));
  const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(rect.height * scaleY)));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  const outBlob = await canvas.convertToBlob({
    type: mime || "image/png",
    quality: mime === "image/webp" ? 0.92 : undefined,
  });
  return await blobToDataURL(outBlob);
}

async function handleAreaSelected(message: any, sender: chrome.runtime.MessageSender): Promise<void> {
  // The overlay's own finish() already ran its cleanup() (removed all its
  // DOM) before sending this message, so the selection is over either way
  // — screenshot or video — and the trigger buttons can come back.
  await clearAreaSelectionState();
  const { rect, purpose, dpr, viewportWidth, viewportHeight } = message;
  const tab = sender.tab as chrome.tabs.Tab;
  if (purpose === "screenshot") {
    try {
      const fullDataUrl = await captureVisibleTabPngSafe(tab.windowId);
      const croppedDataUrl = await cropDataUrl(fullDataUrl, rect, dpr, viewportWidth, viewportHeight, "image/png");
      // Hand the frozen crop to the same drawing overlay used for video,
      // in "screenshot" mode: the user can draw/annotate on top of the
      // still image before it's actually saved.
      await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: ["shim.js", "annotate-overlay.js"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id as number },
        func: (r: Rect, d: number, img: string) =>
          (window as any).__screenrecStartAnnotation__(r, d, { mode: "screenshot", imageDataUrl: img }),
        args: [rect, dpr || 1, croppedDataUrl],
      });
    } catch (e) {
      console.error(e);
      await notify("errorTitle", "errorTitle");
    }
  } else if (purpose === "video") {
    await beginTabRecording(tab, { audio: message.audio !== false, rect, dpr, viewportWidth, viewportHeight });
  }
}

async function handleScreenshotAnnotationSave(dataUrl: string, tabId?: number | null, logMode?: string): Promise<void> {
  try {
    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    const finalDataUrl = screenshotFormat === "webp" ? await reencodeDataUrl(dataUrl, mime, 0.92) : dataUrl;
    // This same annotation flow is also used for the plain visible-tab
    // screenshot (doCaptureVisible()), not just an area selection —
    // logMode (relayed from annotate-overlay.ts's own
    // opts.logMode) keeps the activity log entry accurate either way.
    await finishScreenshot(finalDataUrl, timestampName(ext), logMode === "visible" ? "visible" : "area", tabId ?? null);
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// ---------- Full page (scrolling) screenshot ----------

interface PageInfo {
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  dpr: number;
  originalScrollY: number;
}

async function doCaptureFullPage(tab: chrome.tabs.Tab): Promise<void> {
  try {
    const [{ result: pageInfo }] = await chrome.scripting.executeScript<[], PageInfo>({
      target: { tabId: tab.id as number },
      func: () => ({
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        originalScrollY: window.scrollY,
      }),
    });

    const { scrollHeight, viewportHeight, viewportWidth, dpr, originalScrollY } = pageInfo;
    const steps = Math.max(1, Math.ceil(scrollHeight / viewportHeight));
    const shots: Array<{ y: number; dataUrl: string }> = [];

    for (let i = 0; i < steps; i++) {
      const y = Math.min(i * viewportHeight, Math.max(0, scrollHeight - viewportHeight));
      await chrome.scripting.executeScript({
        target: { tabId: tab.id as number },
        func: (yy: number) => window.scrollTo(0, yy),
        args: [y],
      });
      // Stay comfortably under the ~2 calls/sec captureVisibleTab quota.
      await new Promise((r) => setTimeout(r, 650));
      const dataUrl = await captureVisibleTabPngSafe(tab.windowId);
      shots.push({ y, dataUrl });
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id as number },
      func: (yy: number) => window.scrollTo(0, yy),
      args: [originalScrollY],
    });

    const canvas = new OffscreenCanvas(Math.round(viewportWidth * dpr), Math.round(scrollHeight * dpr));
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;

    for (const shot of shots) {
      const resp = await fetch(shot.dataUrl);
      const blob = await resp.blob();
      const bitmap = await createImageBitmap(blob);
      ctx.drawImage(bitmap, 0, Math.round(shot.y * dpr));
    }

    const { screenshotFormat } = await getSettings();
    const { mime, ext } = screenshotMimeAndExt(screenshotFormat);
    const outBlob = await canvas.convertToBlob({ type: mime, quality: screenshotFormat === "webp" ? 0.92 : undefined });
    const outDataUrl = await blobToDataURL(outBlob);
    await finishScreenshot(outDataUrl, timestampName(ext), "fullpage", tab.id ?? null);
  } catch (e) {
    console.error(e);
    await notify("errorTitle", "errorTitle");
  }
}

// Entry point for the "Full page screenshot" trigger, letting the person
// scroll and draw across the whole page rather than just one viewport.
// With the draw tool on,
// this shows the same draw/GIF annotation overlay used everywhere else
// FIRST — sized to the whole page, not one viewport, so the person can
// scroll the real page and draw anywhere on it — and only actually
// captures once they click Save (handleFullPageAnnotationSave below).
// doCaptureFullPage()'s own scroll-and-photograph loop needs no changes at
// all for this: it already just photographs whatever's really on the page
// at each scroll step, which naturally includes both the real content AND
// anything drawn on top of it, with the toolbar itself hidden by
// annotate-overlay.ts's own Save handler before this ever starts (see its
// comment there). With the draw tool off, this is exactly the old
// behavior — immediate capture, nothing injected.
async function startFullPageCapture(tab: chrome.tabs.Tab): Promise<void> {
  const { screenshotDrawToolEnabled } = await getSettings();
  if (!screenshotDrawToolEnabled || tab.id == null) {
    await doCaptureFullPage(tab);
    return;
  }
  try {
    const [{ result: pageInfo }] = await chrome.scripting.executeScript<[], PageInfo>({
      target: { tabId: tab.id },
      func: () => ({
        scrollHeight: document.documentElement.scrollHeight,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        originalScrollY: window.scrollY,
      }),
    });
    const rect: Rect = { x: 0, y: 0, width: pageInfo.viewportWidth, height: pageInfo.scrollHeight };
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shim.js", "annotate-overlay.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d, { mode: "fullpage", floatingToolbar: true }),
      args: [rect, pageInfo.dpr || 1],
    });
  } catch (e) {
    console.error("ScreenRec: failed to inject full-page annotation overlay, falling back to instant capture", e);
    await doCaptureFullPage(tab);
  }
}

// The draw-then-Save flow's Save handler (FULLPAGE_ANNOTATION_SAVE) lands
// here: run the exact same scroll-and-photograph capture as always, then
// tear down the overlay — it stayed up (unlike screenshot/video mode's own
// teardown-on-click) specifically so doCaptureFullPage()'s screenshots
// would actually see the strokes still on the page while it worked.
async function handleFullPageAnnotationSave(tab?: chrome.tabs.Tab): Promise<void> {
  if (!tab || tab.id == null) return;
  try {
    await doCaptureFullPage(tab);
  } finally {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "STOP_ANNOTATION" });
    } catch {
      // tab may already be closed — fine, nothing left to tear down
    }
  }
}

// ---------- Video recording: saving a finished blob ----------

// Used by the recorder.ts (Firefox getDisplayMedia popup, full/tab modes)
// and offscreen.ts (Chrome tabCapture) paths: both run in a *different*
// page context than background.ts and hand off a finished recording via
// IndexedDB + a small blobId (chrome.runtime.sendMessage has a hard 64MiB
// cap, which a base64 video payload can easily exceed).
//
// Saving itself happens in a dedicated hidden helper page
// (save-helper.html), not here and not in the offscreen document: this
// extension's service worker doesn't support URL.createObjectURL(), and
// offscreen documents don't expose chrome.downloads — an ordinary
// extension page is the only context confirmed to have both. Converting
// the video to a base64 data URL instead (the previous approach) was
// suspected as a source of corrupted large recordings, so we avoid that
// path entirely.
//
// (The frame-stitch recording path below does NOT go through
// this function — see saveRecordingBlobDirectly. That whole recording
// already runs inside background.ts, which on Firefox is an ordinary page
// with both APIs directly available, so there's no separate context to
// hand off to in the first place — one less place for the handoff itself
// to silently fail, which an earlier investigation suggests
// happened here at least once.)
async function saveRecordingBlobViaHelper(blobId: string, filename: string, mode: string): Promise<void> {
  try {
    const helperUrl = chrome.runtime.getURL(
      `save-helper.html?blobId=${encodeURIComponent(blobId)}` +
        `&filename=${encodeURIComponent(filename)}` +
        `&mode=${encodeURIComponent(mode || "unknown")}`
    );
    if (HAS_OFFSCREEN) {
      // Chrome path — unchanged from before.
      try {
        await chrome.windows.create({ url: helperUrl, type: "popup", focused: false, state: "minimized" });
      } catch (e1) {
        // Some Chrome versions/platforms reject certain window option
        // combinations — fall back to a plain unfocused popup rather
        // than failing the save outright.
        console.error("ScreenRec: minimized save-helper window failed, retrying plain popup", e1);
        await chrome.windows.create({ url: helperUrl, type: "popup", focused: false, width: 200, height: 100 });
      }
    } else {
      // Firefox (recorder.ts's full/tab-mode path only — area mode no
      // longer reaches this function at all): go straight to a plain small
      // unfocused popup, skipping the "minimized" combination
      // suspected of silently never loading on this browser.
      await chrome.windows.create({ url: helperUrl, type: "popup", focused: false, width: 200, height: 100 });
    }
    const watchdog = setTimeout(() => {
      (async () => {
        if (!pendingSaveWatchdogs.has(blobId)) return; // SAVE_RECORDING_RESULT already arrived
        pendingSaveWatchdogs.delete(blobId);
        console.error(
          "ScreenRec: save-helper never reported back for blobId",
          blobId,
          "— the helper window likely never loaded/ran, or the download call itself hung. Treating this as a failed save."
        );
        await deleteBlobRecord(blobId).catch(() => {});
        await notify("errorTitle", "errorTitle");
        await resetRecordingState();
        await updateBadge();
        await closeOffscreenDocumentIfIdle();
      })().catch((e) => console.error("ScreenRec: save watchdog handler itself failed", e));
    }, SAVE_WATCHDOG_MS);
    pendingSaveWatchdogs.set(blobId, watchdog);
  } catch (e) {
    console.error("ScreenRec: failed to open save helper", e);
    await deleteBlobRecord(blobId);
    await notify("errorTitle", "errorTitle");
    await resetRecordingState();
    await updateBadge();
    await closeOffscreenDocumentIfIdle();
  }
}

// Used only by the frame-stitch recording path (Firefox area mode): that
// whole recording already runs inside background.ts, which on
// Firefox is an ordinary page (not a service worker) with full, direct
// access to both URL.createObjectURL and chrome.downloads — exactly the
// combination save-helper.html exists to provide for contexts that lack
// one or the other. So there's no separate window to open, no cross-context
// message hop, and no watchdog needed: a single try/catch either succeeds
// or fails within one function call.
async function saveRecordingBlobDirectly(blobId: string, filename: string, mode: string): Promise<void> {
  let objectUrl: string | null = null;
  try {
    const record = await getBlobRecord(blobId);
    if (!record || !record.blob) throw new Error("blob record not found (id: " + blobId + ")");
    if (record.blob.size === 0) throw new Error("recorded blob is empty (0 bytes)");
    objectUrl = URL.createObjectURL(record.blob);
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
    await appendLogEntry({ downloadId, type: "video", filename, timestamp: Date.now(), mode });
    await notify("recordingSavedTitle", "recordingSavedMsg");
  } catch (e) {
    console.error("ScreenRec: failed to save frame-stitched recording", e);
    await notify("errorTitle", "errorTitle");
  } finally {
    await deleteBlobRecord(blobId);
    if (objectUrl) {
      const revokeUrl = objectUrl;
      // Give the download manager a moment to actually start reading the
      // blob before revoking it — mirrors save-helper.ts's own delay.
      setTimeout(() => URL.revokeObjectURL(revokeUrl), 4000);
    }
    await resetRecordingState();
    await updateBadge();
  }
}

// ---------- Video recording: frame-stitched (DEAD CODE — kept for reference, see below) ----------
//
// Firefox has neither chrome.tabCapture nor a getDisplayMedia()-based area
// recording path. The getDisplayMedia() popup approach used for full-tab/
// full-screen mode ran into a series of problems specific to area mode — a
// user-activation bug, a missing drawing overlay, and a save-helper window
// that (very likely) never actually loaded — each only revealing the next
// problem underneath, before this was abandoned for area mode specifically
// in favor of the frame-stitching approach below: a canvas injected into
// the recorded tab via a content script, captured with
// canvas.captureStream()+MediaRecorder, with no OS picker needed.
//
// This path is no longer used. An exhaustive investigation (full writeup
// in ARCHITECTURE.md) proved — down to inspecting the actual encoded VP8
// bytes with ffprobe/ffmpeg, independent of any player — that this
// canvas.captureStream()+MediaRecorder combination reliably produces
// solid-black video in this Firefox environment, regardless of what's drawn
// to the canvas, the canvas's alpha/opacity/visibility, or how frames are
// requested from the capture track. The most likely explanation, based on
// closely analogous documented Firefox bugs (Mozilla bugzilla 1653983,
// 1557980), is a genuine Firefox implementation bug in that specific API
// combination, not anything fixable by further adjusting how this
// extension draws to or configures the canvas. beginTabRecording now
// routes area mode back through openRecorderWindowFallback (the same
// getDisplayMedia() popup full-tab/full-screen mode already uses) instead
// of calling beginFrameStitchRecording below — see beginTabRecording's own
// comment. Everything from here down (beginFrameStitchRecording,
// captureFrameAndForward, the FRAME_STITCH_* message handlers, etc.) is
// consequently unreachable, but left in place rather than deleted: it's a
// large, carefully-diagnosed piece of code, and ripping it out isn't
// necessary for area recording to work again. It's a candidate for actual
// removal in a future cleanup if it's clear it'll never be revisited.
//
// Instead of a live getDisplayMedia() stream, this periodically calls
// chrome.tabs.captureVisibleTab() — the exact same primitive the
// screenshot features already use, reliably, in both browsers throughout
// this whole debugging history — crops each frame to the selected rect,
// and draws it onto a canvas whose captureStream() feeds an ordinary
// MediaRecorder. No getDisplayMedia, no OS share picker, no extra popup
// window: the entire recording lives inside background.ts, which on
// Firefox is a real page (not a service worker) with full canvas/
// MediaRecorder support.
//
// Trade-offs, confirmed acceptable for area mode specifically: no audio
// (a still-image capture API has no audio track to offer), and a low
// frame rate — captureVisibleTab is throttled by the browser itself to
// roughly 2 calls/second, so motion looks like a slideshow rather than
// smooth video.

const FRAME_STITCH_INTERVAL_MS = 500; // ~2/sec — captureVisibleTab's known-safe quota
const FRAME_STITCH_CAPTURE_FPS = 4; // canvas.captureStream's sampling rate; it just repeats the latest drawn frame between our draws, which is fine

// Safety net for the stop→save handoff below, same idea as
// SAVE_WATCHDOG_MS above for the save-helper window: if stopping never actually
// finishes, the person would otherwise be stuck on "Saving…"/"Stopping…"
// forever with no error and no way out except reloading the extension.
// Cleared as soon as the recording actually finishes (success or failure).
const FRAME_STITCH_STOP_WATCHDOG_MS = 15000;
let frameStitchStopWatchdog: ReturnType<typeof setTimeout> | null = null;

// Root cause: canvas.captureStream() + MediaRecorder simply never produced
// any output when the canvas lived in the extension's own background page
// (confirmed empirically: 0 bytes, the ENTIRE recording, not just at the
// stop/cutover moment — meaning MediaRecorder.ondataavailable never fired
// even once). A background page is never composited as a visible surface,
// and both captureStream() and MediaRecorder need one to produce anything
// at all; that also explains an earlier mystery hang (recorder.onstop
// never firing either — it's the same underlying "this MediaRecorder never
// does anything" problem, just observed from the other end).
//
// Fix: the canvas + MediaRecorder now live in the RECORDED TAB itself (a
// real, rendering document), via src/frame-stitch-recorder.ts, injected
// the same way annotate-overlay.ts already is. This module keeps doing the
// two things content scripts can't: the privileged
// chrome.tabs.captureVisibleTab() screenshot every ~500ms, and cropping it
// down to the recording rect (a plain synchronous 2D canvas op — that part
// never needed a real rendering surface, only captureStream()/
// MediaRecorder did) — then forwards each cropped frame to the tab via
// chrome.tabs.sendMessage. The finished video blob comes back the same
// way messaging always has to cross this boundary: base64 chunks over
// chrome.runtime.sendMessage (frame-stitch-recorder.ts's own comment
// explains why IndexedDB isn't an option from a content script), then
// reassembled here and handed to the unchanged blob-db.ts/
// saveRecordingBlobDirectly pipeline.
interface FrameStitchSession {
  tabId: number;
  windowId: number;
  rect: Rect;
  dpr: number;
  viewportWidth?: number;
  viewportHeight?: number;
  outW: number;
  outH: number;
  mimeType: string;
  intervalHandle: ReturnType<typeof setInterval> | null;
  capturing: boolean; // guards against overlapping captureVisibleTab calls if one runs long
  consecutiveSendFailures: number; // counts failed chrome.tabs.sendMessage calls in a row — see captureFrameAndForward
  blobChunks: Map<number, string>;
  blobChunksExpected: number | null;
  diagSamplesLogged: number; // See the pixel-brightness diagnostic in captureFrameAndForward
}

// Only one of these can be active at a time (recording is exclusive
// already, enforced by state.isRecording elsewhere) — a plain module
// variable is fine, no need to persist it: if the background page were to
// restart mid-recording, the live interval/session are gone regardless of
// what we do here, same as offscreen.ts's recording state on Chrome
// already isn't persisted across a service worker restart either.
let activeFrameStitch: FrameStitchSession | null = null;
// Set the moment stopFrameStitchRecording() nulls activeFrameStitch (for
// its own idempotency) through until the
// in-tab recorder's result/blob chunks have been fully handled — the
// FRAME_STITCH_TAB_* message handlers below look at this, not
// activeFrameStitch, to find which session a given message belongs to.
let frameStitchPendingSave: FrameStitchSession | null = null;
// Reused across capture ticks rather than recreated every ~500ms — a plain
// synchronous 2D crop, unrelated to (and unaffected by) the
// captureStream()/MediaRecorder problem described above.
let frameStitchCropCanvas: HTMLCanvasElement | null = null;
// A small scratch canvas used only to downscale a source image
// into an 8x8 thumbnail for the pixel-brightness diagnostic below — never
// shown, never sent anywhere, just sampled with getImageData().
let frameStitchDiagCanvas: HTMLCanvasElement | null = null;

// A series of earlier fixes each addressed a real, well-diagnosed bug in
// the decode/draw/capture pipeline — CSP-blocked <img>, CSP-blocked
// fetch(), automatic captureStream() sampling — and the saved video came
// back solid black every single time, unchanged. The most recent of those
// fixes even proved (framesDrawn>0, frameDecodeErrors=0, megabytes of real
// encoded data) that drawing and encoding are genuinely happening. Rather
// than guess a fifth specific mechanism, this samples actual pixel
// brightness at two points in the pipeline — the RAW screenshot straight
// from chrome.tabs.captureVisibleTab(), and the CROPPED frame actually
// sent to the tab — for the first few ticks of each recording, and logs
// both plus the exact crop math (rect/scale/sx/sy/sw/sh/outW/outH). This
// settles, with real data instead of another theory, which of three very
// different explanations is true: (a) the raw screenshot itself is
// blank/black (captureVisibleTab returning nothing useful — e.g. DRM
// content, a permissions issue), (b) the raw screenshot is fine but the
// crop rectangle is wrong (e.g. clamped to a 1px sliver then stretched
// across the whole frame — indistinguishable from "solid color" to the
// eye), or (c) both are fine and the bug is still somewhere downstream in
// frame-stitch-recorder.ts despite the previous fixes.
function sampleBrightness(source: CanvasImageSource, sw: number, sh: number): { max: number; avg: number } {
  const canvas = frameStitchDiagCanvas || (frameStitchDiagCanvas = document.createElement("canvas"));
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.drawImage(source, 0, 0, sw, sh, 0, 0, 8, 8);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  let max = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(data[i], data[i + 1], data[i + 2]);
    if (v > max) max = v;
    sum += v;
  }
  return { max, avg: Math.round(sum / (data.length / 4)) };
}

// Turn a canvas into raw PNG bytes (an ArrayBuffer), not a data:
// URL string. See the comment on the sendMessage call below for why.
function canvasToArrayBuffer(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("canvas.toBlob returned null"));
        return;
      }
      blob
        .arrayBuffer()
        .then(resolve)
        .catch(reject);
    }, "image/png");
  });
}

async function captureFrameAndForward(session: FrameStitchSession): Promise<void> {
  if (session.capturing) return; // previous capture still in flight — skip this tick rather than pile up
  session.capturing = true;
  try {
    const dataUrl = await captureVisibleTabPngSafe(session.windowId);
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);
    let croppedFrameBuffer: ArrayBuffer;
    try {
      // Same scale-factor logic as cropDataUrl() above, kept in sync
      // deliberately rather than sharing code, since that one returns an
      // encoded data URL for screenshot use and this one runs every ~500ms
      // for video use — different enough call shapes that sharing would
      // mean threading extra parameters through just to get back to the
      // same four numbers.
      const scaleX = session.viewportWidth ? bitmap.width / session.viewportWidth : session.dpr;
      const scaleY = session.viewportHeight ? bitmap.height / session.viewportHeight : session.dpr;
      const sx = Math.max(0, Math.round(session.rect.x * scaleX));
      const sy = Math.max(0, Math.round(session.rect.y * scaleY));
      const sw = Math.max(1, Math.min(bitmap.width - sx, Math.round(session.rect.width * scaleX)));
      const sh = Math.max(1, Math.min(bitmap.height - sy, Math.round(session.rect.height * scaleY)));
      const cropCanvas = frameStitchCropCanvas || (frameStitchCropCanvas = document.createElement("canvas"));
      cropCanvas.width = session.outW;
      cropCanvas.height = session.outH;
      const cropCtx = cropCanvas.getContext("2d") as CanvasRenderingContext2D;
      cropCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, session.outW, session.outH);
      // See the big comment above sampleBrightness() for why this
      // exists. First 3 ticks only — cheap (8x8 downscale + a tiny
      // getImageData), but no reason to do it every single tick.
      if (session.diagSamplesLogged < 3) {
        session.diagSamplesLogged++;
        try {
          const rawSample = sampleBrightness(bitmap, bitmap.width, bitmap.height);
          const croppedSample = sampleBrightness(cropCanvas, cropCanvas.width, cropCanvas.height);
          console.log(
            `ScreenRec: frame-stitch pixel diagnostic #${session.diagSamplesLogged}: ` +
              `raw(max=${rawSample.max},avg=${rawSample.avg}) cropped(max=${croppedSample.max},avg=${croppedSample.avg}) ` +
              `bitmapWH=${bitmap.width}x${bitmap.height} rect=(${session.rect.x},${session.rect.y},${session.rect.width},${session.rect.height}) ` +
              `viewportWH=${session.viewportWidth}x${session.viewportHeight} dpr=${session.dpr} scaleXY=(${scaleX.toFixed(3)},${scaleY.toFixed(3)}) ` +
              `sxywh=(${sx},${sy},${sw},${sh}) outWH=${session.outW}x${session.outH}`
          );
        } catch (diagErr) {
          console.error("ScreenRec: frame-stitch pixel diagnostic failed", diagErr);
        }
      }
      croppedFrameBuffer = await canvasToArrayBuffer(cropCanvas);
    } finally {
      bitmap.close();
    }

    if (activeFrameStitch !== session) return; // stopped while the above was in flight

    try {
      // Sends raw PNG bytes (an ArrayBuffer), not a data: URL string. An
      // earlier approach drew the frame via <img>, which got blocked by the
      // recorded page's img-src CSP directive; switching to fetch(dataUrl)
      // + createImageBitmap() in the content script fixed that, but that
      // fetch() call still runs IN the recorded page's context, so a page
      // whose CSP restricts connect-src/default-src (rather than, or in
      // addition to, img-src) can block it too, silently reproducing the
      // exact same "solid black video" symptom. Sending raw bytes instead
      // sidesteps both CSP failure modes at once. Firefox's extension
      // messaging uses the structured clone algorithm (unlike Chrome, which
      // only supports JSON) — see shim.ts — so an ArrayBuffer survives the
      // trip intact. The content script then builds a Blob from the raw
      // bytes it already has in hand and decodes it with
      // createImageBitmap(blob) directly: no URL, no fetch, nothing for any
      // page CSP directive to intercept at all.
      await chrome.tabs.sendMessage(session.tabId, { type: "FRAME_STITCH_FRAME", frameBuffer: croppedFrameBuffer });
      session.consecutiveSendFailures = 0;
    } catch (e) {
      session.consecutiveSendFailures++;
      // A single missed send isn't fatal (the in-tab recorder just repeats
      // its last drawn frame, same as any other skipped tick), but several
      // in a row means the content script is genuinely gone — most likely
      // the tab navigated or closed mid-recording. Unlike the old
      // background-page approach, this one can't survive that: the canvas
      // living in the tab is exactly what makes captureStream() actually
      // work (see the comment above), so there's nothing left to record
      // into. Fail visibly instead of spinning forever.
      if (session.consecutiveSendFailures >= 3 && activeFrameStitch === session) {
        console.error("ScreenRec: lost the in-tab frame-stitch recorder (3 consecutive failed sends) — tab likely navigated or closed", e);
        activeFrameStitch = null;
        if (session.intervalHandle) clearInterval(session.intervalHandle);
        await notify("errorTitle", "errorTitle");
        await resetRecordingState();
        await updateBadge();
      }
    }
  } catch (e) {
    // A single missed tick isn't fatal for the recording as a whole — the
    // previous frame just stays on the canvas a little longer. Only log.
    console.error("ScreenRec: frame-stitch capture tick failed", e);
  } finally {
    session.capturing = false;
  }
}

async function beginFrameStitchRecording(
  tab: chrome.tabs.Tab,
  { rect, dpr, viewportWidth, viewportHeight }: { rect: Rect; dpr: number; viewportWidth?: number; viewportHeight?: number }
): Promise<void> {
  const outW = Math.max(2, Math.round(rect.width * dpr));
  const outH = Math.max(2, Math.round(rect.height * dpr));

  const videoFormat = await getPreferredVideoFormat();
  // This MUST be the video-only picker, not
  // pickSupportedMimeTypeInBrowser() — canvas.captureStream() below never
  // has an audio track, and a mimeType naming an audio codec (opus/aac)
  // against a stream with none was the actual reason this whole recording
  // path produced 0 bytes every time (see the comment on
  // WEBM_VIDEO_ONLY_CANDIDATES in lib/video-format.ts for the full story).
  const mimeType = pickSupportedVideoOnlyMimeTypeInBrowser(videoFormat === "mp4") || "video/webm";
  const bitrate = await getVideoBitrate();

  const session: FrameStitchSession = {
    tabId: tab.id as number,
    windowId: tab.windowId,
    rect,
    dpr,
    viewportWidth,
    viewportHeight,
    outW,
    outH,
    mimeType,
    intervalHandle: null,
    capturing: false,
    consecutiveSendFailures: 0,
    blobChunks: new Map(),
    blobChunksExpected: null,
    diagSamplesLogged: 0,
  };
  activeFrameStitch = session;

  await setState({
    recordingTabId: tab.id as number,
    recordingTabTitle: tab.title || null,
    recordingRect: rect,
    recordingDpr: dpr,
    isRecording: true,
    recordingStartedAt: Date.now(),
  });
  await updateBadge();

  // chrome.tabs.captureVisibleTab only works on the active tab of its
  // window — make sure that's still this one before the capture loop
  // starts relying on it every tick (mirrors the same call in
  // beginTabRecording's Chrome branch, for the same reason).
  try {
    await chrome.tabs.update(tab.id as number, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    /* tab/window may have gone away; not fatal */
  }

  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: ["shim.js", "frame-stitch-recorder.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id as number },
      func: (w: number, h: number, mt: string, br: number | null | undefined, fps: number, d: number) =>
        (window as any).__screenrecStartFrameStitch__(w, h, mt, br ?? undefined, fps, d),
      args: [outW, outH, mimeType, bitrate, FRAME_STITCH_CAPTURE_FPS, dpr],
    });
  } catch (e) {
    console.error("ScreenRec: failed to start in-tab frame-stitch recorder", e);
    activeFrameStitch = null;
    await notify("errorTitle", "errorTitle");
    await resetRecordingState();
    await updateBadge();
    return;
  }

  session.intervalHandle = setInterval(() => {
    captureFrameAndForward(session).catch(() => {});
  }, FRAME_STITCH_INTERVAL_MS);
  // Send the very first frame right away rather than waiting up to
  // FRAME_STITCH_INTERVAL_MS for the interval's first tick, so a recording
  // stopped almost immediately doesn't open on a blank frame.
  captureFrameAndForward(session).catch(() => {});

  // The exact same live drawing/annotation overlay the Chrome/tabCapture
  // path and the getDisplayMedia fallback both already use. Its "Stop
  // recording" button already sends a generic STOP_RECORDING_REQUEST, and
  // stopRecording() below now checks activeFrameStitch first — nothing
  // about the overlay itself needed to change for this new capture path.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: ["shim.js", "annotate-overlay.js"] });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id as number },
      func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d),
      args: [rect, dpr],
    });
  } catch (e) {
    console.error("ScreenRec: failed to inject annotation overlay (frame-stitch path)", e);
  }
}

function stopFrameStitchRecording(): void {
  const session = activeFrameStitch;
  if (!session) return;
  // Clear this immediately, before doing anything else that could throw or
  // wait on a message round-trip: it's what makes this function
  // idempotent. If a second STOP_RECORDING_REQUEST arrives before the
  // first one finishes (e.g. the on-page overlay's "Stop" button and the
  // side panel's are both clicked), `activeFrameStitch` is already null by
  // then, so the second call just returns instead of sending a second stop
  // message or racing the first save.
  activeFrameStitch = null;
  frameStitchPendingSave = session;
  if (session.intervalHandle) clearInterval(session.intervalHandle);

  if (frameStitchStopWatchdog) clearTimeout(frameStitchStopWatchdog);
  frameStitchStopWatchdog = setTimeout(() => {
    frameStitchStopWatchdog = null;
    console.error("ScreenRec: frame-stitch stop watchdog fired — stop/save never completed");
    (async () => {
      await notify("errorTitle", "errorTitle");
      await resetRecordingState();
      await updateBadge();
    })().catch((e) => console.error("ScreenRec: frame-stitch stop watchdog cleanup failed", e));
  }, FRAME_STITCH_STOP_WATCHDOG_MS);

  chrome.tabs.sendMessage(session.tabId, { type: "FRAME_STITCH_STOP" }).catch((e) => {
    // Tab's gone (navigated away or closed) — the in-tab recorder went
    // with it, so it will never report back. Finish now instead of
    // waiting out the full 15s watchdog for a reply that isn't coming.
    console.error("ScreenRec: could not deliver stop request to in-tab frame-stitch recorder", e);
    if (frameStitchPendingSave === session) {
      frameStitchPendingSave = null;
      finishFrameStitchWithoutBlob(session, "tab-unreachable").catch((err) =>
        console.error("ScreenRec: frame-stitch stop handling failed", err)
      );
    }
  });
}

// Common failure-path cleanup for when there's no blob to save at all
// (empty recording, a content-script-reported exception, or the tab having
// gone away entirely before/during the stop handshake).
async function finishFrameStitchWithoutBlob(session: FrameStitchSession, reason: string): Promise<void> {
  if (frameStitchStopWatchdog) {
    clearTimeout(frameStitchStopWatchdog);
    frameStitchStopWatchdog = null;
  }
  console.error(`ScreenRec: frame-stitch recording finished with nothing to save (${reason})`);
  await notify("errorTitle", "errorTitle");
  await resetRecordingState();
  await updateBadge();
}

// Called once frame-stitch-recorder.ts has reported FRAME_STITCH_TAB_RESULT
// { ok: true } and every chunk of the base64-encoded blob it announced has
// arrived — see the FRAME_STITCH_TAB_BLOB_CHUNK/FRAME_STITCH_TAB_RESULT
// cases in the onMessage listener below.
async function handleFrameStitchBlobComplete(session: FrameStitchSession): Promise<void> {
  if (frameStitchStopWatchdog) {
    clearTimeout(frameStitchStopWatchdog);
    frameStitchStopWatchdog = null;
  }
  let handedOff = false;
  try {
    const total = session.blobChunksExpected;
    if (total === null || session.blobChunks.size !== total) {
      console.error("ScreenRec: frame-stitch blob transfer incomplete", { got: session.blobChunks.size, expected: total });
      await notify("errorTitle", "errorTitle");
      return;
    }
    let dataUrl = "";
    for (let i = 0; i < total; i++) {
      const part = session.blobChunks.get(i);
      if (part === undefined) {
        console.error("ScreenRec: frame-stitch blob transfer missing chunk", i);
        await notify("errorTitle", "errorTitle");
        return;
      }
      dataUrl += part;
    }
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    if (blob.size === 0) {
      console.error("ScreenRec: frame-stitch recording produced 0 bytes");
      await notify("errorTitle", "errorTitle");
      return;
    }
    const ext = extensionForMimeType(session.mimeType);
    const blobId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await storeBlobRecord(blobId, { blob, createdAt: Date.now() });
    handedOff = true;
    // saveRecordingBlobDirectly has its own try/catch/finally and always
    // resets isRecording/isSaving itself, success or failure — don't
    // duplicate that below.
    await saveRecordingBlobDirectly(blobId, timestampName(ext, new Date(), "ScreenRec-"), "area");
  } catch (e) {
    // Anything that throws before reaching saveRecordingBlobDirectly (e.g.
    // storeBlobRecord failing) used to strand isSaving/isRecording forever
    // with nothing but a console.error nobody sees — exactly the
    // "Saving…"/"Stopping…" stuck bug. Always resolve the state below
    // instead.
    console.error("ScreenRec: frame-stitch stop handling failed", e);
    await notify("errorTitle", "errorTitle");
  } finally {
    if (!handedOff) {
      await resetRecordingState();
      await updateBadge();
    }
  }
}

// ---------- Video recording: offscreen-backed (Chrome) ----------

interface BeginTabRecordingOptions {
  audio?: boolean;
  rect?: Rect;
  dpr?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

// Chrome screen-mode recording (app.ts's getDisplayMedia() +
// WebRTC relay to offscreen.ts) has no tabId of its own in background.ts's
// state — see annotationOverlayTabId's comment for why that's deliberate.
// app.ts DOES know which tab it was open on when recording started, and
// asks for the overlay explicitly via INJECT_VIDEO_ANNOTATION_OVERLAY
// rather than background.ts trying to guess. Same best-effort caveat as
// every other fallback path here: if the person shares something other
// than this exact tab in the browser's own picker, the overlay simply
// won't be part of what's captured — nothing this extension can detect.
async function injectScreenModeAnnotationOverlay(tabId?: number): Promise<void> {
  if (tabId == null) return;
  try {
    const { videoDrawToolEnabled } = await getSettings();
    if (!videoDrawToolEnabled) return;
    const [{ result: info }] = await chrome.scripting.executeScript<[], { viewportWidth: number; viewportHeight: number; dpr: number }>({
      target: { tabId },
      func: () => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
    });
    const rect: Rect = { x: 0, y: 0, width: info.viewportWidth, height: info.viewportHeight };
    await chrome.scripting.executeScript({ target: { tabId }, files: ["shim.js", "annotate-overlay.js"] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d, { mode: "video", floatingToolbar: true }),
      args: [rect, info.dpr || 1],
    });
    await setState({ annotationOverlayTabId: tabId });
  } catch (e) {
    // Restricted page, tab closed, etc. — recording (relayed over WebRTC,
    // independent of this tab) keeps working fine either way; there's just
    // no on-page draw tool for it this time.
    console.error("ScreenRec: failed to inject screen-mode annotation overlay", e);
  }
}

// Record the current tab (optionally cropped to `rect`) with no OS picker,
// using chrome.tabCapture + an offscreen document so it survives the popup
// closing.
async function beginTabRecording(
  tab: chrome.tabs.Tab,
  { audio, rect, dpr, viewportWidth, viewportHeight }: BeginTabRecordingOptions
): Promise<void> {
  // NOTE: this whole function used to have its early-return branch (below)
  // OUTSIDE the try/catch that wraps everything else. On Firefox (which
  // always takes this branch, since it has neither chrome.offscreen nor
  // chrome.tabCapture), any failure in openRecorderWindowFallback — e.g.
  // chrome.windows.create being refused — became an unhandled promise
  // rejection with no user-facing notification and no state cleanup, which
  // looked exactly like "recording just doesn't start, no error, nothing
  // happens". Both branches are now covered by the same try/catch.
  try {
    if (!HAS_TAB_CAPTURE || !HAS_OFFSCREEN) {
      // Area mode on Firefox now goes through the SAME getDisplayMedia()
      // popup window (recorder.html) as full-tab/full-screen modes,
      // instead of the frame-stitching path (beginFrameStitchRecording
      // below), which was originally built specifically to avoid this
      // popup for area recordings.
      //
      // That approach was abandoned after an exhaustive investigation
      // (written up in full in ARCHITECTURE.md) found that
      // frame-stitching's canvas.captureStream()+MediaRecorder combination
      // — a canvas injected into the recorded tab via a content script —
      // reliably produces solid-black video in this Firefox environment,
      // with the actual root cause narrowed down (via ffprobe/ffmpeg on the
      // real encoded bytes) to somewhere inside Firefox's own
      // captureStream()/MediaRecorder implementation, not anything fixable
      // from this codebase. openRecorderWindowFallback's rect-handling
      // (session-stored pendingRect, annotation overlay injection) already
      // existed for exactly this case — it just wasn't being reached while
      // frame-stitching was in use — so no new recording logic was needed
      // here, only this routing change. frame-stitch-recorder.ts and the
      // FRAME_STITCH_* handling below are left in place (unreachable, kept
      // for reference) rather than deleted.
      await openRecorderWindowFallback({
        mode: rect ? "area" : "full",
        audio,
        rect,
        dpr,
        tab,
        viewportWidth,
        viewportHeight,
      });
      return;
    }
    // "tab" mode (no area selection) doesn't have viewport info yet — fetch
    // it now so we can request an exact-resolution capture below.
    if (!viewportWidth || !viewportHeight) {
      try {
        const [{ result }] = await chrome.scripting.executeScript<[], { viewportWidth: number; viewportHeight: number; dpr: number }>({
          target: { tabId: tab.id as number },
          func: () => ({
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio || 1,
          }),
        });
        viewportWidth = result.viewportWidth;
        viewportHeight = result.viewportHeight;
        dpr = result.dpr;
      } catch {
        // Non-fatal — we'll just skip the exact-resolution constraint below.
      }
    }

    await ensureOffscreenDocument();
    const streamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id as number }, (id) => {
        if (chrome.runtime.lastError || !id) reject(chrome.runtime.lastError || new Error("no stream id"));
        else resolve(id);
      });
    });
    await setState({
      recordingTabId: tab.id as number,
      recordingTabTitle: tab.title || null,
      recordingRect: rect || null,
      recordingDpr: dpr || null,
    });
    // Make sure the tab actually being recorded is the one on screen —
    // matters when the recording was kicked off via hotkey/side panel and
    // some other tab/window could otherwise end up in front.
    //
    // If Chrome had discarded this tab (its memory-saver feature unloads
    // background tabs, which can still be reported as "active" without
    // actually having a live page loaded), waking it back up via
    // tabs.update({active:true}) forces Chrome to reload it — right as the
    // recording starts, with no action from the user. That reload destroys
    // any content script already injected into the tab. We can't prevent
    // Chrome's own discard/reload behavior, but the tabs.onUpdated listener
    // below detects exactly this (a reload on the tab being recorded) and
    // re-injects the annotation overlay afterwards, so an area recording
    // doesn't end up with no on-page controls.
    try {
      await chrome.tabs.update(tab.id as number, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch {
      /* tab/window may have gone away; not fatal */
    }
    await sendToOffscreen({
      type: "START_TAB_CAPTURE",
      streamId,
      audio: !!audio,
      rect: rect || null,
      dpr: dpr || 1,
      viewportWidth: viewportWidth || null,
      viewportHeight: viewportHeight || null,
      mode: rect ? "area" : "tab",
    });

    // Area recordings get a live drawing/annotation overlay (pen + text)
    // whose strokes get composited into the recorded video in real time —
    // always on; area mode has no toggle of its own for this (the
    // videoDrawToolEnabled setting below scopes video vs. screenshots
    // generally, not a separate one per recording mode, and area recording
    // already had this tool before that setting existed).
    if (rect) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: ["shim.js", "annotate-overlay.js"] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id as number },
          func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d),
          args: [rect, dpr || 1],
        });
        await setState({ annotationOverlayTabId: tab.id as number });
      } catch (e) {
        console.error("ScreenRec: failed to inject annotation overlay", e);
      }
    } else {
      // Full-tab recording gets the same drawing tool too, just
      // floating/draggable (there's no "beside the selection" spot when
      // the drawable area is the whole viewport) and gated by its own
      // setting, unlike area mode above.
      const { videoDrawToolEnabled } = await getSettings();
      if (videoDrawToolEnabled && viewportWidth && viewportHeight) {
        try {
          const fullRect: Rect = { x: 0, y: 0, width: viewportWidth, height: viewportHeight };
          await chrome.scripting.executeScript({ target: { tabId: tab.id as number }, files: ["shim.js", "annotate-overlay.js"] });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id as number },
            func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d, { mode: "video", floatingToolbar: true }),
            args: [fullRect, dpr || 1],
          });
          await setState({ annotationOverlayTabId: tab.id as number });
        } catch (e) {
          console.error("ScreenRec: failed to inject full-tab annotation overlay", e);
        }
      }
    }
  } catch (e) {
    console.error(e);
    await resetRecordingState();
    await notify("errorTitle", "errorTitle");
  }
}

interface OpenRecorderWindowOptions {
  mode: string;
  audio?: boolean;
  rect?: Rect;
  dpr?: number;
  tab?: chrome.tabs.Tab;
  viewportWidth?: number;
  viewportHeight?: number;
}

// Fallback: small always-visible window using getDisplayMedia (used when
// offscreen/tabCapture aren't available, e.g. Firefox).
//
// For a period, area-mode recording never reached this function with a
// `rect` set — it went through beginFrameStitchRecording instead, so this
// rect-handling code sat unreachable. That has since been reverted (see
// beginTabRecording's own comment for the full reasoning): area-mode
// recordings now come through here again, with `rect`/`dpr` genuinely set.
async function openRecorderWindowFallback({
  mode,
  audio,
  rect,
  dpr,
  tab,
  viewportWidth,
  viewportHeight,
}: OpenRecorderWindowOptions): Promise<void> {
  if (rect) {
    await chrome.storage.session.set({
      pendingRect: rect,
      pendingRectDpr: dpr || 1,
      pendingRectViewportW: viewportWidth || null,
      pendingRectViewportH: viewportHeight || null,
    });
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`recorder.html?mode=${mode}&audio=${audio ? 1 : 0}`),
    type: "popup",
    width: 420,
    height: 320,
    focused: true,
  });
  await setState({
    recorderWindowId: win.id as number,
    recordingTabId: tab ? (tab.id as number) : null,
    recordingTabTitle: tab ? tab.title || null : null,
    // Needed for the chrome.tabs.onUpdated reload-recovery listener further
    // down this file — without these it only ever re-injects the overlay
    // for the Chrome/tabCapture path, never for this fallback.
    recordingRect: rect || null,
    recordingDpr: dpr || null,
    isRecording: true,
    // Deliberately NOT Date.now() here — without this, the popup/side
    // panel's timer and the recorder window's own timer could visibly
    // drift out of sync: this fires the instant recorder.html
    // is *opened*, well before the person has clicked "Start sharing"
    // inside it and picked a source in the browser's own share dialog —
    // both of which can take several seconds and are entirely up to them.
    // Stamping the real start time here made the popup/sidepanel's own
    // elapsed-time display start counting from window-open, running ahead
    // of recorder.ts's own timer (which only starts once MediaRecorder
    // actually starts) by however long the person took to click through —
    // a gap that looked like two out-of-sync clocks rather than one clock
    // that just hadn't started yet. Leaving this null keeps isRecording
    // true (so Stop/Cancel and the badge work right away) while the UI
    // shows a non-misleading "preparing" state; RECORDING_ACTUALLY_STARTED
    // below stamps the real value once recording genuinely begins, and from
    // then on both timers are reading the same clock.
    recordingStartedAt: null,
  });
  await updateBadge();

  // This browser has no chrome.tabCapture, so area recordings go through a
  // separate getDisplayMedia() picker window (recorder.html) instead of
  // capturing this tab directly — but the same live drawing/annotation
  // overlay (pen, text, GIFs, layers) the Chrome/tabCapture path uses still
  // works here: if the person picks *this* tab in the browser's own share
  // picker, anything drawn on top of the page is part of what
  // getDisplayMedia() captures. recorder.ts's buildCroppedStream() already
  // crops the captured video down to `rect` using the same pendingRect this
  // function just wrote to session storage, so the toolbar itself (drawn
  // outside `rect`, beside the selection) is naturally excluded from the
  // recording — exactly like the Chrome path. Without this, area recordings
  // here had no drawing tools at all (reported bug). If the person instead
  // shares a different tab/window/screen, the overlay simply won't be part
  // of what's recorded — an inherent limit of the OS/browser picker, not
  // something this extension can control.
  if (rect && tab && tab.id != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shim.js", "annotate-overlay.js"] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d),
        args: [rect, dpr || 1],
      });
      await setState({ annotationOverlayTabId: tab.id });
    } catch (e) {
      console.error("ScreenRec: failed to inject annotation overlay (fallback recorder path)", e);
    }
  } else if (!rect && tab && tab.id != null) {
    // Same reasoning as beginTabRecording's own "else" branch
    // (the Chrome/tabCapture path): full-tab recording gets the same
    // floating draw tool too, gated by its own setting. `mode === "full"`
    // covers BOTH plain tab-recording (tab known — this IS that case) and
    // true screen/legacy mode (tab unknown, so this whole branch is simply
    // never reached — see openRecorderWindowFallback's OTHER caller,
    // START_LEGACY_SCREEN_RECORDING, which never passes a tab at all,
    // exactly because there's no way to know which one it'd even be).
    const { videoDrawToolEnabled } = await getSettings();
    if (videoDrawToolEnabled) {
      try {
        const [{ result: info }] = await chrome.scripting.executeScript<[], { viewportWidth: number; viewportHeight: number; dpr: number }>({
          target: { tabId: tab.id },
          func: () => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
        });
        const fullRect: Rect = { x: 0, y: 0, width: info.viewportWidth, height: info.viewportHeight };
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["shim.js", "annotate-overlay.js"] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (r: Rect, d: number) => (window as any).__screenrecStartAnnotation__(r, d, { mode: "video", floatingToolbar: true }),
          args: [fullRect, info.dpr || 1],
        });
        await setState({ annotationOverlayTabId: tab.id });
      } catch (e) {
        console.error("ScreenRec: failed to inject full-tab annotation overlay (fallback recorder path)", e);
      }
    }
  }
}

async function stopRecording(): Promise<void> {
  // Also bail if a stop is already in flight (isSaving), not just when
  // isRecording is already false: both the on-page annotation overlay and
  // the popup/side panel have their own independent "Stop" button, each
  // sending its own STOP_RECORDING_REQUEST. Without this, a second request
  // arriving while the first stop is still being handled would re-enter
  // this whole function — harmless for the offscreen/recorder-window paths
  // (already guarded by their own try/catch), but it used to be able to
  // call into the frame-stitch path a second time for the same recording.
  if (!state.isRecording || state.isSaving) return;
  await setState({ isSaving: true, savingProgress: null });
  await updateBadge();
  await notifyTabSaving();
  if (activeFrameStitch) {
    try {
      stopFrameStitchRecording();
    } catch (e) {
      // Shouldn't happen — stopFrameStitchRecording() guards its own risky
      // calls internally — but this used to be completely unguarded, and an
      // uncaught throw here silently stranded isSaving forever, so keep a
      // last-resort catch here too.
      console.error("ScreenRec: failed to stop frame-stitch recording", e);
      await notify("errorTitle", "errorTitle");
      await resetRecordingState();
      await updateBadge();
    }
  } else if (HAS_OFFSCREEN && state.recorderWindowId == null) {
    try {
      await sendToOffscreen({ type: "STOP_RECORDING" });
    } catch {
      // offscreen doc might already be gone
    }
  } else if (state.recorderWindowId != null) {
    try {
      await chrome.runtime.sendMessage({ target: "recorderWindow", type: "RECORDER_STOP_REQUEST" });
    } catch {
      // window already closed
    }
  }
}

async function toggleRecordingViaHotkey(tab: chrome.tabs.Tab): Promise<void> {
  const { lastMode = "tab", lastAudio = true } = await chrome.storage.local.get<{
    lastMode?: string;
    lastAudio?: boolean;
  }>(["lastMode", "lastAudio"]);
  if (lastMode === "area") {
    try {
      await startAreaSelection(tab.id as number, "video", lastAudio);
    } catch (e) {
      console.error(e);
      await notify("errorTitle", "errorTitle");
    }
  } else if (lastMode === "screen") {
    // Full desktop/window capture needs a real user gesture inside a visible
    // page (browser security requirement) — can't be started headlessly
    // from a hotkey. Open the side panel so the user can click Start there.
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        const [win] = await chrome.windows.getAll();
        if (win) await chrome.sidePanel.open({ windowId: win.id as number });
      } else if (chrome.sidebarAction && chrome.sidebarAction.open) {
        // Firefox has no side panel API — sidebarAction is its equivalent.
        // Must be called from inside a user-action handler, which this
        // hotkey (commands.onCommand) listener is.
        await chrome.sidebarAction.open();
      }
    } catch {
      /* ignore */
    }
  } else {
    await beginTabRecording(tab, { audio: lastAudio });
  }
}

// ---------- Message + event wiring ----------

chrome.commands.onCommand.addListener(async (command) => {
  await stateReady;
  if (command === "toggle-recording") {
    if (state.isRecording) {
      await stopRecording();
      return;
    }
    const tab = await guardActiveTab();
    if (!tab) return;
    await toggleRecordingViaHotkey(tab);
    return;
  }
  const tab = await guardActiveTab();
  if (!tab) return;
  if (command === "capture-full-screenshot") await doCaptureVisible(tab);
  if (command === "capture-area-screenshot") await doCaptureArea(tab);
});

chrome.runtime.onMessage.addListener((message: any, sender: chrome.runtime.MessageSender, sendResponse: (r?: any) => void) => {
  if (message.target && message.target !== "background") return; // not for us

  // IMPORTANT: this whole async block used to run with no top-level
  // try/catch and no guarantee sendResponse() would ever be called. Any
  // exception thrown by a case that didn't wrap its own await in a try/catch
  // (chrome.scripting.executeScript / chrome.tabCapture throwing "The
  // extensions gallery cannot be scripted" on a Chrome Web Store tab was one
  // real example) became an unhandled promise rejection — logged as
  // "Uncaught (in promise) Error: ..." — AND left sendResponse() uncalled.
  // The caller's `await chrome.runtime.sendMessage(...)` then just hangs
  // (or eventually rejects with "message port closed"), which from the
  // popup/side panel/overlay's perspective looks exactly like "the app
  // stopped responding to input". Wrapping the whole thing means every code
  // path — known or not — always resolves the sender's promise.
  let responded = false;
  const respond = (payload?: any) => {
    if (responded) return;
    responded = true;
    try {
      sendResponse(payload);
    } catch {
      // sender's port may already be gone — nothing to do
    }
  };

  (async () => {
    await stateReady;
    switch (message.type) {
      case "GET_STATE": {
        respond({
          isRecording: state.isRecording,
          isSaving: state.isSaving,
          recordingStartedAt: state.recordingStartedAt,
          hasOffscreen: HAS_OFFSCREEN,
          hasTabCapture: HAS_TAB_CAPTURE,
          recordingTabId: state.recordingTabId,
          recordingTabTitle: state.recordingTabTitle,
          savingProgress: state.savingProgress,
          isSelectingArea: state.isSelectingArea,
          // Exposed (rather than duplicating the constant in
          // app.ts) so the popup/side panel can show a countdown warning
          // before the cap auto-stops the recording — see
          // MAX_RECORDING_DURATION_MS's own comment above.
          maxRecordingDurationMs: MAX_RECORDING_DURATION_MS,
          durationWarningLeadMs: DURATION_WARNING_LEAD_MS,
        });
        break;
      }
      case "CAPTURE_VISIBLE": {
        const tab = await guardActiveTab();
        if (tab) await doCaptureVisible(tab);
        respond({ ok: !!tab });
        break;
      }
      case "CAPTURE_AREA_SCREENSHOT": {
        const tab = await guardActiveTab();
        if (tab) await doCaptureArea(tab);
        respond({ ok: !!tab });
        break;
      }
      case "CAPTURE_FULLPAGE": {
        const tab = await guardActiveTab();
        if (tab) await startFullPageCapture(tab);
        respond({ ok: !!tab });
        break;
      }
      case "AREA_SELECTED": {
        await handleAreaSelected(message, sender);
        respond({ ok: true });
        break;
      }
      case "SCREENSHOT_ANNOTATION_SAVE": {
        await handleScreenshotAnnotationSave(message.dataUrl, sender.tab?.id ?? null, message.logMode);
        respond({ ok: true });
        break;
      }
      case "SCREENSHOT_ANNOTATION_CANCEL": {
        respond({ ok: true });
        break;
      }
      case "FULLPAGE_ANNOTATION_SAVE": {
        await handleFullPageAnnotationSave(sender.tab);
        respond({ ok: true });
        break;
      }
      case "FULLPAGE_ANNOTATION_CANCEL": {
        respond({ ok: true });
        break;
      }
      case "COPY_LAST_SCREENSHOT": {
        try {
          const { lastScreenshotDataUrl } = await chrome.storage.session.get<{ lastScreenshotDataUrl?: string }>([
            "lastScreenshotDataUrl",
          ]);
          if (lastScreenshotDataUrl) {
            const ok = await copyDataUrlToClipboard(lastScreenshotDataUrl);
            respond({ ok });
          } else {
            respond({ ok: false, error: "no_screenshot" });
          }
        } catch (e) {
          console.error(e);
          respond({ ok: false, error: String(e) });
        }
        break;
      }
      case "START_TAB_RECORDING": {
        await chrome.storage.local.set({ lastMode: "tab", lastAudio: !!message.audio });
        const tab = await guardActiveTab();
        if (tab) await beginTabRecording(tab, { audio: !!message.audio });
        respond({ ok: !!tab });
        break;
      }
      case "START_LEGACY_SCREEN_RECORDING": {
        await chrome.storage.local.set({ lastMode: "screen", lastAudio: !!message.audio });
        await openRecorderWindowFallback({ mode: "full", audio: !!message.audio });
        respond({ ok: true });
        break;
      }
      case "INJECT_VIDEO_ANNOTATION_OVERLAY": {
        // Chrome screen-mode's own relay path (app.ts's
        // startScreenRecordingWithRelay()): background.ts has no reliable
        // tabId of its own for screen mode at all (see
        // annotationOverlayTabId's comment) — app.ts asks explicitly for
        // whichever tab it was actually open on.
        await injectScreenModeAnnotationOverlay(message.tabId);
        respond({ ok: true });
        break;
      }
      case "START_RECORDING_AREA_SELECT": {
        await chrome.storage.local.set({ lastMode: "area", lastAudio: !!message.audio });
        const tab = await guardActiveTab();
        // No "Select an area" OS notification fires here either
        // (see doCaptureArea()'s matching comment above) — only
        // save/error notifications remain.
        if (tab) await startAreaSelection(tab.id as number, "video", !!message.audio);
        respond({ ok: !!tab });
        break;
      }
      case "ENSURE_OFFSCREEN": {
        await chrome.storage.local.set({ lastMode: "screen", lastAudio: !!message.audio });
        const ok = await ensureOffscreenDocument();
        respond({ ok });
        break;
      }
      case "SCREEN_RECORDING_STARTED": {
        // Sent by popup/sidepanel once the WebRTC relay to the offscreen doc
        // is up and MediaRecorder has started there.
        await setState({
          isRecording: true,
          recordingStartedAt: Date.now(),
          recordingTabId: null, // not tied to a specific tab
          recordingTabTitle: null,
        });
        await updateBadge();
        respond({ ok: true });
        break;
      }
      case "OFFSCREEN_RECORDING_STARTED": {
        await setState({ isRecording: true, recordingStartedAt: Date.now() });
        await updateBadge();
        respond({ ok: true });
        break;
      }
      case "RECORDING_ACTUALLY_STARTED": {
        // openRecorderWindowFallback() marks isRecording true (with
        // recordingStartedAt left null — see its own comment) as soon as
        // the recorder.html window is opened, so the popup/sidepanel's
        // Stop/Cancel button and badge work even before the person has
        // clicked "Start sharing" inside it and picked a source. recorder.ts
        // sends this once MediaRecorder.start() has genuinely run, which is
        // the first time there's a real elapsed time to show — stamp it now.
        await setState({ recordingStartedAt: Date.now() });
        respond({ ok: true });
        break;
      }
      case "RECORDING_STOPPING": {
        // Sent by recorder.ts the instant Stop/Cancel is clicked there (or
        // the shared source ends on its own), before the async
        // MediaRecorder.stop()->onstop->SAVE_RECORDING_BLOB chain even
        // starts. Flips isSaving early so the popup/sidepanel freezes its
        // elapsed-time display right away instead of continuing to count up
        // through that whole round trip (and, in the worst case, the 20s
        // SAVE_WATCHDOG_MS timeout below) while recorder.ts's own window has
        // already stopped and looks frozen by comparison — reported as
        // "addon's timer keeps going, the recorder window's froze".
        // Harmless if stopRecording() (the popup/sidepanel-initiated Stop
        // path) already set this; resetRecordingState() clears it either way
        // once the save (or cancel) actually finishes.
        if (state.isRecording) {
          await setState({ isSaving: true, savingProgress: null });
          await updateBadge();
          await notifyTabSaving();
        }
        respond({ ok: true });
        break;
      }
      case "CROP_PROGRESS": {
        // Relayed straight from recorder.ts's
        // ffmpeg.on("progress", ...) during cropRecordedBlobWithFfmpeg().
        // Only meaningful while actually saving; a stray/late message
        // after the fact (or from a previous recording) shouldn't revive
        // a progress bar that's already been reset.
        if (state.isSaving && typeof message.progress === "number") {
          await setState({ savingProgress: Math.min(1, Math.max(0, message.progress)) });
        }
        respond({ ok: true });
        break;
      }
      case "SAVE_RECORDING_BLOB": {
        // Defensive: normally already true via RECORDING_STOPPING above, but
        // set it here too in case that message was lost — the save-helper
        // round trip below is exactly the stretch that must not look like
        // "still recording" in the popup/sidepanel (or the on-page overlay —
        // see notifyTabSaving()).
        await setState({ isSaving: true });
        await updateBadge();
        await notifyTabSaving();
        // No notification fires here for a skipped crop anymore: cropping
        // is now always attempted when Area was selected (see recorder.ts's
        // computeAreaCropRect()), so there's no longer a "skipped" case —
        // for a non-"This Tab" share — to surface.
        await saveRecordingBlobViaHelper(message.blobId, message.filename, message.mode);
        respond({ ok: true });
        break;
      }
      case "SAVE_RECORDING_RESULT": {
        if (message.blobId) {
          const watchdog = pendingSaveWatchdogs.get(message.blobId);
          if (watchdog) {
            clearTimeout(watchdog);
            pendingSaveWatchdogs.delete(message.blobId);
          }
        }
        if (message.ok) {
          await appendLogEntry({
            downloadId: message.downloadId,
            type: "video",
            filename: message.filename,
            timestamp: Date.now(),
            mode: message.mode,
          });
          await notify("recordingSavedTitle", "recordingSavedMsg");
        } else {
          console.error("ScreenRec: save-helper reported failure —", message.detail);
          await notify("errorTitle", "errorTitle");
        }
        await resetRecordingState();
        await updateBadge();
        await closeOffscreenDocumentIfIdle();
        respond({ ok: true });
        break;
      }
      case "OFFSCREEN_RECORDING_ERROR": {
        console.error("ScreenRec: recording failed —", message.detail || "unknown reason");
        await resetRecordingState();
        await updateBadge();
        await notify("errorTitle", "errorTitle");
        await closeOffscreenDocumentIfIdle();
        respond({ ok: true });
        break;
      }
      case "STOP_RECORDING_REQUEST": {
        await stopRecording();
        respond({ ok: true });
        break;
      }
      // Sent by src/frame-stitch-recorder.ts, the content script
      // that now owns the canvas/MediaRecorder for Firefox area-mode video
      // recording (moved out of this background page — see the big
      // comment above the FrameStitchSession interface for why). All three
      // are matched against frameStitchPendingSave, not activeFrameStitch:
      // by the time any of these can arrive, stopFrameStitchRecording()
      // has already nulled activeFrameStitch for its own idempotency.
      case "FRAME_STITCH_TAB_LOG": {
        console.error("ScreenRec (in-tab frame-stitch recorder):", message.message);
        respond({ ok: true });
        break;
      }
      case "RECORDER_LOG": {
        // Same pattern as FRAME_STITCH_TAB_LOG above, for recorder.ts: that
        // window can close itself within ~1.2-1.6s of a silent failure —
        // too fast to reliably open its own devtools console before it's
        // gone (the recording window disappears right after starting, with
        // an empty console). Relaying here means the trail survives in
        // background's own console (which outlives the popup) instead.
        console.error("ScreenRec (recorder.html):", message.message);
        respond({ ok: true });
        break;
      }
      case "FRAME_STITCH_TAB_BLOB_CHUNK": {
        const session = frameStitchPendingSave;
        if (session && sender.tab?.id === session.tabId) {
          session.blobChunks.set(message.index, message.chunk);
          session.blobChunksExpected = message.total;
          if (message.mimeType) session.mimeType = message.mimeType;
        }
        respond({ ok: true });
        break;
      }
      case "FRAME_STITCH_TAB_RESULT": {
        const session = frameStitchPendingSave;
        if (session && sender.tab?.id === session.tabId) {
          frameStitchPendingSave = null;
          if (message.ok) {
            await handleFrameStitchBlobComplete(session);
          } else {
            // Diagnostic-only fields (see frame-stitch-recorder.ts's
            // finishSession): if the reason is "empty", framesDrawn says
            // whether frames were ever actually drawn onto the in-tab
            // canvas at all, and dataAvailableEvents/BytesTotal say
            // whether MediaRecorder's ondataavailable ever fired at all
            // (even with 0-byte payloads) — recorderState alone can't tell
            // the two apart, since stop() sets it to "inactive" regardless
            // of whether anything was ever captured.
            if (message.reason === "empty") {
              console.error("ScreenRec: in-tab frame-stitch recorder diagnostics", {
                framesDrawn: message.framesDrawn,
                recorderState: message.recorderState,
                dataAvailableEvents: message.dataAvailableEvents,
                dataAvailableBytesTotal: message.dataAvailableBytesTotal,
                frameDecodeErrors: message.frameDecodeErrors,
              });
            }
            await finishFrameStitchWithoutBlob(session, message.reason || "unknown");
          }
        }
        respond({ ok: true });
        break;
      }
      case "RECORDING_FINISHED": {
        // legacy fallback-window path (kept for safety)
        await resetRecordingState();
        await updateBadge();
        await notify("recordingSavedTitle", "recordingSavedMsg");
        respond({ ok: true });
        break;
      }
      case "RECORDING_CANCELLED": {
        // recorder.ts (the Firefox fallback window) sends this for several
        // different reasons — most of them are the user backing out
        // on purpose (denying the share picker, clicking Cancel), which
        // should stay silent. "no_data"/"setup_failed" are genuine
        // failures: the recorder actually started but produced zero
        // bytes, or setup itself threw. Those two used to be silently
        // lumped in with the intentional-cancel case, so the window would
        // just close a couple of seconds after "recording" with nothing
        // saved and no visible explanation at all — see ARCHITECTURE.md for
        // the investigation notes. The equivalent failure on the
        // Chrome/offscreen.ts path already surfaces via
        // OFFSCREEN_RECORDING_ERROR below; this
        // brings the Firefox path to parity with it.
        if (message.reason === "no_data" || message.reason === "setup_failed") {
          console.error("ScreenRec: Firefox recorder window reported a failed recording —", message.reason);
          await notify("errorTitle", "errorTitle");
        }
        // select-overlay.ts's finish(false) sends this exact message type
        // for a Cancel/Esc on the area-selection overlay too (not just the
        // Firefox fallback recorder window) — clear the selection-in-
        // progress flag here as well so cancelling brings the trigger
        // buttons straight back.
        await clearAreaSelectionState();
        await resetRecordingState();
        await updateBadge();
        respond({ ok: true });
        break;
      }
      case "FOCUS_RECORDING_TAB": {
        if (state.recordingTabId != null) {
          try {
            const t = await chrome.tabs.get(state.recordingTabId);
            await chrome.tabs.update(state.recordingTabId, { active: true });
            await chrome.windows.update(t.windowId, { focused: true });
          } catch {
            // tab may have been closed
          }
        }
        respond({ ok: true });
        break;
      }
      default:
        respond({ ok: false, error: "unknown message" });
    }
  })()
    .catch(async (e) => {
      // Catch-all for anything a case above didn't already handle itself
      // (a case whose own try/catch doesn't cover every await, or a
      // completely unanticipated failure like an unsupported chrome.* call
      // throwing on a page we didn't know was restricted). Without this,
      // such an error becomes an unhandled promise rejection AND — because
      // respond() would never get called — leaves the caller's
      // chrome.runtime.sendMessage() promise hanging indefinitely.
      console.error("ScreenRec: unhandled error in message handler for", message && message.type, e);
      try {
        await notify("errorTitle", "errorTitle");
      } catch {
        /* ignore */
      }
      respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      // Belt and suspenders: guarantee the message port is always resolved,
      // even if some future case is added that forgets to call respond().
      respond();
    });
  return true; // keep the message channel open for async sendResponse
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await stateReady;
  if (windowId === state.recorderWindowId) {
    await resetRecordingState();
    await updateBadge();
  }
});

// Closing the tab an area-selection overlay is running in kills
// its content script (and the overlay with it) with no message ever sent
// back — select-overlay.ts only reports back on confirm/cancel, both of
// which require the page to still exist. Without this, isSelectingArea
// would stay stuck true forever, permanently hiding "Select area &
// capture" / "Selected area of this tab" in both the popup and side panel.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await stateReady;
  if (tabId === state.selectingAreaTabId) {
    await clearAreaSelectionState();
  }
});

// Same idea as the tabs.onRemoved listener just above, for the case where
// the tab isn't closed but navigates to a different page (or reloads) out
// from under an in-progress selection — that destroys the content script
// (and the overlay) just as completely as closing the tab does, but fires
// "loading", not a removal event.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await stateReady;
  if (changeInfo.status === "loading" && tabId === state.selectingAreaTabId) {
    await clearAreaSelectionState();
  }
});

// Content scripts injected via chrome.scripting.executeScript are NOT
// re-injected automatically on navigation (unlike a declarative
// content_scripts entry in the manifest) — a reload/navigation on the tab
// destroys them for good. For an "area" video recording, the annotation
// overlay (src/annotate-overlay.ts) is the only on-page control surface
// (it hosts the Stop button, drawing tools, etc.), so losing it mid-recording
// left the tab looking like the recording "stopped responding": the
// tabCapture stream itself isn't tied to the page and keeps recording
// right through a reload, but there was nothing left on the page to stop it
// or draw on it with.
//
// This can happen for reasons outside the extension's control (the site's
// own script reloading itself, the user reloading, or — plausibly the most
// common case in practice — Chrome's tab-discard/memory-saver feature
// waking a previously-suspended tab back up, which beginTabRecording's own
// tabs.update({active:true}) call above can trigger). Rather than trying to
// prevent every possible cause, we detect the navigation and put the
// overlay back.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  await stateReady;
  if (changeInfo.status !== "complete" || !state.isRecording || tabId !== state.recordingTabId) {
    return;
  }
  // This re-injects for "area" mode (state.recordingRect set), and also
  // for full-tab recording, which can now ALSO have an
  // overlay to lose on reload (the new floating draw tool, gated by its
  // own setting) — re-check the setting here rather than trusting whatever
  // was true when recording started, since it could have changed mid-
  // recording via the settings panel.
  const isAreaMode = !!state.recordingRect;
  let videoDrawToolEnabled = false;
  if (!isAreaMode) {
    ({ videoDrawToolEnabled } = await getSettings());
    if (!videoDrawToolEnabled) return;
  }
  try {
    // chrome.tabs.onUpdated can fire with status "complete" more than once
    // per navigation and for updates that aren't a real reload at all (a
    // title/favicon change, for instance). If the overlay is still alive in
    // the page — i.e. this wasn't actually a reload — annotate-overlay.js's
    // own re-injection would be a no-op (see its `__screenrecAnnotationLoaded__`
    // guard), but calling __screenrecStartAnnotation__() again would still
    // build a second toolbar/canvas on top of the first, since that factory
    // function doesn't know it's already running. Check first and bail out
    // if the overlay never actually went away.
    const [{ result: alreadyLoaded }] = await chrome.scripting.executeScript<[], boolean>({
      target: { tabId },
      func: () => !!(window as any).__screenrecAnnotationLoaded__,
    });
    if (alreadyLoaded) return;

    await chrome.scripting.executeScript({ target: { tabId }, files: ["shim.js", "annotate-overlay.js"] });
    if (isAreaMode && state.recordingRect) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (r: RecordingRect, d: number) => (window as any).__screenrecStartAnnotation__(r, d),
        args: [state.recordingRect, state.recordingDpr || 1],
      });
    } else {
      // Full-tab mode has no stored rect at all (it was never a selection)
      // — measure the CURRENT viewport fresh rather than reusing whatever
      // it was when recording started, which the reload itself may have
      // changed.
      const [{ result: info }] = await chrome.scripting.executeScript<[], { viewportWidth: number; viewportHeight: number; dpr: number }>({
        target: { tabId },
        func: () => ({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, dpr: window.devicePixelRatio || 1 }),
      });
      const fullRect: RecordingRect = { x: 0, y: 0, width: info.viewportWidth, height: info.viewportHeight };
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (r: RecordingRect, d: number) => (window as any).__screenrecStartAnnotation__(r, d, { mode: "video", floatingToolbar: true }),
        args: [fullRect, info.dpr || 1],
      });
    }
    await setState({ annotationOverlayTabId: tabId });
  } catch (e) {
    // The tab may have navigated to a restricted page (can't inject there),
    // or gone away entirely — recording keeps running either way; there's
    // just no on-page overlay to draw on/stop it from until the user
    // switches back to a normal page and uses the popup/side panel's Stop
    // button instead.
    console.error("ScreenRec: could not re-inject annotation overlay after tab reload", e);
  }
});

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.runtime.onInstalled.addListener(async () => {
  await stateReady;
  await updateBadge();
});

