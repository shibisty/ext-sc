// Filename generation for downloaded screenshots/recordings.
//
// Duplicated (in slightly different forms) across background.js,
// offscreen.js and recorder.js's onRecorderStopped; extracted here as the
// single source of truth. `date` defaults to "now" but can be passed
// explicitly, which is what makes this testable without mocking the global
// clock.
//
// Screenshots (background.ts) use `timestampName(ext)` → "ScreenRec/<stamp>.ext".
// Recordings (offscreen.ts, recorder.ts) use a "ScreenRec-" filename prefix
// so the two file kinds are visually distinguishable in the Downloads
// folder → pass `prefix: "ScreenRec-"` for that form.

export function timestampName(ext: string, date: Date = new Date(), prefix = ""): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `ScreenRec/${prefix}${stamp}.${ext}`;
}
