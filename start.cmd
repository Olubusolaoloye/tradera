@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js was not found on this computer.
  echo Install the LTS version from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)

echo Starting Tradera...
echo Close this window or press Ctrl+C to stop.
echo.
node server.js
if errorlevel 1 pause
