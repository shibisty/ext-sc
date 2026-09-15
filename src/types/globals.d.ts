// Firefox's native WebExtension global — see src/shim.ts. Declared as
// `typeof chrome` because that's exactly what shim.ts assigns `chrome` to
// at runtime; we only ever probe it with `typeof browser !== "undefined"`,
// never dereference it with a possibly-undefined static type, so this
// simple declaration is enough.
declare const browser: typeof chrome;
