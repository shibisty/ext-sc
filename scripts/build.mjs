#!/usr/bin/env node
// Builds dist/chrome and dist/firefox from src/ (via tsc), public/ (static
// assets) and the two per-browser manifest files, then zips each folder.
//
// Steps:
//   1. Compile src/**/*.ts -> build/ts/**/*.js (tsc; see tsconfig.json for
//      why some of those compile as classic scripts and others as ES
//      modules).
//   2. Copy public/ (HTML/CSS/icons/_locales/gif images) into dist/chrome
//      and dist/firefox, then verify every source file actually landed
//      (see copyVerified() below) — gif-library/index.json is copied too
//      if a stale one exists, but step 4 unconditionally regenerates and
//      overwrites it from the real folder contents right after.
//   3. Copy build/ts/*.js (including lib/) into both dist folders, same
//      copy-then-verify.
//   4. Generate gif-library/index.json by scanning the actual
//      public/gif-library folder — this is the fix for the "not all GIFs
//      get picked up" bug: the manifest can no longer go stale, because it
//      is never hand-edited. (Named index.json, not manifest.json, because
//      the Chrome Web Store's own upload validator scans the whole archive
//      for any file literally named "manifest.json" and rejects the
//      package if it finds more than one — see ARCHITECTURE.md.)
//   5. Copy manifest.json -> dist/chrome/manifest.json and
//      manifest.firefox.json -> dist/firefox/manifest.json, plus LICENSE.
//   6. Zip each dist/<browser> folder.

import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGifLibrary } from "./gen-gif-manifest.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const DIST = path.join(ROOT, "dist");
const BROWSERS = ["chrome", "firefox"];

function log(msg) {
  console.log(`[build] ${msg}`);
}

// Recursively lists every regular file under `dir`, as paths relative to
// it (forward-slash-joined regardless of platform).
function listFilesRecursive(dir, rel = "", out = []) {
  for (const entry of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) listFilesRecursive(dir, relPath, out);
    else if (entry.isFile()) out.push(relPath);
  }
  return out;
}

