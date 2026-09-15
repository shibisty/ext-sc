// Large-blob transfer via IndexedDB.
//
// chrome.runtime.sendMessage has a hard 64MiB cap, which a long recording's
// base64 payload can easily exceed. IndexedDB is available at the same
// extension origin in every page context (service worker, offscreen
// document, the popup/sidepanel, the recorder fallback window, and
// save-helper.html), so only a small string key is passed through
// messaging and the actual blob travels via IndexedDB instead.
//
// This logic used to be copy-pasted near-verbatim into background.js,
// offscreen.js, recorder.js and save-helper.js (four independent copies
// that could drift). It now lives here once, and every page that needs it
// imports from this module instead.

export const BLOB_DB_NAME = "screenrec-blobs-db";
export const BLOB_STORE_NAME = "blobs";

export interface BlobRecord {
  blob: Blob;
  createdAt: number;
}

export interface StoredBlobRecord extends BlobRecord {
  id: string;
}

// Firefox's background page (unlike Chrome's service worker, which gets
// torn down and restarted often) stays alive for the entire browser
// session — potentially many hours across many recordings. Every previous
// version of this module opened a fresh IndexedDB connection per call and
// never closed it, which is normally harmless for a page that reloads
// often, but on a long-lived page it leaks one open connection per
// recording forever. Given enough of those (this codebase alone has been
// through dozens of test recordings in a single sitting more than once),
// this is a plausible cause of indexedDB.open() eventually hanging with
// neither onsuccess nor onerror ever firing — silently, with nothing to
// catch it short of an external watchdog (see background.ts's
// FRAME_STITCH_STOP_WATCHDOG_MS). Opening a connection per call is kept
// (simpler than a shared long-lived connection, and each call here is
// infrequent) but every connection is now explicitly closed once its one
// transaction settles, and a hung open() itself is now bounded by a
// timeout instead of being able to wait forever.
const OPEN_TIMEOUT_MS = 5000;

function openBlobDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("indexedDB.open() timed out after " + OPEN_TIMEOUT_MS + "ms"));
    }, OPEN_TIMEOUT_MS);

    const req = indexedDB.open(BLOB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(BLOB_STORE_NAME)) {
        req.result.createObjectStore(BLOB_STORE_NAME, { keyPath: "id" });
      }
    };
    req.onblocked = () => {
      // Fires when another open connection is preventing a version change.
      // Shouldn't normally happen here (the version never changes after
      // first creation), but without this handler the request would just
      // sit pending forever with neither onsuccess nor onerror — this at
      // least gets logged and still hits the timeout above instead of
      // hanging silently.
      console.error("ScreenRec: blob-db open() blocked by another connection");
    };
    req.onsuccess = () => {
      if (settled) {
        // Timed out already — close this connection, nothing needs it.
        req.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(req.result);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(req.error);
    };
  });
}

async function runTransaction<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  const db = await openBlobDB();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(BLOB_STORE_NAME, mode);
      const req = run(tx.objectStore(BLOB_STORE_NAME));
      let result: T | undefined;
      if (req) req.onsuccess = () => { result = req.result; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("blob-db transaction aborted"));
    });
  } finally {
    db.close();
  }
}

// Written by the offscreen document / recorder fallback window once a
// recording (or clipboard image) finishes.
export async function storeBlobRecord(id: string, record: BlobRecord): Promise<void> {
  await runTransaction("readwrite", (store) => {
    store.put({ id, ...record });
  });
}

// Read by the service worker / save-helper page to fetch the blob back out.
export async function getBlobRecord(id: string): Promise<StoredBlobRecord | null> {
  const result = await runTransaction<StoredBlobRecord>("readonly", (store) => store.get(id));
  return result || null;
}

// Best-effort cleanup once a blob has been consumed; failures are logged,
// not thrown, since a leftover record is harmless and shouldn't block the
// action that triggered the cleanup.
export async function deleteBlobRecord(id: string): Promise<void> {
  try {
    await runTransaction("readwrite", (store) => {
      store.delete(id);
    });
  } catch (e) {
    console.error("ScreenRec: failed to clean up blob record", e);
  }
}

// Best-effort startup cleanup: any record older than this has to be a
// leftover from a recording whose save never completed (a crash, a hung
// save, or — before this round's fixes — the frame-stitch stop bug this
// module's own connection-leak likely contributed to). Left forever,
// these just accumulate large video blobs in the same IndexedDB database,
// which is itself a plausible way to make future opens slower or more
// likely to hang. Called once from background.ts on startup.
const STALE_BLOB_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export async function purgeStaleBlobRecords(): Promise<void> {
  try {
    const cutoff = Date.now() - STALE_BLOB_MAX_AGE_MS;
    const all = (await runTransaction<StoredBlobRecord[]>("readonly", (store) => store.getAll())) || [];
    const stale = all.filter((r) => r.createdAt < cutoff);
    if (stale.length === 0) return;
    console.error(`ScreenRec: purging ${stale.length} stale blob record(s) left over from a previous session`);
    for (const record of stale) {
      await deleteBlobRecord(record.id);
    }
  } catch (e) {
    console.error("ScreenRec: failed to purge stale blob records", e);
  }
}

export async function blobToDataURL(blob: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
