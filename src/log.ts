// Reads the persistent activity log (chrome.storage.local) written by
// background.ts every time a screenshot or recording is saved. Before
// rendering, each entry is checked against chrome.downloads.search() —
// entries whose file is gone (or whose download record no longer exists)
// are silently dropped, both from the view and from storage.

import { resolveLang, applyI18n, applyTheme, applyDirection, t, SettingsStore, type Lang, type StringKey } from "./i18n.js";

const ACTIVITY_LOG_KEY = "activityLog";

type RecordingMode = "visible" | "area" | "fullpage" | "tab" | "screen";

interface ActivityLogEntry {
  type: "video" | "screenshot";
  mode?: RecordingMode;
  filename: string;
  timestamp: number;
  downloadId?: number;
}

function formatDate(ts: number, lang: Lang): string {
  const d = new Date(ts);
  return d.toLocaleString(lang === "ru" ? "ru-RU" : "en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const MODE_LABEL_KEYS: Partial<Record<RecordingMode, StringKey>> = {
  visible: "logModeVisible",
  area: "logModeArea",
  fullpage: "logModeFullpage",
  tab: "logModeTab",
  screen: "logModeScreen",
};

function modeLabel(entry: ActivityLogEntry, lang: Lang): string {
  const key = entry.mode ? MODE_LABEL_KEYS[entry.mode] : undefined;
  return key ? t(key, lang) : "";
}

function baseName(filename: string): string {
  return filename.split("/").pop() as string;
}

async function checkExists(entry: ActivityLogEntry): Promise<boolean> {
  if (entry.downloadId == null) return false;
  try {
    const results = await chrome.downloads.search({ id: entry.downloadId });
    if (!results || results.length === 0) return false;
    const item = results[0];
    if (item.state === "interrupted") return false;
    if (item.exists === false) return false;
    return true;
  } catch {
    return false;
  }
}

async function loadAndRender(): Promise<void> {
  const settings = await SettingsStore.get();
  const lang = resolveLang(settings.lang);
  applyI18n(document, lang);
  applyDirection(lang);
  applyTheme(settings.theme);

  const { [ACTIVITY_LOG_KEY]: entries = [] } = await chrome.storage.local.get<{
    [ACTIVITY_LOG_KEY]: ActivityLogEntry[];
  }>([ACTIVITY_LOG_KEY]);

  const checks = await Promise.all(entries.map((e) => checkExists(e)));
  const alive = entries.filter((_, i) => checks[i]);

  // Prune stale entries so the stored log stays clean over time.
  if (alive.length !== entries.length) {
    await chrome.storage.local.set({ [ACTIVITY_LOG_KEY]: alive });
  }

  const list = document.getElementById("list") as HTMLElement;
  const emptyState = document.getElementById("emptyState") as HTMLElement;
  list.innerHTML = "";

  if (alive.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const canOpen = !!(chrome.downloads && chrome.downloads.open);

  for (const entry of alive) {
    const row = document.createElement("div");
    row.className = "entry";

    const icon = document.createElement("div");
    icon.className = "entry-icon";
    icon.textContent = entry.type === "video" ? "🎬" : "📷";

    const main = document.createElement("div");
    main.className = "entry-main";
    const fname = document.createElement("div");
    fname.className = "entry-filename";
    fname.textContent = baseName(entry.filename);
    const meta = document.createElement("div");
    meta.className = "entry-meta";
    const typeLabel = t(entry.type === "video" ? "logTypeVideo" : "logTypeScreenshot", lang);
    const parts = [typeLabel, modeLabel(entry, lang), formatDate(entry.timestamp, lang)].filter(Boolean);
    meta.textContent = parts.join(" · ");
    main.appendChild(fname);
    main.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "entry-actions";

    const showBtn = document.createElement("button");
    showBtn.textContent = t("logShowInFolder", lang);
    showBtn.addEventListener("click", () => chrome.downloads.show(entry.downloadId as number));
    actions.appendChild(showBtn);

    if (canOpen) {
      const openBtn = document.createElement("button");
      openBtn.textContent = t("logOpenFile", lang);
      openBtn.addEventListener("click", () => chrome.downloads.open(entry.downloadId as number));
      actions.appendChild(openBtn);
    }

    row.appendChild(icon);
    row.appendChild(main);
    row.appendChild(actions);
    list.appendChild(row);
  }
}

document.getElementById("btnBack")!.addEventListener("click", () => {
  window.close();
});

loadAndRender();
