// Shared logic for popup.html and sidepanel.html. `<html data-surface="...">`
// (set in each HTML file, no inline script needed for MV3 CSP) controls
// whether the surface auto-closes after triggering an action — the side
// panel stays open on purpose.

import { resolveLang, applyI18n, applyTheme, applyDirection, t, SettingsStore, type Lang, type LangPref } from "./i18n.js";
import { requestMicrophone } from "./lib/audio-mix.js";

const IS_SIDE_PANEL = document.documentElement.dataset.surface === "sidepanel";

type VideoMode = "tab" | "area" | "screen";

interface BackgroundState {
  hasOffscreen?: boolean;
  hasTabCapture?: boolean;
  isRecording?: boolean;
  isSaving?: boolean;
  savingProgress?: number | null; // 0..1 while cropping; null when there's nothing to report
  recordingStartedAt?: number;
  recordingTabId?: number;
  recordingTabTitle?: string;
  isSelectingArea?: boolean; // an area-selection overlay is open on some tab right now
  maxRecordingDurationMs?: number; // video-duration cap, see background.ts's MAX_RECORDING_DURATION_MS
  durationWarningLeadMs?: number;
}

let lang: Lang = "en";
let relayPC: RTCPeerConnection | null = null;
let timerHandle: ReturnType<typeof setInterval> | null = null;
let capabilities = { hasOffscreen: true, hasTabCapture: true };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

async function init(): Promise<void> {
  const settings = await SettingsStore.get();
  lang = resolveLang(settings.lang);
  applyI18n(document, lang);
  applyDirection(lang);
  applyTheme(settings.theme);

  (el<HTMLSelectElement>("selTheme")).value = settings.theme;
  (el<HTMLSelectElement>("selLang")).value = settings.lang;
  (el<HTMLSelectElement>("selVideoQuality")).value = settings.videoQuality;
  (el<HTMLSelectElement>("selVideoFormat")).value = settings.videoFormat;
  (el<HTMLSelectElement>("selScreenshotFormat")).value = settings.screenshotFormat;

  (el<HTMLInputElement>("chkAudio")).checked = settings.lastAudio;
  updateVideoHint(
    (["tab", "area", "screen"] as const).includes(settings.lastMode as VideoMode)
      ? (settings.lastMode as VideoMode)
      : "area"
  );

  const validUiTabs = ["screenshot", "video", "settings"];
  activateUiTab(validUiTabs.includes(settings.lastUiTab) ? settings.lastUiTab : "video");

  const autoClipboardChk = document.getElementById("chkAutoClipboard") as HTMLInputElement | null;
  if (autoClipboardChk) autoClipboardChk.checked = settings.autoClipboard;
  updateManualCopyVisibility(settings.autoClipboard);

  const screenshotDrawToolChk = document.getElementById("chkScreenshotDrawTool") as HTMLInputElement | null;
  if (screenshotDrawToolChk) screenshotDrawToolChk.checked = settings.screenshotDrawToolEnabled;
  const videoDrawToolChk = document.getElementById("chkVideoDrawTool") as HTMLInputElement | null;
  if (videoDrawToolChk) videoDrawToolChk.checked = settings.videoDrawToolEnabled;

  if (IS_SIDE_PANEL) {
    document.getElementById("btnOpenSidePanel")?.remove();
  }

  try {
    const state = await chrome.runtime.sendMessage<BackgroundState>({ target: "background", type: "GET_STATE" });
    capabilities = { hasOffscreen: !!state.hasOffscreen, hasTabCapture: !!state.hasTabCapture };
    // updateVideoHint() was already called above (from settings.lastMode)
    // before capabilities were known, using the default {hasTabCapture:
    // true} — re-run it now so a Firefox area-mode hint shown on load isn't
    // stuck with the Chrome-only "starts automatically" wording.
    updateVideoHint(lastHintMode);
  } catch {
    /* keep defaults */
  }

  if (!capabilities.hasOffscreen) {
    document.getElementById("chkAutoClipboard")?.closest(".setting-block")?.remove();
    document.getElementById("btnCopyLastScreenshot")?.remove();
  }

  await refreshRecordingState();
  wireTabs();
  wireActions();
  wireSettings();
  wireRelayListeners();
  wireStatePushListener();
  await loadShortcuts();

  // This 1s poll alone is not a reliable way for this surface to learn about
  // isSaving/savingProgress changes. A save that finishes faster than 1s (a
  // full-tab/full-screen save with no crop step — often well under a second)
  // could complete entirely BETWEEN two polls, so the "Saving…" state — and
  // the whole point of showing it — could be skipped altogether; a crop's
  // own progress ticks (which arrive much faster than 1/sec) could also
  // visibly lag or look stale for up to a second at a time.
  // wireStatePushListener() below refreshes immediately the instant
  // background.ts's state actually changes — kept alongside this poll (not
  // replacing it) as a fallback for whenever this surface was closed and
  // just reopened, same defense-in-depth style as the rest of this
  // codebase's save/stop handling.
  timerHandle = setInterval(refreshRecordingState, 1000);
  window.addEventListener("pagehide", () => {
    if (timerHandle) clearInterval(timerHandle);
  });
}

