import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isImageFile, buildManifest, scanGifLibrary } from "../../scripts/gen-gif-manifest.mjs";

test("isImageFile accepts the extensions the GIF library actually ships", () => {
  assert.equal(isImageFile("04_giphy.webp"), true);
  assert.equal(isImageFile("17_80h.gif"), true);
  assert.equal(isImageFile("cover.PNG"), true); // case-insensitive
  assert.equal(isImageFile("manifest.json"), false);
  assert.equal(isImageFile(".DS_Store"), false);
});

test("buildManifest filters non-images and sorts the result", () => {
  const manifest = buildManifest(["b.gif", "manifest.json", "a.webp", "c.gif"]);
  assert.deepEqual(manifest, { files: ["a.webp", "b.gif", "c.gif"] });
});

test("buildManifest is stable regardless of input order (this is the GIF bug's fix)", () => {
  // Simulates: files added to the folder over time in arbitrary order,
  // with no hand-maintained manifest to fall out of sync.
  const shuffled = ["21_200.gif", "04_giphy.webp", "17_80h.gif", "11_giphy.webp"];
  const manifest = buildManifest(shuffled);
  assert.deepEqual(manifest.files, ["04_giphy.webp", "11_giphy.webp", "17_80h.gif", "21_200.gif"]);
});

test("scanGifLibrary reflects the real directory contents, including files a stale manifest would miss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gif-library-"));
  try {
    await writeFile(join(dir, "old.gif"), "");
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ files: ["old.gif"] }));
    // A file added to the folder without anyone updating manifest.json —
    // exactly the scenario the user reported ("не все гиф... берутся").
    await writeFile(join(dir, "new.webp"), "");

    const manifest = await scanGifLibrary(dir);
    assert.deepEqual(manifest.files, ["new.webp", "old.gif"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
