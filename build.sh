#!/usr/bin/env bash
# Builds the Chrome and Firefox versions of ScreenRec Toolkit.
#
# Produces:
#   dist/chrome/                       (load as an unpacked extension)
#   dist/firefox/                      (load as a temporary add-on, or sign for AMO)
#   dist/screenrec-toolkit-chrome.zip
#   dist/screenrec-toolkit-firefox.zip
#
# All the real work (tsc compile, static asset copy, gif-library manifest
# generation, per-browser manifest.json selection, zipping) lives in
# scripts/build.mjs so it runs identically here and on Windows (build.bat).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

if [ ! -d node_modules ]; then
  echo "node_modules/ not found — run 'npm install' first." >&2
  exit 1
fi

node scripts/build.mjs
