@echo off
title Hoza YT - remove always-on setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-service.ps1"
echo.
pause
