// Shared UI localization (independent from browser locale) + theme helper.
// Supports "auto" (follow browser language / OS color scheme), "en", "ru".

const STRINGS = {
  en: {
    appTitle: "ScreenRec Toolkit",
    tabScreenshot: "Screenshot",
    tabVideo: "Video",
    tabSettings: "Settings",

    screenshotVisible: "Capture visible area",
    screenshotArea: "Select area & capture",
    screenshotFullPage: "Capture full page (scroll)",
    screenshotHint: "PNG will be saved to your Downloads folder.",

    videoIncludeAudio: "Include audio (mic/tab/system)",
    videoModeTab: "This tab (fast, works in background)",
    videoModeArea: "Selected area of this tab",
    videoModeScreen: "Entire screen / another window",
    videoStart: "Start recording",
    videoStop: "Stop recording",
    videoSaving: "Saving…",
    videoRecording: "Recording…",
    videoRecordingBg: "Recording in background — you can close this",
    videoHintTab: "Records this tab directly — no picker dialog, keeps recording even if you close this panel.",
    videoHintArea: "Drag to select a region on the page first, then recording starts automatically in the background.",
    videoHintScreen: "The browser will ask what to share. Keep this window/panel open for a moment while it connects, then you can close it.",
    videoSelectAreaFirst: "1. Select area",
    videoAreaSelected: "Area selected ✓",
    videoAreaNotSelected: "No area selected yet",
    openSidePanel: "Open as side panel",
    sidePanelHint: "The side panel stays open next to the page — handy for keeping an eye on a running recording.",

    settingsTheme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeAuto: "Auto (system)",
    settingsLanguage: "Language",
    langAuto: "Auto (browser)",
    langEn: "English",
    langRu: "Русский",
    settingsHotkeys: "Hotkeys",
    hotkeysHint: "Manage or change shortcuts in your browser's extension settings:",
    hotkeysToggleRecording: "Start/stop recording",
    hotkeysCaptureFull: "Screenshot (visible area)",
    hotkeysCaptureArea: "Screenshot (select area)",
    openShortcutsPage: "Open shortcuts settings",

    settingsClipboard: "Clipboard",
    autoClipboardLabel: "Automatically copy screenshots to clipboard",
    autoClipboardHint: "When off, use the button below to copy the last screenshot manually.",
    copyLastScreenshot: "Copy last screenshot to clipboard",
    copyLastScreenshotNone: "No screenshot taken yet this session",
    copyLastScreenshotDone: "Copied to clipboard ✓",

    settingsLog: "Activity log",
    openActivityLog: "Open save log",
    activityLogHint: "See where your last screenshots and recordings were saved.",

    settingsVideoQuality: "Video quality",
    videoQualityAuto: "Auto (browser default)",
    videoQualityLow: "Low (smaller file)",
    videoQualityMedium: "Medium",
    videoQualityHigh: "High (larger file)",
    videoQualityHint: "Affects new recordings only, in all modes.",

    settingsVideoFormat: "Video format",
    videoFormatWebm: "WebM (best compatibility)",
    videoFormatMp4: "MP4 (falls back to WebM if unsupported)",
    settingsScreenshotFormat: "Screenshot format",
    screenshotFormatPng: "PNG (lossless)",
    screenshotFormatWebp: "WebP (smaller file)",

    logPageTitle: "Save log",
    logPageSubtitle: "Your last 10 screenshots and recordings. Entries whose file no longer exists are hidden automatically.",
    logEmpty: "Nothing saved yet.",
    logTypeScreenshot: "Screenshot",
    logTypeVideo: "Video",
    logModeVisible: "Visible area",
    logModeArea: "Selected area",
    logModeFullpage: "Full page",
    logModeTab: "This tab",
    logModeScreen: "Screen/window",
    logShowInFolder: "Show in folder",
    logOpenFile: "Open",
    logBack: "Back",

    notifScreenshotSavedTitle: "Screenshot saved",
    notifScreenshotSavedMsg: "Your screenshot was downloaded.",
    notifRecordingSavedTitle: "Recording saved",
    notifRecordingSavedMsg: "Your video was downloaded.",
    notifErrorTitle: "Something went wrong",
    notifErrorRestricted: "Not possible on browser system pages. Switch to a regular website tab.",
    notifSelectAreaTitle: "Select an area",
    notifSelectAreaMsg: "Drag on the page to select the region.",

    overlayHint: "Drag to select an area. Press Esc to cancel, Enter to confirm.",
    overlaySize: "Size",

    recorderTitle: "Recording…",
    recorderPreparing: "Preparing capture…",
    recorderPickPrompt: "Choose what to share in the browser dialog.",
    recorderStopBtn: "Stop & Save",
    recorderCancelBtn: "Cancel",
    recorderTimeLabel: "Elapsed",
    recorderErrorPermission: "Screen sharing was cancelled or denied.",
    recorderDone: "Saved! You can close this window.",
    goToRecordingTab: "Go to tab",
    recordingTabPrefix: "Recording:",
  },
  ru: {
    appTitle: "ScreenRec Toolkit",
    tabScreenshot: "Скриншот",
    tabVideo: "Видео",
    tabSettings: "Настройки",

    screenshotVisible: "Снять видимую область",
    screenshotArea: "Выбрать область и снять",
    screenshotFullPage: "Снять всю страницу (со скроллом)",
    screenshotHint: "PNG-файл будет сохранён в папку загрузок.",

    videoIncludeAudio: "Записывать звук (микрофон/вкладка/система)",
    videoModeTab: "Эту вкладку (быстро, работает в фоне)",
    videoModeArea: "Выбранную область этой вкладки",
    videoModeScreen: "Весь экран / другое окно",
    videoStart: "Начать запись",
    videoStop: "Остановить запись",
    videoSaving: "Сохранение…",
    videoRecording: "Идёт запись…",
    videoRecordingBg: "Запись идёт в фоне — можно закрыть это окно",
    videoHintTab: "Записывает эту вкладку напрямую — без диалога выбора, запись продолжится, даже если закрыть панель.",
    videoHintArea: "Сначала выделите область на странице — запись начнётся автоматически в фоне.",
    videoHintScreen: "Браузер спросит, что демонстрировать. Не закрывайте окно/панель, пока идёт подключение — после можно закрыть.",
    videoSelectAreaFirst: "1. Выделить область",
    videoAreaSelected: "Область выбрана ✓",
    videoAreaNotSelected: "Область ещё не выбрана",
    openSidePanel: "Открыть как боковую панель",
    sidePanelHint: "Боковая панель остаётся открытой рядом со страницей — удобно следить за идущей записью.",

    settingsTheme: "Тема",
    themeLight: "Светлая",
    themeDark: "Тёмная",
    themeAuto: "Авто (как в системе)",
    settingsLanguage: "Язык",
    langAuto: "Авто (как в браузере)",
    langEn: "English",
    langRu: "Русский",
    settingsHotkeys: "Горячие клавиши",
    hotkeysHint: "Настроить или изменить сочетания клавиш можно в настройках расширений браузера:",
    hotkeysToggleRecording: "Начать/остановить запись",
    hotkeysCaptureFull: "Скриншот (видимая область)",
    hotkeysCaptureArea: "Скриншот (выбор области)",
    openShortcutsPage: "Открыть настройки горячих клавиш",

    settingsClipboard: "Буфер обмена",
    autoClipboardLabel: "Автоматически копировать скриншоты в буфер обмена",
    autoClipboardHint: "Если выключено, используйте кнопку ниже, чтобы скопировать последний скриншот вручную.",
    copyLastScreenshot: "Скопировать последний скриншот в буфер",
    copyLastScreenshotNone: "В этой сессии скриншотов ещё не было",
    copyLastScreenshotDone: "Скопировано в буфер ✓",

    settingsLog: "Журнал сохранений",
    openActivityLog: "Открыть журнал",
    activityLogHint: "Посмотреть, куда сохранились последние скриншоты и записи.",

    settingsVideoQuality: "Качество видео",
    videoQualityAuto: "Авто (по умолчанию браузера)",
    videoQualityLow: "Низкое (меньше размер файла)",
    videoQualityMedium: "Среднее",
    videoQualityHigh: "Высокое (больше размер файла)",
    videoQualityHint: "Влияет только на новые записи, во всех режимах.",

    settingsVideoFormat: "Формат видео",
    videoFormatWebm: "WebM (лучшая совместимость)",
    videoFormatMp4: "MP4 (если не поддерживается — откат на WebM)",
    settingsScreenshotFormat: "Формат скриншотов",
    screenshotFormatPng: "PNG (без потерь)",
    screenshotFormatWebp: "WebP (меньше размер файла)",

    logPageTitle: "Журнал сохранений",
    logPageSubtitle: "Последние 10 скриншотов и записей. Записи, файлы которых больше не существуют, скрываются автоматически.",
    logEmpty: "Пока ничего не сохранено.",
    logTypeScreenshot: "Скриншот",
    logTypeVideo: "Видео",
    logModeVisible: "Видимая область",
    logModeArea: "Выбранная область",
    logModeFullpage: "Вся страница",
    logModeTab: "Эта вкладка",
    logModeScreen: "Экран/окно",
    logShowInFolder: "Показать в папке",
    logOpenFile: "Открыть",
    logBack: "Назад",

    notifScreenshotSavedTitle: "Скриншот сохранён",
    notifScreenshotSavedMsg: "Скриншот загружен в папку загрузок.",
    notifRecordingSavedTitle: "Запись сохранена",
    notifRecordingSavedMsg: "Видео загружено в папку загрузок.",
    notifErrorTitle: "Что-то пошло не так",
    notifErrorRestricted: "Невозможно на служебных страницах браузера. Переключитесь на обычную вкладку сайта.",
    notifSelectAreaTitle: "Выделите область",
    notifSelectAreaMsg: "Выделите нужный регион на странице.",

    overlayHint: "Выделите область мышью. Esc — отмена, Enter — подтвердить.",
    overlaySize: "Размер",

    recorderTitle: "Идёт запись…",
    recorderPreparing: "Подготовка захвата…",
    recorderPickPrompt: "Выберите, что демонстрировать, в диалоге браузера.",
    recorderStopBtn: "Остановить и сохранить",
    recorderCancelBtn: "Отмена",
    recorderTimeLabel: "Прошло",
    recorderErrorPermission: "Доступ к демонстрации экрана отменён или отклонён.",
    recorderDone: "Сохранено! Это окно можно закрыть.",
    goToRecordingTab: "Перейти к вкладке",
    recordingTabPrefix: "Запись:",
  }
};

