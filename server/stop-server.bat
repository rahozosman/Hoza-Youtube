@echo off
title Hoza YT - stop the server
cd /d "%~dp0"
rem The watchdog is stopped first, otherwise it just starts the server again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-processes.ps1"
echo.
echo Note: if the sign-in task is still installed, the watchdog comes back at
echo your next sign-in. Run uninstall-service.bat to stop that too.
echo.
pause
