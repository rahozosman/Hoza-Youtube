@echo off
title Hoza YT - status
cd /d "%~dp0"
python watchdog.py --status
echo.
pause
