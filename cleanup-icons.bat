@echo off
rem One-off cleanup: public/icons/ has the full leftover output of a
rem favicon-generator tool sitting alongside the extension's real icons.
rem None of it is referenced by manifest.json/manifest.firefox.json (only
rem icon16/32/48/128.png are), and its own manifest.json is exactly what
rem trips the Chrome Web Store's "More than one manifest found" upload
rem error a second time, after gif-library's copy was already fixed and
rem renamed. See ARCHITECTURE.md (Round 79) for the full diagnosis.
rem
rem Safe to delete and re-run: only removes the specific leftover files
rem listed below, by exact name, and leaves icon16/32/48/128.png alone.
setlocal
set "ICONS_DIR=%~dp0public\icons"

if not exist "%ICONS_DIR%" (
  echo Could not find "%ICONS_DIR%" - run this from the project root.
  pause
  exit /b 1
)

echo Removing favicon-generator leftovers from "%ICONS_DIR%" ...

del /F /Q "%ICONS_DIR%\android-icon-144x144.png" 2>nul
del /F /Q "%ICONS_DIR%\android-icon-192x192.png" 2>nul
del /F /Q "%ICONS_DIR%\android-icon-36x36.png" 2>nul
del /F /Q "%ICONS_DIR%\android-icon-48x48.png" 2>nul
del /F /Q "%ICONS_DIR%\android-icon-72x72.png" 2>nul
del /F /Q "%ICONS_DIR%\android-icon-96x96.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-114x114.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-120x120.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-144x144.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-152x152.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-180x180.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-57x57.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-60x60.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-72x72.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-76x76.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon-precomposed.png" 2>nul
del /F /Q "%ICONS_DIR%\apple-icon.png" 2>nul
del /F /Q "%ICONS_DIR%\browserconfig.xml" 2>nul
del /F /Q "%ICONS_DIR%\favicon-16x16.png" 2>nul
del /F /Q "%ICONS_DIR%\favicon-32x32.png" 2>nul
del /F /Q "%ICONS_DIR%\favicon-96x96.png" 2>nul
del /F /Q "%ICONS_DIR%\favicon.ico" 2>nul
del /F /Q "%ICONS_DIR%\icon_orig.png" 2>nul
del /F /Q "%ICONS_DIR%\manifest.json" 2>nul
del /F /Q "%ICONS_DIR%\ms-icon-144x144.png" 2>nul
del /F /Q "%ICONS_DIR%\ms-icon-150x150.png" 2>nul
del /F /Q "%ICONS_DIR%\ms-icon-310x310.png" 2>nul
del /F /Q "%ICONS_DIR%\ms-icon-70x70.png" 2>nul

echo Done. Remaining files in "%ICONS_DIR%":
dir /B "%ICONS_DIR%"
echo.
echo Expected exactly: icon128.png icon16.png icon32.png icon48.png
pause