function resolveLang(pref) {
  if (pref === "en" || pref === "ru") return pref;
  // auto: follow browser UI language, fallback to English
  const uiLang = (chrome.i18n && chrome.i18n.getUILanguage) ? chrome.i18n.getUILanguage() : navigator.language;
  return (uiLang || "").toLowerCase().startsWith("ru") ? "ru" : "en";
}

function t(key, lang) {
  const dict = STRINGS[lang] || STRINGS.en;
  return dict[key] || STRINGS.en[key] || key;
}

// Applies translations to any element with data-i18n / data-i18n-title attributes.
function applyI18n(root, lang) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"), lang);
  });
  scope.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.getAttribute("data-i18n-title"), lang);
  });
}

function resolveTheme(pref) {
  if (pref === "light" || pref === "dark") return pref;
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  return prefersDark ? "dark" : "light";
}

function applyTheme(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

// Small settings store shared by all extension pages.
const SettingsStore = {
  async get() {
    const {
      theme = "auto", lang = "auto", lastMode = "full", lastAudio = true,
      autoClipboard = true, videoQuality = "auto", lastUiTab = "screenshot",
      videoFormat = "webm", screenshotFormat = "png"
    } = await chrome.storage.local.get([
      "theme", "lang", "lastMode", "lastAudio", "autoClipboard", "videoQuality",
      "lastUiTab", "videoFormat", "screenshotFormat"
    ]);
    return { theme, lang, lastMode, lastAudio, autoClipboard, videoQuality, lastUiTab, videoFormat, screenshotFormat };
  },
  async set(partial) {
    await chrome.storage.local.set(partial);
  }
};
