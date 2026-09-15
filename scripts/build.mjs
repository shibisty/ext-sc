#!/usr/bin/env node
// Builds dist/chrome and dist/firefox from src/ (via tsc), public/ (static
// assets) and the two per-browser manifest files, then zips each folder.
//
// Steps:
//   1. Compile src/**/*.ts -> build/ts/**/*.js (tsc; see tsconfig.json for
//      why some of those compile as classic scripts and others as ES
//      modules).
//   2. Copy public/ (HTML/CSS/icons/_locales/gif images — everything except
//      gif-library/manifest.json, which step 4 generates instead of
//      copying) into dist/chrome and dist/firefox.
//   3. Copy build/ts/*.js (including lib/) into both dist folders.
//   4. Generate gif-library/manifest.json by scanning the actual
//      public/gif-library folder — this is the fix for the "not all GIFs
//      get picked up" bug: the manifest can no longer go stale, because it
//      is never hand-edited.
//   5. Copy manifest.json -> dist/chrome/manifest.json and
//      manifest.firefox.json -> dist/firefox/manifest.json, plus LICENSE.
//   6. Zip each dist/<browser> folder.

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGifLibrary } from "./gen-gif-manifest.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const DIST = path.join(ROOT, "dist");
const BROWSERS = ["chrome", "firefox"];

function log(msg) {
  console.log(`[build] ${msg}`);
}

async function run() {
  log("Compiling TypeScript (tsc -p tsconfig.json)...");
  execFileSync("tsc", ["-p", "tsconfig.json"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });

  log("Cleaning dist/...");
  await rm(DIST, { recursive: true, force: true });

  for (const browser of BROWSERS) {
    const outDir = path.join(DIST, browser);
    await mkdir(outDir, { recursive: true });

    log(`[${browser}] copying static assets from public/...`);
    await cp(path.join(ROOT, "public"), outDir, { recursive: true });

    log(`[${browser}] copying compiled JS from build/ts/...`);
    await cp(path.join(ROOT, "build", "ts"), outDir, { recursive: true });

    log(`[${browser}] generating gif-library/manifest.json...`);
    const manifest = await scanGifLibrary(path.join(outDir, "gif-library"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(outDir, "gif-library", "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    );
    log(`[${browser}] gif-library/manifest.json: ${manifest.files.length} file(s)`);

    log(`[${browser}] vendoring @ffmpeg/* (post-record area-mode crop, Firefox — see ARCHITECTURE.md Round 32)...`);
    await vendorFfmpeg(outDir);

    const manifestSrc = browser === "firefox" ? "manifest.firefox.json" : "manifest.json";
    await cp(path.join(ROOT, manifestSrc), path.join(outDir, "manifest.json"));

    if (existsSync(path.join(ROOT, "LICENSE"))) {
      await cp(path.join(ROOT, "LICENSE"), path.join(outDir, "LICENSE"));
    }
  }

  log("Zipping...");
  for (const browser of BROWSERS) {
    await zipDir(path.join(DIST, browser), path.join(DIST, `screenrec-toolkit-${browser}.zip`));
  }

  log("Done. Output:");
  for (const browser of BROWSERS) {
    log(`  dist/${browser}/  (unpacked, load this as an unpacked/temporary extension)`);
    log(`  dist/screenrec-toolkit-${browser}.zip`);
  }
}

// Copies the three @ffmpeg/* npm packages' pre-built browser assets into
// <outDir>/ffmpeg-vendor/, as PLAIN STATIC FILES (not bundled) — this
// project has no bundler (tsc only), and recorder.ts loads these via a
// dynamic import() of a chrome.runtime.getURL() string (untyped, so tsc
// never needs to resolve the actual package's module graph — see Round 32
// in ARCHITECTURE.md for why). @ffmpeg/ffmpeg and @ffmpeg/util ship their
// own self-contained ESM builds under dist/esm/ (only relative imports
// between their own files, verified against the versions pinned in
// package.json — if a future version restructures this, the copy below
// will fail loudly with ENOENT rather than silently shipping a stale/empty
// vendor folder).
//
// @ffmpeg/core MUST also come from dist/esm/, not dist/umd/ — see Round 38
// in ARCHITECTURE.md. Because we vendor @ffmpeg/ffmpeg's dist/esm build,
// FFmpeg.load() spins up its worker as `new Worker(url, {type:"module"})`.
// Inside a MODULE worker, Firefox has no importScripts() at all, so that
// worker's own worker.js falls back to `await import(coreURL)` to load
// ffmpeg-core — which means whatever bytes live at coreURL (our blob: URL
// wrapping ffmpeg-core.js) MUST parse as a valid ES module. The dist/umd
// build is a plain global-exposing script (no `export`), so the dynamic
// import throws "error loading dynamically imported module" and
// cropRecordedBlobWithFfmpeg() silently falls back to the uncropped
// recording. The dist/esm build (`export default createFFmpegCore`) is
// what a module-type worker's import() actually needs; the .wasm file is
// unaffected either way, just kept alongside its matching .js.
async function vendorFfmpeg(outDir) {
  const vendorDir = path.join(outDir, "ffmpeg-vendor");
  const copies = [
    { from: path.join(ROOT, "node_modules/@ffmpeg/ffmpeg/dist/esm"), to: path.join(vendorDir, "ffmpeg") },
    { from: path.join(ROOT, "node_modules/@ffmpeg/util/dist/esm"), to: path.join(vendorDir, "util") },
    { from: path.join(ROOT, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js"), to: path.join(vendorDir, "core/ffmpeg-core.js") },
    { from: path.join(ROOT, "node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm"), to: path.join(vendorDir, "core/ffmpeg-core.wasm") },
  ];
  for (const { from, to } of copies) {
    if (!existsSync(from)) {
      throw new Error(
        `[vendorFfmpeg] Expected to find "${from}" but it doesn't exist.\n` +
          `This usually means either "npm install" hasn't been run since @ffmpeg/ffmpeg, ` +
          `@ffmpeg/util and @ffmpeg/core were added to package.json, or one of those ` +
          `packages ships its browser build under a different path than assumed here in a ` +
          `newer/older version than the one pinned in package.json. Run "npm install" first; ` +
          `if the error persists, look inside node_modules/@ffmpeg/*/dist/ yourself and update ` +
          `the paths in scripts/build.mjs's vendorFfmpeg() to match.`
      );
    }
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }
}

// Zips the CONTENTS of dir (not the dir itself) into zipPath, so the
// manifest.json ends up at the zip's root — required for both the Chrome
// Web Store and AMO. Uses the system `zip` on POSIX and PowerShell's
// Compress-Archive on Windows, matching build.sh/build.bat.
async function zipDir(dir, zipPath) {
  await rm(zipPath, { force: true });
  if (process.platform === "win32") {
    const psCommand = `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", psCommand], { stdio: "inherit" });
    return;
  }
  const entries = await readdir(dir);
  execFileSync("zip", ["-r", "-X", zipPath, ...entries], { cwd: dir, stdio: "inherit" });
}

// Sanity check used only to give a clearer error than tsc's own if src/
// somehow isn't there at all (e.g. run from the wrong directory).
async function assertProjectRoot() {
  try {
    await stat(path.join(ROOT, "tsconfig.json"));
  } catch {
    throw new Error(`Expected to find tsconfig.json under ${ROOT} — is scripts/build.mjs being run from the project root?`);
  }
}

assertProjectRoot()
  .then(run)
  .catch((e) => {
    console.error("[build] FAILED:", e.message || e);
    process.exit(1);
  });
