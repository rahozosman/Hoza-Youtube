@echo off
title Hoza YT - stop the server
cd /d "%~dp0"
rem The watchdog is stopped first, otherwise it just starts the server again.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-processes.ps1"
echo.
echo Note: while the sign-in task is installed, the watchdog is started again
echo within ten minutes. Run uninstall-service.bat to stop that too.
echo.
pause
