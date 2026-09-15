#!/usr/bin/env node
// Generates gif-library/manifest.json by scanning the actual folder,
// instead of relying on someone to hand-edit the list every time a file is
// added or removed.
//
// Content scripts can't enumerate a directory's contents at runtime (no
// filesystem API is exposed to them), so the extension has always shipped
// a manifest.json next to the images that just lists their filenames. That
// manifest used to be maintained by hand, which is exactly why the bug
// this file fixes existed: add a new GIF to the folder, forget to add it
// to manifest.json, and annotate-overlay.js's GIF picker would never show
// it. Generating the manifest from the real folder contents at build time
// makes that class of bug impossible.

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

// Matches what annotate-overlay's <img>/animated-decoder path actually
// renders; manifest.json itself and any stray non-image file are skipped.
const IMAGE_EXTENSIONS = new Set([".gif", ".webp", ".png", ".jpg", ".jpeg"]);

export function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(extname(filename).toLowerCase());
}

// Sorted so the manifest is stable/diff-friendly across rebuilds
// regardless of the filesystem's directory-listing order.
export function buildManifest(filenames) {
  const files = filenames.filter(isImageFile).sort((a, b) => a.localeCompare(b, "en"));
  return { files };
}

export async function scanGifLibrary(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const filenames = entries.filter((e) => e.isFile()).map((e) => e.name);
  return buildManifest(filenames);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: node scripts/gen-gif-manifest.mjs <gif-library-dir> [output-file]");
    process.exit(1);
  }
  const manifest = await scanGifLibrary(dir);
  const outFile = process.argv[3];
  const json = JSON.stringify(manifest, null, 2) + "\n";
  if (outFile) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outFile, json, "utf8");
    console.log(`Wrote ${manifest.files.length} entries to ${outFile}`);
  } else {
    const target = join(dir, "manifest.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(target, json, "utf8");
    console.log(`Wrote ${manifest.files.length} entries to ${target}`);
  }
}

// Only run when invoked directly (`node scripts/gen-gif-manifest.mjs ...`),
// not when imported by build.mjs or the test suite.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