function formatElapsed(startedAt: number | undefined): string {
  if (!startedAt) return "00:00";
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function refreshRecordingState(): Promise<void> {
  try {
    const state = await chrome.runtime.sendMessage<BackgroundState>({ target: "background", type: "GET_STATE" });
    const indicator = el("recIndicator");
    const timeEl = el("recTime");
    const gotoBtn = el<HTMLButtonElement>("btnGotoTab");
    indicator.hidden = !state.isRecording;
    if (state.isRecording && !state.isSaving) {
      // Skipped while isSaving: recordingStartedAt is only cleared together
      // with isRecording, once the save (or cancel) round trip fully
      // finishes, so recomputing this every second would keep counting UP
      // for as long as that takes — well after the recorder window itself
      // already stopped and froze its own timer, which would otherwise
      // desync this displayed elapsed time from the recorder window's own.
      // Leaving timeEl alone here freezes it at whatever was last shown,
      // which is the actual final recorded duration — it doesn't grow while
      // the file saves.
      if (state.recordingStartedAt) {
        timeEl.textContent = formatElapsed(state.recordingStartedAt);
        // Video-duration cap: warn a couple of minutes before background.ts
        // auto-stops and saves the recording (see
        // MAX_RECORDING_DURATION_MS's comment there), so the person sees
        // this coming instead of just being cut off with no notice —
        // that's the whole point of having a cap the person can see, not
        // just one enforced silently. maxRecordingDurationMs/
        // durationWarningLeadMs come from background.ts rather than being
        // duplicated here, so there's exactly one place that ever needs to
        // change if the cap itself changes.
        const cap = state.maxRecordingDurationMs;
        const warnLead = state.durationWarningLeadMs;
        const remainingMs = cap ? cap - (Date.now() - state.recordingStartedAt) : Infinity;
        const nearCap = cap != null && warnLead != null && remainingMs <= warnLead;
        timeEl.classList.toggle("rec-time-warning", nearCap);
        if (nearCap) timeEl.textContent += t("videoDurationWarningSuffix", lang);
      } else {
        timeEl.textContent = t("videoPreparing", lang);
        timeEl.classList.remove("rec-time-warning");
      }
    }

    if (state.isRecording && state.recordingTabId != null) {
      gotoBtn.hidden = false;
      const label = t("goToRecordingTab", lang) + (state.recordingTabTitle ? `: ${state.recordingTabTitle}` : "");
      gotoBtn.title = label;
    } else {
      gotoBtn.hidden = true;
    }

    const modeButtons = el("videoModeButtons");
    const audioRow = el("videoAudioRow");
    const stopBtn = el<HTMLButtonElement>("btnStopVideo");
    const stopLabel = stopBtn.querySelector("span:last-child") as HTMLElement;
    const stopIcon = stopBtn.querySelector("span.icon") as HTMLElement;
    const stopFill = stopBtn.querySelector<HTMLElement>(".fill");
    const connecting = stopBtn.dataset.connecting === "1";

    if (state.isSaving) {
      modeButtons.hidden = true;
      audioRow.hidden = true;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.classList.add("saving");
      stopIcon.textContent = "⏳";
      stopLabel.textContent = t("videoSaving", lang);
      // A real filling progress bar (from ffmpeg.wasm's own crop progress,
      // relayed via background's savingProgress) when there's something to
      // report; an indeterminate sweep otherwise (full-tab/full-screen
      // saves, or area-mode with no crop step at all — e.g. cropping
      // skipped for a screen/window share) so the button never just sits
      // there looking stuck either way.
      if (stopFill) {
        if (typeof state.savingProgress === "number") {
          stopBtn.classList.add("has-progress");
          stopFill.style.width = `${Math.round(Math.min(1, Math.max(0, state.savingProgress)) * 100)}%`;
        } else {
          stopBtn.classList.remove("has-progress");
          stopFill.style.width = "";
        }
      }
    } else if (state.isRecording || connecting) {
      modeButtons.hidden = true;
      audioRow.hidden = true;
      stopBtn.hidden = false;
      stopBtn.classList.remove("saving", "has-progress");
      if (stopFill) stopFill.style.width = "";
      stopIcon.textContent = "⏹";
      if (!connecting) {
        stopBtn.disabled = false;
        stopLabel.textContent = t("videoStop", lang);
      }
    } else {
      modeButtons.hidden = false;
      audioRow.hidden = false;
      stopBtn.hidden = true;
      stopBtn.classList.remove("saving", "has-progress");
      if (stopFill) stopFill.style.width = "";
    }

    // While an area-selection overlay is open on the page, clicking a
    // DIFFERENT action (e.g. "Capture full page") needs to be impossible —
    // and this needs to stay in sync across popup and side panel. Buttons
    // are kept visible and disabled rather than hidden, since hiding them
    // makes the layout jump and the panel suddenly look empty; disabled-but-
    // present reads more clearly as "temporarily unavailable". Applies to
    // every button that could start a conflicting action while one is
    // already in progress: the three always-visible screenshot buttons, and
    // the three video mode buttons (their OWN swap-to-Stop-button behavior
    // for isRecording/isSaving above is untouched — this only adds the
    // isSelectingArea case for whenever modeButtons is otherwise shown).
    // All six read the SAME shared background flag via this same 1s poll
    // already used for isRecording/isSaving, so popup and side panel move
    // together automatically, exactly like the Stop button already does.
    const isSelecting = !!state.isSelectingArea;
    [
      el<HTMLButtonElement>("btnCaptureArea"),
      el<HTMLButtonElement>("btnCaptureVisible"),
      el<HTMLButtonElement>("btnCaptureFullPage"),
      el<HTMLButtonElement>("btnRecordArea"),
      el<HTMLButtonElement>("btnRecordTab"),
      el<HTMLButtonElement>("btnRecordScreen"),
    ].forEach((b) => {
      b.disabled = isSelecting;
      b.classList.toggle("is-locked", isSelecting);
    });
  } catch {
    // background not ready yet; ignore
  }
}

async function loadShortcuts(): Promise<void> {
  if (!chrome.commands || !chrome.commands.getAll) return;
  const commands = await chrome.commands.getAll();
  const map: Record<string, string> = {
    "toggle-recording": "kbdToggle",
    "capture-full-screenshot": "kbdFull",
    "capture-area-screenshot": "kbdArea",
  };
  commands.forEach((c) => {
    const elId = c.name ? map[c.name] : undefined;
    const target = elId ? document.getElementById(elId) : null;
    if (target) target.textContent = c.shortcut || "—";
  });
}

function activateUiTab(tabName: string): void {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const panel = document.getElementById(`panel-${tabName}`);
  if (!btn || !panel) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  panel.classList.add("active");
}

function wireTabs(): void {
  document.querySelectorAll<HTMLElement>(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as string;
      activateUiTab(tab);
      SettingsStore.set({ lastUiTab: tab as "screenshot" | "video" | "settings" });
    });
  });
}

