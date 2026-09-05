// Shared logic for popup.html and sidepanel.html. `<html data-surface="...">`
// (set in each HTML file, no inline script needed for MV3 CSP) controls
// whether the surface auto-closes after triggering an action — the side
// panel stays open on purpose.

const IS_SIDE_PANEL = document.documentElement.dataset.surface === "sidepanel";

let lang = "en";
let relayPC = null;
let timerHandle = null;
let capabilities = { hasOffscreen: true, hasTabCapture: true };

async function init() {
  const settings = await SettingsStore.get();
  lang = resolveLang(settings.lang);
  applyI18n(document, lang);
  applyTheme(settings.theme);

  document.getElementById("selTheme").value = settings.theme;
  document.getElementById("selLang").value = settings.lang;
  document.getElementById("selVideoQuality").value = settings.videoQuality;
  document.getElementById("selVideoFormat").value = settings.videoFormat;
  document.getElementById("selScreenshotFormat").value = settings.screenshotFormat;

  document.getElementById("chkAudio").checked = settings.lastAudio;
  updateVideoHint(["tab", "area", "screen"].includes(settings.lastMode) ? settings.lastMode : "area");

  const validUiTabs = ["screenshot", "video", "settings"];
  activateUiTab(validUiTabs.includes(settings.lastUiTab) ? settings.lastUiTab : "screenshot");

  const autoClipboardChk = document.getElementById("chkAutoClipboard");
  if (autoClipboardChk) autoClipboardChk.checked = settings.autoClipboard;
  updateManualCopyVisibility(settings.autoClipboard);

  if (IS_SIDE_PANEL) {
    document.getElementById("btnOpenSidePanel")?.remove();
  }

  try {
    const state = await chrome.runtime.sendMessage({ target: "background", type: "GET_STATE" });
    capabilities = { hasOffscreen: !!state.hasOffscreen, hasTabCapture: !!state.hasTabCapture };
  } catch (e) { /* keep defaults */ }

  if (!capabilities.hasOffscreen) {
    document.getElementById("chkAutoClipboard")?.closest(".setting-block")?.remove();
    document.getElementById("btnCopyLastScreenshot")?.remove();
  }

  await refreshRecordingState();
  wireTabs();
  wireActions();
  wireSettings();
  wireRelayListeners();
  await loadShortcuts();

  timerHandle = setInterval(refreshRecordingState, 1000);
  window.addEventListener("pagehide", () => clearInterval(timerHandle));
}

function formatElapsed(startedAt) {
  if (!startedAt) return "00:00";
  const totalSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

async function refreshRecordingState() {
  try {
    const state = await chrome.runtime.sendMessage({ target: "background", type: "GET_STATE" });
    const indicator = document.getElementById("recIndicator");
    const timeEl = document.getElementById("recTime");
    const gotoBtn = document.getElementById("btnGotoTab");
    indicator.hidden = !state.isRecording;
    if (state.isRecording) timeEl.textContent = formatElapsed(state.recordingStartedAt);

    if (state.isRecording && state.recordingTabId != null) {
      gotoBtn.hidden = false;
      const label = t("goToRecordingTab", lang) + (state.recordingTabTitle ? `: ${state.recordingTabTitle}` : "");
      gotoBtn.title = label;
    } else {
      gotoBtn.hidden = true;
    }

    const modeButtons = document.getElementById("videoModeButtons");
    const audioRow = document.getElementById("videoAudioRow");
    const stopBtn = document.getElementById("btnStopVideo");
    const stopLabel = stopBtn.querySelector("span:last-child");
    const stopIcon = stopBtn.querySelector("span.icon");
    const connecting = stopBtn.dataset.connecting === "1";

    if (state.isSaving) {
      modeButtons.hidden = true;
      audioRow.hidden = true;
      stopBtn.hidden = false;
      stopBtn.disabled = true;
      stopBtn.classList.add("saving");
      stopIcon.textContent = "⏳";
      stopLabel.textContent = t("videoSaving", lang);
    } else if (state.isRecording || connecting) {
      modeButtons.hidden = true;
      audioRow.hidden = true;
      stopBtn.hidden = false;
      stopBtn.classList.remove("saving");
      stopIcon.textContent = "⏹";
      if (!connecting) {
        stopBtn.disabled = false;
        stopLabel.textContent = t("videoStop", lang);
      }
    } else {
      modeButtons.hidden = false;
      audioRow.hidden = false;
      stopBtn.hidden = true;
      stopBtn.classList.remove("saving");
    }
  } catch (e) {
    // background not ready yet; ignore
  }
}

async function loadShortcuts() {
  if (!chrome.commands || !chrome.commands.getAll) return;
  const commands = await chrome.commands.getAll();
  const map = { "toggle-recording": "kbdToggle", "capture-full-screenshot": "kbdFull", "capture-area-screenshot": "kbdArea" };
  commands.forEach((c) => {
    const elId = map[c.name];
    if (elId && document.getElementById(elId)) {
      document.getElementById(elId).textContent = c.shortcut || "—";
    }
  });
}

function activateUiTab(tabName) {
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  const panel = document.getElementById(`panel-${tabName}`);
  if (!btn || !panel) return;
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
  panel.classList.add("active");
}

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activateUiTab(btn.dataset.tab);
      SettingsStore.set({ lastUiTab: btn.dataset.tab });
    });
  });
}

