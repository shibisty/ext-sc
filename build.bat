@echo off
setlocal

REM Builds the Chrome and Firefox versions of ScreenRec Toolkit.
REM
REM Produces:
REM   dist\chrome\                        (load as an unpacked extension)
REM   dist\firefox\                       (load as a temporary add-on, or sign for AMO)
REM   dist\screenrec-toolkit-chrome.zip
REM   dist\screenrec-toolkit-firefox.zip
REM
REM All the real work (tsc compile, static asset copy, gif-library manifest
REM generation, per-browser manifest.json selection, zipping via
REM PowerShell's Compress-Archive) lives in scripts\build.mjs so it runs
REM identically here and on macOS/Linux (build.sh).

cd /d "%~dp0"

if not exist node_modules (
  echo node_modules not found -- run "npm install" first. 1>&2
  exit /b 1
)

node scripts\build.mjs
if errorlevel 1 exit /b 1

endlocal
