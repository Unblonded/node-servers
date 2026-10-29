@echo off
rem Removes the Node servers service and stops its servers. servers.json and the logs stay.
net session >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -Command "Stop-ScheduledTask -TaskName 'Node servers' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName 'Node servers' -Confirm:$false -ErrorAction SilentlyContinue"
set "NODE=node"
if exist node-path.txt set /p NODE=<node-path.txt
"%NODE%" supervisor.mjs stop-all
echo.
echo The service is removed and its servers are stopped. servers.json and logs\ are still here.
pause
