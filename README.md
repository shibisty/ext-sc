# ScreenRec Toolkit

A Chrome and Firefox extension for screen recording and screenshots, with a
built-in annotation editor, a side panel, hotkeys, light/dark themes, and
English/Russian localization.

[![Patreon](https://c5.patreon.com/external/logo/become_a_patron_button.png)](https://www.patreon.com/cw/shibisty)

## Features

**Screenshots**
- Visible area, a user-selected area, or the full scrollable page (captured
  and stitched together automatically).
- Saved as PNG (lossless) or WebP (smaller file size), configurable in
  Settings.
- Optional auto-copy to the clipboard, or a manual "copy last screenshot"
  button.

**Video recording**
- **This tab** — starts instantly with no browser picker dialog; recording
  keeps running even if the popup or side panel is closed.
- **Selected area of a tab** — same as above, cropped to a rectangle you
  draw on the page.
- **Full screen / another window** — uses the browser's native
  screen-sharing dialog (required by the platform; there's no way around
  it for capturing outside the current tab).
- Audio is recorded together with video where the source provides it.
- Video quality (bitrate) is configurable: Auto / Low / Medium / High.
- Output format is WebM by default (broadest codec support); MP4 is
  offered where the browser can record it directly, otherwise it falls
  back to WebM automatically.
- Area recordings scale their frame rate to the capture resolution
  automatically, so a small selection records at a higher frame rate and a
  large one (up to native 4K) trades frame rate for full pixel density
  instead of being downscaled.

**Annotation editor**
Opens automatically for area screenshots and is available as an overlay
during area/tab video recording:
- Brush (adjustable width, opacity, and edge blur), text (font size and
  weight), and image/GIF layers — drag-and-drop or paste an image, or add
  one from the built-in GIF/sticker library (animated GIF/WebP layers
  animate live, including inside recorded video).
- Every stroke, text box, and image is an independent, re-editable layer:
  a **Select** tool lets you move, resize, rotate, and delete layers at
  any time, individually or in a multi-selection (`Ctrl`/`Shift`+click, or
  `Delete`/`Backspace` to remove).
- Brush and font settings persist between sessions.

**Side panel**
Mirrors the popup's controls in Chrome's side panel / Firefox's sidebar,
useful for keeping the UI open alongside the page while recording.

**Hotkeys** (configurable at `chrome://extensions/shortcuts`)
- `Ctrl+Shift+R` — start/stop recording
- `Ctrl+Shift+S` — screenshot of the visible area
- `Ctrl+Shift+A` — screenshot of a selected area

**Other**
- Light / dark / auto theme, English / Russian / auto language.
- A save log (last 10 screenshots/recordings) with filename, type, mode,
  and timestamp, plus "show in folder" / "open" actions.
- All files are saved to the downloads folder, under a `ScreenRec/`
  subfolder.

## Install

Build first (see below) — installation is done from `dist/chrome/` or
`dist/firefox/`, not from the source tree.

### Chrome / Edge / Brave
1. Go to `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `dist/chrome/` folder.

### Firefox
1. Go to `about:debugging#/runtime/this-firefox` → **Load Temporary
   Add-on…** and select `manifest.json` inside `dist/firefox/`.
2. Firefox has no `chrome.offscreen`/`chrome.tabCapture`, so all recording
   modes there use a fallback path (a dedicated recording window; area
   mode stitches periodic tab screenshots together in-page instead of
   using `captureStream()` on a hidden canvas). A permanent install
   requires signing through AMO — use
   `dist/screenrec-toolkit-firefox.zip` for that.

## Build

```sh
npm install     # installs TypeScript (the only dependency)
npm run build   # tsc -> dist/chrome/ and dist/firefox/, plus a .zip of each
```

(`build.bat` on Windows, `build.sh` on macOS/Linux — both just call
`node scripts/build.mjs`.)

Other useful commands:

```sh
npm run typecheck          # tsc --noEmit
npm test                   # unit tests (compiles src/lib via tsc first)
npm run gen-gif-manifest   # regenerate gif-library/index.json by hand
```

## Usage

- **Screenshot / recording of a selected area**: the page dims outside the
  area you drag out; confirm with **✓ Use area** (or Enter), or cancel
  with **✕ Cancel** (or Esc).
- **"This tab" / "Selected area" recording**: click **Start recording** —
  no dialog, recording starts immediately and survives closing the popup
  or side panel. Stop it with the **Stop recording** button, the
  `Ctrl+Shift+R` hotkey, or the browser's own "Stop sharing" control.
- **"Full screen / another window" recording**: the browser asks what to
  share — pick a screen or window. After a couple of seconds the status
  changes to "Recording in background — you can close this"; the popup or
  panel can then be closed without stopping the recording.

## Project structure

Source is TypeScript (`src/`); the build produces ready-to-load extensions
in `dist/`. See `ARCHITECTURE.md` for a full component breakdown, the
message-passing design, and the reasoning behind the less obvious
decisions.

```
manifest.json                — Chrome manifest (MV3)
manifest.firefox.json        — Firefox manifest (MV3, sidebar_action)

src/
  background.ts               — service worker: hotkeys, screenshots, recording orchestration
  offscreen.ts                — background recording engine (Chrome; survives popup/panel closing)
  frame-stitch-recorder.ts    — Firefox-only area-recording fallback (stitches injected tab screenshots)
  select-overlay.ts           — area-selection overlay (content script, no import/export)
  annotate-overlay.ts         — drawing/text overlay shown over the captured area (same constraint)
  recorder.ts                 — fallback recording window (Firefox / no offscreen API)
  app.ts                       — shared popup + side panel logic
  i18n.ts                      — translation strings and settings storage
  log.ts                        — save-log page (last 10 entries)
  save-helper.ts               — hidden helper page that finalizes video downloads
  shim.ts                       — chrome = browser (cross-browser compatibility)
  types/                        — hand-written types for the chrome.* APIs used (no @types/chrome)
  lib/                           — shared logic with its own unit tests
    blob-db.ts, video-format.ts, timestamp.ts, restricted-url.ts, rect.ts, gif-usage.ts, audio-mix.ts

public/                       — static assets, copied into dist/ as-is
  popup.html, sidepanel.html, offscreen.html, recorder.html,
  save-helper.html, log.html, app.css, sidepanel.css, theme.css
  gif-library/                — GIF/WebP stickers (index.json is generated at build time, not hand-edited)
  _locales/en, _locales/ru    — localized strings for the extension's own name/description/commands
  icons/                       — extension icons

scripts/
  build.mjs                   — tsc -> copy static assets -> gif manifest -> per-browser manifest -> zip
  gen-gif-manifest.mjs        — scans gif-library/ and writes index.json

tests/                        — node:test unit tests for src/lib and gen-gif-manifest.mjs

dist/                         — build output (not committed)
  chrome/, firefox/           — unpacked extensions, ready to load into a browser
  screenrec-toolkit-chrome.zip, screenrec-toolkit-firefox.zip
```

## Known limitations

- The "share your screen" dialog is a standard browser API and can't be
  skipped for arbitrary screen/window capture; recording the current tab
  (`chrome.tabCapture`) needs no such dialog.
- Full-page screenshots scroll-and-stitch the page; sites with sticky
  headers/footers can end up duplicated in the final image.
- Video is recorded as WebM (VP9/VP8 + Opus); convert to MP4 with an
  external tool if you need that format specifically.
- Firefox doesn't implement `chrome.offscreen` or `chrome.tabCapture` yet,
  so recording there always goes through the fallback paths described
  above. A permanent install requires AMO signing.

[![Patreon](https://c5.patreon.com/external/logo/become_a_patron_button.png)](https://www.patreon.com/cw/shibisty)

If this project helps you, consider supporting its development on Patreon ❤️