function updateVideoHint(mode) {
  const hintEl = document.getElementById("videoHint");
  const key = mode === "screen" ? "videoHintScreen" : mode === "area" ? "videoHintArea" : "videoHintTab";
  hintEl.textContent = t(key, lang);
}

function updateManualCopyVisibility(autoClipboard) {
  const btn = document.getElementById("btnCopyLastScreenshot");
  if (btn) btn.hidden = !!autoClipboard;
}

function maybeClose() {
  if (!IS_SIDE_PANEL) window.close();
}

function wireActions() {
  document.getElementById("btnCaptureVisible").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_VISIBLE" });
    maybeClose();
  });

  document.getElementById("btnCaptureArea").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_AREA_SCREENSHOT" });
    maybeClose();
  });

  document.getElementById("btnCaptureFullPage").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "CAPTURE_FULLPAGE" });
    maybeClose();
  });

  document.getElementById("btnCopyLastScreenshot")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const label = btn.querySelector("span:last-child");
    const original = label.textContent;
    const res = await chrome.runtime.sendMessage({ target: "background", type: "COPY_LAST_SCREENSHOT" });
    if (res && res.ok) {
      label.textContent = t("copyLastScreenshotDone", lang);
    } else {
      label.textContent = t("copyLastScreenshotNone", lang);
    }
    setTimeout(() => { label.textContent = original; }, 1800);
  });

  document.querySelectorAll("#videoModeButtons .action-btn").forEach((btn) => {
    btn.addEventListener("mouseenter", () => updateVideoHint(btn.dataset.mode));
    btn.addEventListener("focus", () => updateVideoHint(btn.dataset.mode));
    btn.addEventListener("click", () => startVideoRecording(btn.dataset.mode, btn));
  });

  document.getElementById("btnStopVideo").addEventListener("click", async (e) => {
    e.currentTarget.disabled = true;
    await chrome.runtime.sendMessage({ target: "background", type: "STOP_RECORDING_REQUEST" });
    await refreshRecordingState();
  });

  document.getElementById("btnGotoTab").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ target: "background", type: "FOCUS_RECORDING_TAB" });
  });

  document.getElementById("btnOpenSidePanel")?.addEventListener("click", async () => {
    const win = await chrome.windows.getCurrent();
    if (chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
    window.close();
  });
}

async function startVideoRecording(mode, btn) {
  const audio = document.getElementById("chkAudio").checked;
  await SettingsStore.set({ lastMode: mode, lastAudio: audio });

  if (mode === "tab") {
    await chrome.runtime.sendMessage({ target: "background", type: "START_TAB_RECORDING", audio });
    maybeClose();
  } else if (mode === "area") {
    await chrome.runtime.sendMessage({ target: "background", type: "START_RECORDING_AREA_SELECT", audio });
    maybeClose();
  } else if (mode === "screen") {
    if (capabilities.hasOffscreen) {
      const stopBtn = document.getElementById("btnStopVideo");
      stopBtn.dataset.connecting = "1";
      stopBtn.disabled = true;
      document.getElementById("videoModeButtons").hidden = true;
      document.getElementById("videoAudioRow").hidden = true;
      stopBtn.hidden = false;
      await startScreenRecordingWithRelay(audio, stopBtn);
    } else {
      // No offscreen document support (e.g. Firefox): fall back to a small
      // always-visible recorder window that owns getDisplayMedia directly.
      await chrome.runtime.sendMessage({ target: "background", type: "START_LEGACY_SCREEN_RECORDING", audio });
      maybeClose();
    }
  }
}

