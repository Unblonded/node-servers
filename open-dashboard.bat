@echo off
rem Opens the dashboard (on this PC only) with its key.
cd /d "%~dp0"
if not exist dashboard.url (
  echo The supervisor hasn't started yet. Run install.bat, or double-click run.cmd.
  pause
  exit /b 1
)
set /p URL=<dashboard.url
start "" "%URL%"
