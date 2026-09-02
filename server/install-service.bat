@echo off
title Hoza YT - always-on setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-service.ps1"
echo.
pause