let lastHintMode: VideoMode = "area";

function updateVideoHint(mode: VideoMode): void {
  lastHintMode = mode;
  const hintEl = el("videoHint");
  // Area mode's hint always says recording "starts automatically in the
  // background" only when that's actually true — true on Chrome
  // (chrome.tabCapture, no picker at all), but not on Firefox: without
  // chrome.tabCapture, area recording opens a small popup window that needs
  // a click plus a browser share-picker selection first. Telling Firefox
  // users it's automatic when it isn't left the popup/picker flow feeling
  // unexplained, since nothing told them what to pick in that window.
  const key =
    mode === "screen"
      ? "videoHintScreen"
      : mode === "area"
        ? capabilities.hasTabCapture
          ? "videoHintArea"
          : "videoHintAreaPopup"
        : "videoHintTab";
  hintEl.textContent = t(key, lang);
}

function updateManualCopyVisibility(autoClipboard: boolean): void {
  const btn = document.getElementById("btnCopyLastScreenshot") as HTMLElement | null;
  if (btn) btn.hidden = !!autoClipboard;
}

function maybeClose(): void {
  if (!IS_SIDE_PANEL) window.close();
}

function wireActions(): void {
  el("btnCaptureVisible").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_VISIBLE" });
    maybeClose();
  });

  el("btnCaptureArea").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_AREA_SCREENSHOT" });
    maybeClose();
  });

  el("btnCaptureFullPage").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_FULLPAGE" });
    maybeClose();
  });

  document.getElementById("btnCopyLastScreenshot")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLElement;
    const label = btn.querySelector("span:last-child") as HTMLElement;
    const original = label.textContent;
    let ok = false;
    try {
      const { lastScreenshotDataUrl } = await chrome.storage.session.get<{ lastScreenshotDataUrl?: string }>([
        "lastScreenshotDataUrl",
      ]);
      if (lastScreenshotDataUrl) {
        // Write to the clipboard right here, inside this click handler:
        // this popup/side-panel page is the one document guaranteed to
        // hold real OS focus at this exact moment, which is what
        // navigator.clipboard.write() requires to succeed. Delegating this
        // to the background script — an offscreen document, which can
        // never gain focus — is what made the old "copy" button silently
        // fail every time on Chrome.
        const resp = await fetch(lastScreenshotDataUrl);
        const blob = await resp.blob();
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        ok = true;
      }
    } catch (err) {
      console.error("ScreenRec: direct clipboard write failed, falling back to background", err);
      // Two cases land here: (1) the saved screenshot isn't PNG (jpeg/webp,
      // if the user changed that setting) — Chromium's clipboard only
      // accepts image/png, so this throws "Type ... not supported on
      // write"; the background path re-encodes to PNG first. (2) Firefox
      // versions before 127 don't support writing images via
      // navigator.clipboard.write()/ClipboardItem at all. Either way, fall
      // back to the background script, which on Firefox uses
      // browser.clipboard.setImageData() (no focus requirement) and on
      // Chrome re-encodes to PNG and injects the write into the active tab.
      try {
        const res = await chrome.runtime.sendMessage<{ ok?: boolean }>({
          target: "background",
          type: "COPY_LAST_SCREENSHOT",
        });
        ok = !!(res && res.ok);
      } catch (err2) {
        console.error("ScreenRec: background clipboard fallback also failed", err2);
      }
    }
    label.textContent = ok ? t("copyLastScreenshotDone", lang) : t("copyLastScreenshotNone", lang);
    setTimeout(() => {
      label.textContent = original;
    }, 1800);
  });

  document.querySelectorAll<HTMLElement>("#videoModeButtons .action-btn").forEach((btn) => {
    const mode = btn.dataset.mode as VideoMode;
    btn.addEventListener("mouseenter", () => updateVideoHint(mode));
    btn.addEventListener("focus", () => updateVideoHint(mode));
    btn.addEventListener("click", () => startVideoRecording(mode, btn));
  });

  el<HTMLButtonElement>("btnStopVideo").addEventListener("click", async (e) => {
    (e.currentTarget as HTMLButtonElement).disabled = true;
    await chrome.runtime.sendMessage({ target: "background", type: "STOP_RECORDING_REQUEST" });
    await refreshRecordingState();
  });

  el("btnGotoTab").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "FOCUS_RECORDING_TAB" });
  });

  document.getElementById("btnOpenSidePanel")?.addEventListener("click", async () => {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id as number });
    } else if (chrome.sidebarAction && chrome.sidebarAction.open) {
      // Firefox: sidebarAction is the equivalent of Chrome's side panel.
      await chrome.sidebarAction.open();
    }
    window.close();
  });
}