// `fs.promises.cp(src, dest, { recursive: true })` has shown a real,
// reproducible failure mode on this project's Windows build machine: it
// resolves successfully — no thrown error — after copying only SOME of a
// source directory's files. Caught directly: public/gif-library's 74 real
// images, only 14 of which made it into dist/chrome/gif-library. That
// wasn't a bug in gif-library's own manifest generator (scanGifLibrary()
// faithfully reported what was actually sitting in the copied folder) —
// it was the copy step silently under-delivering upstream of it, so the
// user saw a GIF count in the app that didn't match the real library.
// This wraps every recursive copy in the build with a same-tree
// verification (every source file present at the destination, matching
// size) and a few retries before giving up — the failure mode looks like
// a transient Windows/antivirus file lock, which a retry has a good
// chance of clearing — so a build either genuinely matches its source or
// fails loudly with exactly which files didn't make it, instead of
// silently shipping a partial package.
async function copyVerified(src, dest, label, attempts = 3) {
  let problems = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await cp(src, dest, { recursive: true });
    problems = listFilesRecursive(src).filter((rel) => {
      const destPath = path.join(dest, rel);
      if (!existsSync(destPath)) return true;
      return statSync(destPath).size !== statSync(path.join(src, rel)).size;
    });
    if (problems.length === 0) {
      if (attempt > 1) log(`${label}: copy verified complete on attempt ${attempt}`);
      return;
    }
    log(`${label}: copy incomplete on attempt ${attempt}/${attempts} (${problems.length} file(s) missing or size-mismatched)`);
  }
  throw new Error(
    `${label}: copy from "${src}" to "${dest}" is still incomplete after ${attempts} attempts — ` +
      `${problems.length} file(s) missing or wrong size, e.g. ${problems.slice(0, 10).join(", ")}` +
      `${problems.length > 10 ? ` (+${problems.length - 10} more)` : ""}. This has been observed as a real, ` +
      `intermittent fs.cp() issue on this machine (see ARCHITECTURE.md) — re-running the build usually clears ` +
      `it; if it keeps failing, check for antivirus/indexing locks on the project folder.`
  );
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
    await copyVerified(path.join(ROOT, "public"), outDir, `[${browser}] public/`);

    log(`[${browser}] copying compiled JS from build/ts/...`);
    await copyVerified(path.join(ROOT, "build", "ts"), outDir, `[${browser}] build/ts/`);

    log(`[${browser}] generating gif-library/index.json...`);
    const manifest = await scanGifLibrary(path.join(outDir, "gif-library"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(outDir, "gif-library", "index.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    );
    log(`[${browser}] gif-library/index.json: ${manifest.files.length} file(s)`);

    log(`[${browser}] vendoring @ffmpeg/* (post-record area-mode crop, Firefox — see ARCHITECTURE.md)...`);
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
// never needs to resolve the actual package's module graph — see
// ARCHITECTURE.md for why). @ffmpeg/ffmpeg and @ffmpeg/util ship their
// own self-contained ESM builds under dist/esm/ (only relative imports
// between their own files, verified against the versions pinned in
// package.json — if a future version restructures this, the copy below
// will fail loudly with ENOENT rather than silently shipping a stale/empty
// vendor folder).
//
// @ffmpeg/core MUST also come from dist/esm/, not dist/umd/ — see
// ARCHITECTURE.md. Because we vendor @ffmpeg/ffmpeg's dist/esm build,
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
// Web Store and AMO.
//
// This used to shell out to the system `zip` on POSIX and to PowerShell's
// Compress-Archive on Windows. The Windows path turned out to write every
// entry's path with a backslash ("\") separator instead of the forward
// slash the ZIP spec (APPNOTE.TXT §4.4.17.1) requires — invisible in
// Windows Explorer, which normalizes it on read, but fatal for AMO's
// addons-linter, which rejects the whole upload with "Invalid file name
// in archive: <path>\<file>" (always something under ffmpeg-vendor/ here,
// the only vendored subtree with nested folders). Switching that branch
// to call .NET's ZipFile.CreateFromDirectory directly (instead of the
// Compress-Archive cmdlet, which is a separate, buggy implementation)
// should have fixed it, since that API is documented to normalize
// separators — but the same upload failed again afterwards with the
// exact same error, and this container has no Windows/PowerShell to
// reproduce or debug that discrepancy on. Rather than guess at a second
// PowerShell incantation and hope, this now writes the ZIP file itself in
// plain Node — the exact same code path on every platform, no shelling
// out to any OS-specific zip tool at all, and something this container
// CAN actually build and verify end-to-end — see ARCHITECTURE.md for the
// full reasoning and how it was verified without Windows available.
async function zipDir(dir, zipPath) {
  await rm(zipPath, { force: true });

  const files = [];
  (function walk(current) {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  })(dir);

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  let entryCount = 0;

  for (const filePath of files) {
    // Entry names must always use "/", regardless of the OS this build
    // runs on (path.sep is "\" on Windows) — this is the one detail the
    // old PowerShell path got wrong.
    const entryName = path.relative(dir, filePath).split(path.sep).join("/");
    const data = readFileSync(filePath);
    const { time: dosTime, date: dosDate } = toDosDateTime(statSync(filePath).mtime);
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    // Only use the compressed bytes if they're actually smaller — small
    // or already-compressed files (e.g. .wasm, .webp) can come out larger
    // under deflate, and storing them uncompressed is both valid and
    // simpler than falling back mid-write.
    const useStore = compressed.length >= data.length;
    const method = useStore ? 0 : 8; // 0 = stored, 8 = deflate
    const payload = useStore ? data : compressed;
    const nameBuf = Buffer.from(entryName, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(0x0800, 6); // general purpose flag: UTF-8 name
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length
    localChunks.push(localHeader, nameBuf, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(0x0800, 8); // general purpose flag: UTF-8 name
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header
    centralChunks.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + payload.length;
    entryCount++;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralChunks);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // number of this disk
  eocd.writeUInt16LE(0, 6); // disk with start of central directory
  eocd.writeUInt16LE(entryCount, 8); // entries on this disk
  eocd.writeUInt16LE(entryCount, 10); // total entries
  eocd.writeUInt32LE(centralDirBuf.length, 12); // size of central directory
  eocd.writeUInt32LE(centralDirStart, 16); // offset of start of central directory
  eocd.writeUInt16LE(0, 20); // comment length

  writeFileSync(zipPath, Buffer.concat([...localChunks, centralDirBuf, eocd]));
}

function toDosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosYear = Math.max(0, date.getFullYear() - 1980) & 0x7f;
  const dosDate = (dosYear << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, date: dosDate };
}

// Standard CRC-32 (the polynomial ZIP itself uses) — computed by hand
// instead of pulling in a dependency, since it's ~15 lines and this
// project otherwise has none.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
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
