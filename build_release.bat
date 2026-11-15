@echo off
setlocal EnableExtensions
rem Builds the markon release exe without the MSI/NSIS installers.
rem Extra arguments go to `tauri build`, e.g. `build_release.bat --features foo`.

cd /d "%~dp0"
set "EXE=%CD%\src-tauri\target\release\markon.exe"

for %%T in (node npm cargo) do (
  where %%T >nul 2>nul || (
    echo error: %%T not found on PATH
    exit /b 1
  )
)

rem A running copy locks the exe, and cargo only fails after compiling.
powershell -NoProfile -Command "if (Get-Process markon -ErrorAction Ignore | Where-Object Path -eq $env:EXE) { exit 1 }"
if errorlevel 1 (
  echo error: close the running %EXE% first
  exit /b 1
)

if not exist node_modules\ (
  echo Installing npm dependencies...
  call npm ci || exit /b 1
)

rem The app crate instantiates all of Tauri's generics, so each optimized build of it takes ~35s.
rem Incremental compilation reuses that work when only the frontend changed (~6s).
set CARGO_PROFILE_RELEASE_INCREMENTAL=true

echo Building Tauri release...
call npm run tauri:build -- --no-bundle %* || (
  echo error: tauri build failed
  exit /b 1
)

echo.
echo Executable: %EXE%
exit /b 0