// Tab/area recording mixes the real microphone in from inside the hidden
// offscreen document (offscreen.ts's
// startTabCapture()), which can never show the browser's own "use your
// microphone?" prompt — a hidden page can't surface any UI at all. The
// very first time, that request has to come from a visible, user-activated
// page instead, so the browser has something to prompt against; the grant
// then covers this extension's whole origin, so every later attempt
// (including the hidden one) is silent. This popup is the only visible
// surface tab/area recording ever has, so it primes the permission here
// and immediately stops the probe track — the real capture (and any real
// narration) still happens in offscreen.ts.
async function primeMicrophonePermission(): Promise<void> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch (e) {
    // Denied/no device — offscreen.ts's own mixInMicrophone() hits the same
    // failure and falls back to tab/system audio only, exactly as if this
    // priming step had never run.
    //
    // getUserMedia() rejects with a DOMException (NotAllowedError,
    // NotFoundError, etc.), which does NOT extend the JS Error class in any
    // browser — logging it as a bare second console.error() argument prints
    // "[object DOMException]" the moment it's copy-pasted as plain text (the
    // live DevTools object inspector shows the real name/message just fine,
    // but that inspector view is exactly what doesn't survive a paste — the
    // same pattern that has bitten other console logs elsewhere in this
    // codebase). Spelling out .name/.message directly in the string itself
    // survives a plain-text paste no matter what.
    const detail = e instanceof DOMException || e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    console.error(`ScreenRec: microphone permission priming failed: ${detail}`);
  }
}

