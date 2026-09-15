// This runs in a real, ordinary extension page — deliberately NOT the
// service worker (which has chrome.downloads but no URL.createObjectURL in
// this browser) and NOT an offscreen document (which has
// URL.createObjectURL but no chrome.downloads). An ordinary page context
// has both, which is exactly what's needed to reliably save a large
// recorded video without ever converting it to a base64 string.

import { getBlobRecord, deleteBlobRecord } from "./lib/blob-db.js";

interface SaveResult {
  ok: boolean;
  blobId?: string;
  downloadId?: number;
  filename?: string | null;
  mode?: string;
  size?: number;
  detail?: string;
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const blobId = params.get("blobId") as string;
  const filename = params.get("filename");
  const mode = params.get("mode") || "unknown";

  // Logged unconditionally, before anything else can throw: if this line
  // never shows up in the background/service worker console, the helper
  // window itself never actually ran this script at all (see
  // ARCHITECTURE.md on the background.ts save-watchdog this pairs with).
  console.log("ScreenRec save-helper: starting, blobId =", blobId, "mode =", mode);

  let result: SaveResult = { ok: false, blobId };
  let objectUrl: string | null = null;
  try {
    const record = await getBlobRecord(blobId);
    if (!record || !record.blob) throw new Error("blob record not found (id: " + blobId + ")");
    if (record.blob.size === 0) throw new Error("recorded blob is empty (0 bytes)");

    objectUrl = URL.createObjectURL(record.blob);
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename: filename as string,
      saveAs: false,
    });
    result = { ok: true, blobId, downloadId, filename, mode, size: record.blob.size };
  } catch (e) {
    console.error("ScreenRec save-helper: failed to save recording", e);
    const message = e instanceof Error ? e.message : String(e);
    result = { ok: false, blobId, detail: message };
  } finally {
    await deleteBlobRecord(blobId);
    chrome.runtime
      .sendMessage({ target: "background", type: "SAVE_RECORDING_RESULT", ...result })
      .catch(() => {});
    // Give the download manager a moment to actually start reading the blob
    // before revoking the URL and closing this helper page.
    setTimeout(() => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      window.close();
    }, 4000);
  }
}

main();
