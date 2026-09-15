#!/usr/bin/env node
// Generates gif-library/index.json by scanning the actual folder, instead
// of relying on someone to hand-edit the list every time a file is added
// or removed.
//
// Content scripts can't enumerate a directory's contents at runtime (no
// filesystem API is exposed to them), so the extension has always shipped
// a small JSON file next to the images that just lists their filenames.
// That file used to be maintained by hand, which is exactly why the bug
// this file fixes existed: add a new GIF to the folder, forget to add it
// to the list, and annotate-overlay.js's GIF picker would never show it.
// Generating the file from the real folder contents at build time makes
// that class of bug impossible.
//
// It's named index.json rather than manifest.json — despite genuinely
// being a manifest of the GIF folder's contents — because the Chrome Web
// Store's own upload validator scans the whole zip for any file literally
// named "manifest.json" and rejects the package if it finds more than one
// (it doesn't matter that only the one at the archive's root is the actual
// extension manifest). See ARCHITECTURE.md for the fix that renamed it.

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

// Matches what annotate-overlay's <img>/animated-decoder path actually
// renders; index.json itself and any stray non-image file are skipped.
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
    const target = join(dir, "index.json");
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