async function startVideoRecording(mode: VideoMode, btn: HTMLElement): Promise<void> {
  const audio = el<HTMLInputElement>("chkAudio").checked;
  await SettingsStore.set({ lastMode: mode, lastAudio: audio });

  if (mode === "tab") {
    if (audio) await primeMicrophonePermission();
    await chrome.runtime.sendMessage({ target: "background", type: "START_TAB_RECORDING", audio });
    maybeClose();
  } else if (mode === "area") {
    if (audio) await primeMicrophonePermission();
    await chrome.runtime.sendMessage({ target: "background", type: "START_RECORDING_AREA_SELECT", audio });
    maybeClose();
  } else if (mode === "screen") {
    if (capabilities.hasOffscreen) {
      const stopBtn = el<HTMLButtonElement>("btnStopVideo");
      stopBtn.dataset.connecting = "1";
      stopBtn.disabled = true;
      el("videoModeButtons").hidden = true;
      el("videoAudioRow").hidden = true;
      stopBtn.hidden = false;
      await startScreenRecordingWithRelay(audio, stopBtn);
    } else {
      // No offscreen document support (e.g. Firefox): fall back to a small
      // always-visible recorder window that owns getDisplayMedia directly.
      await chrome.runtime.sendMessage({ target: "background", type: "START_LEGACY_SCREEN_RECORDING", audio });
      maybeClose();
    }
  }
  void btn;
}

// ---------- Full-screen/window recording: getDisplayMedia + relay to the
// offscreen document so it survives this popup/panel closing. ----------

// A just-created offscreen document can have a brief window where sending it
// a message races its own script initialization — retry a couple of times.
async function sendToOffscreenWithRetry(message: Record<string, unknown>, attempts = 4): Promise<unknown> {
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

async function startScreenRecordingWithRelay(audio: boolean, btn: HTMLButtonElement): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ target: "background", type: "ENSURE_OFFSCREEN", audio });

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio,
    });

    // The draw tool needs to be available in every recording mode,
    // including screen mode — but background.ts has no reliable tabId of
    // its own there (the share picker can capture a different tab/window/
    // the entire screen), so this popup/side panel — the only place that
    // DOES know which tab it was open on — asks explicitly. Fire-and-
    // forget: a failure here (restricted page, tab gone) should never
    // block or fail the recording itself, only cost the draw tool.
    chrome.tabs.query({ active: true, currentWindow: true }).then(([activeTab]) => {
      if (activeTab?.id != null) {
        chrome.runtime.sendMessage({ target: "background", type: "INJECT_VIDEO_ANNOTATION_OVERLAY", tabId: activeTab.id }).catch(() => {});
      }
    }).catch(() => {});

    relayPC = new RTCPeerConnection();
    displayStream.getTracks().forEach((track) => relayPC!.addTrack(track, displayStream));

    // Relay the RAW mic track alongside the display stream's own
    // (tab/system) audio, rather than mixing them here. This popup is told
    // it can close as soon as the
    // connection reaches "connected" (see onconnectionstatechange below),
    // and an AudioContext (which real mixing would require) does not
    // survive that — only a raw hardware-backed track does, same as
    // displayStream's own tracks above. offscreen.ts does the actual
    // mixing once both tracks arrive there (see handleRelayOffer there).
    if (audio) {
      const micStream = await requestMicrophone();
      micStream?.getAudioTracks().forEach((track) => relayPC!.addTrack(track, micStream));
    }

    relayPC.onicecandidate = (event) => {
      if (event.candidate) {
        chrome.runtime
          .sendMessage({
            target: "offscreen",
            type: "RELAY_ICE",
            candidate: event.candidate,
          })
          .catch(() => {});
      }
    };

    relayPC.onconnectionstatechange = async () => {
      if (relayPC && relayPC.connectionState === "connected") {
        await chrome.runtime.sendMessage({ target: "background", type: "SCREEN_RECORDING_STARTED" });
        btn.dataset.connecting = "0";
        btn.disabled = false;
        el("videoHint").textContent = t("videoRecordingBg", lang);
      }
    };

    const offer = await relayPC.createOffer();
    await relayPC.setLocalDescription(offer);

    await sendToOffscreenWithRetry({
      type: "RELAY_OFFER",
      sdp: relayPC.localDescription,
      withAudio: audio,
    });

    // Stop our local copy of the display stream once relayed — the
    // offscreen document now holds its own reference via WebRTC.
    // (Tracks keep flowing to the peer connection until it closes.)
  } catch (e) {
    console.error(e);
    btn.dataset.connecting = "0";
    el("videoModeButtons").hidden = false;
    el("videoAudioRow").hidden = false;
    btn.hidden = true;
    if (relayPC) {
      relayPC.close();
      relayPC = null;
    }
  }
}