// ---------- Full-screen/window recording: getDisplayMedia + relay to the
// offscreen document so it survives this popup/panel closing. ----------

// A just-created offscreen document can have a brief window where sending it
// a message races its own script initialization — retry a couple of times.
async function sendToOffscreenWithRetry(message, attempts = 4) {
  let lastErr = null;
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

async function startScreenRecordingWithRelay(audio, btn) {
  try {
    await chrome.runtime.sendMessage({ target: "background", type: "ENSURE_OFFSCREEN", audio });

    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 60 },
      audio
    });

    relayPC = new RTCPeerConnection();
    displayStream.getTracks().forEach((track) => relayPC.addTrack(track, displayStream));

    relayPC.onicecandidate = (event) => {
      if (event.candidate) {
        chrome.runtime.sendMessage({
          target: "offscreen",
          type: "RELAY_ICE",
          candidate: event.candidate
        }).catch(() => {});
      }
    };

    relayPC.onconnectionstatechange = async () => {
      if (relayPC && relayPC.connectionState === "connected") {
        await chrome.runtime.sendMessage({ target: "background", type: "SCREEN_RECORDING_STARTED" });
        btn.dataset.connecting = "0";
        btn.disabled = false;
        document.getElementById("videoHint").textContent = t("videoRecordingBg", lang);
      }
    };

    const offer = await relayPC.createOffer();
    await relayPC.setLocalDescription(offer);

    await sendToOffscreenWithRetry({
      type: "RELAY_OFFER",
      sdp: relayPC.localDescription,
      withAudio: audio
    });

    // Stop our local copy of the display stream once relayed — the
    // offscreen document now holds its own reference via WebRTC.
    // (Tracks keep flowing to the peer connection until it closes.)
  } catch (e) {
    console.error(e);
    btn.dataset.connecting = "0";
    document.getElementById("videoModeButtons").hidden = false;
    document.getElementById("videoAudioRow").hidden = false;
    btn.hidden = true;
    if (relayPC) { relayPC.close(); relayPC = null; }
  }
}

function wireRelayListeners() {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.target !== "popup" || !relayPC) return;
    if (message.type === "RELAY_ANSWER") {
      relayPC.setRemoteDescription(new RTCSessionDescription(message.sdp)).catch(console.error);
    } else if (message.type === "RELAY_ICE" && message.candidate) {
      relayPC.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(console.error);
    }
  });
}

function wireSettings() {
  document.getElementById("selTheme").addEventListener("change", async (e) => {
    await SettingsStore.set({ theme: e.target.value });
    applyTheme(e.target.value);
  });

  document.getElementById("selLang").addEventListener("change", async (e) => {
    await SettingsStore.set({ lang: e.target.value });
    lang = resolveLang(e.target.value);
    applyI18n(document, lang);
    const { lastMode } = await SettingsStore.get();
    updateVideoHint(["tab", "area", "screen"].includes(lastMode) ? lastMode : "area");
    await refreshRecordingState();
  });

  document.getElementById("selVideoQuality").addEventListener("change", async (e) => {
    await SettingsStore.set({ videoQuality: e.target.value });
  });

  document.getElementById("selVideoFormat").addEventListener("change", async (e) => {
    await SettingsStore.set({ videoFormat: e.target.value });
  });

  document.getElementById("selScreenshotFormat").addEventListener("change", async (e) => {
    await SettingsStore.set({ screenshotFormat: e.target.value });
  });

  document.getElementById("btnOpenShortcuts").addEventListener("click", () => {
    const isFirefox = typeof browser !== "undefined" && navigator.userAgent.includes("Firefox");
    const url = isFirefox ? "about:addons" : "chrome://extensions/shortcuts";
    chrome.tabs.create({ url });
  });

  document.getElementById("chkAutoClipboard")?.addEventListener("change", async (e) => {
    await SettingsStore.set({ autoClipboard: e.target.checked });
    updateManualCopyVisibility(e.target.checked);
  });

  document.getElementById("btnOpenLog").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("log.html") });
  });
}

init();
