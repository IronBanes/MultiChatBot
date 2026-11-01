@echo off
rem Multichat starter for Windows. Double-click, or run: start.cmd [--server] [--instance NAME] [--yes]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
if errorlevel 1 (
  echo.
  echo Multichat did not start. See the messages above.
  pause
)
