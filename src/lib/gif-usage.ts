// GIF library ranking (annotate-overlay.js's "most-used first" ordering)
// plus the chrome.storage.local read/write around it.
//
// The storage key and the read/bump helpers are unchanged from the
// original; `rankGifFiles` is a new pure extraction of the sort that used
// to be inlined in loadGifLibrary(), so it can be unit-tested directly
// instead of only indirectly through the DOM-building code around it.

export const GIF_USAGE_KEY = "gifLibraryUsage";

export type GifUsage = Record<string, number>;

// Most-used first; ties keep the manifest's original order.
export function rankGifFiles(files: string[], usage: GifUsage): string[] {
  return files
    .map((name, idx) => ({ name, idx, count: usage[name] || 0 }))
    .sort((a, b) => b.count - a.count || a.idx - b.idx)
    .map((entry) => entry.name);
}

export async function getGifUsage(): Promise<GifUsage> {
  return chrome.storage.local
    .get<Record<string, GifUsage>>([GIF_USAGE_KEY])
    .then((r) => r[GIF_USAGE_KEY] || {})
    .catch(() => ({}));
}

export async function bumpGifUsage(filename: string): Promise<void> {
  const usage = await getGifUsage();
  usage[filename] = (usage[filename] || 0) + 1;
  await chrome.storage.local.set({ [GIF_USAGE_KEY]: usage });
}