function wireRelayListeners(): void {
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message.target !== "popup" || !relayPC) return;
    if (message.type === "RELAY_ANSWER") {
      relayPC.setRemoteDescription(new RTCSessionDescription(message.sdp)).catch(console.error);
    } else if (message.type === "RELAY_ICE" && message.candidate) {
      relayPC.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(console.error);
    }
  });
}

// background.ts's setState() broadcasts this every time
// isRecording/isSaving/savingProgress/isSelectingArea (or anything else in
// RecordingState) actually changes, instead of relying on this surface to
// find out only on the next 1s poll tick (see the comment above the
// setInterval() call in init()). This is a separate listener from
// wireRelayListeners() above, which bails out early whenever `relayPC` is
// null — that would swallow this message on every surface that hasn't
// started a screen-mode relay connection (i.e. nearly always).
function wireStatePushListener(): void {
  chrome.runtime.onMessage.addListener((message: any) => {
    if (message.target === "popup" && message.type === "STATE_CHANGED") {
      refreshRecordingState();
    }
  });
}

function wireSettings(): void {
  el<HTMLSelectElement>("selTheme").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value as "light" | "dark" | "auto";
    await SettingsStore.set({ theme: value });
    applyTheme(value);
  });

  el<HTMLSelectElement>("selLang").addEventListener("change", async (e) => {
    // Typed as LangPref (not the narrower "en" | "ru" | "auto") to match the
    // full set of supported locales — the real string value is always used
    // as-is, so a narrower type here would just be misleading to read.
    const value = (e.target as HTMLSelectElement).value as LangPref;
    await SettingsStore.set({ lang: value });
    lang = resolveLang(value);
    applyI18n(document, lang);
    applyDirection(lang);
    const { lastMode } = await SettingsStore.get();
    updateVideoHint((["tab", "area", "screen"] as const).includes(lastMode as VideoMode) ? (lastMode as VideoMode) : "area");
    await refreshRecordingState();
  });

  el<HTMLSelectElement>("selVideoQuality").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value as "auto" | "low" | "medium" | "high";
    await SettingsStore.set({ videoQuality: value });
  });

  el<HTMLSelectElement>("selVideoFormat").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value as "webm" | "mp4";
    await SettingsStore.set({ videoFormat: value });
  });

  el<HTMLSelectElement>("selScreenshotFormat").addEventListener("change", async (e) => {
    const value = (e.target as HTMLSelectElement).value as "png" | "webp";
    await SettingsStore.set({ screenshotFormat: value });
  });

  el("btnOpenShortcuts").addEventListener("click", () => {
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
    const url = isFirefox ? "about:addons" : "chrome://extensions/shortcuts";
    chrome.tabs.create({ url });
  });

  document.getElementById("chkAutoClipboard")?.addEventListener("change", async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    await SettingsStore.set({ autoClipboard: checked });
    updateManualCopyVisibility(checked);
  });

  document.getElementById("chkScreenshotDrawTool")?.addEventListener("change", async (e) => {
    await SettingsStore.set({ screenshotDrawToolEnabled: (e.target as HTMLInputElement).checked });
  });
  document.getElementById("chkVideoDrawTool")?.addEventListener("change", async (e) => {
    await SettingsStore.set({ videoDrawToolEnabled: (e.target as HTMLInputElement).checked });
  });

  el("btnOpenLog").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
  });
}

init();
