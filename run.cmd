@echo off
rem Runs the supervisor, and starts it again when it updates itself or stops unexpectedly.
rem install.bat has Windows run this when the PC turns on; you can also double-click it to run it by hand.
title Node servers
cd /d "%~dp0"
set "NODE=node"
if exist node-path.txt set /p NODE=<node-path.txt
:run
"%NODE%" supervisor.mjs
rem 0 means it was asked to stop; anything else (75 = it updated itself) starts it again.
if %errorlevel%==0 goto :eof
timeout /t 3 /nobreak >nul
goto run
