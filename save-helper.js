// This runs in a real, ordinary extension page — deliberately NOT the
// service worker (which has chrome.downloads but no URL.createObjectURL in
// this browser) and NOT an offscreen document (which has
// URL.createObjectURL but no chrome.downloads). A ordinary page context has
// both, which is exactly what's needed to reliably save a large recorded
// video without ever converting it to a base64 string.

const BLOB_DB_NAME = "screenrec-blobs-db";
const BLOB_STORE_NAME = "blobs";

function openBlobDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(BLOB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BLOB_STORE_NAME)) {
        req.result.createObjectStore(BLOB_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getBlobRecord(id) {
  const db = await openBlobDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BLOB_STORE_NAME, "readonly");
    const req = tx.objectStore(BLOB_STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteBlobRecord(id) {
  try {
    const db = await openBlobDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE_NAME, "readwrite");
      tx.objectStore(BLOB_STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { /* best effort cleanup */ }
}

async function main() {
  const params = new URLSearchParams(location.search);
  const blobId = params.get("blobId");
  const filename = params.get("filename");
  const mode = params.get("mode") || "unknown";

  let result = { ok: false };
  let objectUrl = null;
  try {
    const record = await getBlobRecord(blobId);
    if (!record || !record.blob) throw new Error("blob record not found (id: " + blobId + ")");
    if (record.blob.size === 0) throw new Error("recorded blob is empty (0 bytes)");

    objectUrl = URL.createObjectURL(record.blob);
    const downloadId = await chrome.downloads.download({ url: objectUrl, filename, saveAs: false });
    result = { ok: true, downloadId, filename, mode, size: record.blob.size };
  } catch (e) {
    console.error("ScreenRec save-helper: failed to save recording", e);
    result = { ok: false, detail: String(e && e.message || e) };
  } finally {
    await deleteBlobRecord(blobId);
    chrome.runtime.sendMessage({ target: "background", type: "SAVE_RECORDING_RESULT", ...result }).catch(() => {});
    // Give the download manager a moment to actually start reading the blob
    // before revoking the URL and closing this helper page.
    setTimeout(() => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      window.close();
    }, 4000);
  }
}

main();
