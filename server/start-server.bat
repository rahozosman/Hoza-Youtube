@echo off
title Hoza YT Server
cd /d "%~dp0"

rem -silent suppresses the browser tab and every pause, for any caller that
rem runs this with no window for a person to click.
set "SILENT="
if /i "%~1"=="-silent" set "SILENT=1"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Install it from https://www.python.org/downloads/ and tick "Add to PATH".
  if not defined SILENT pause
  exit /b 1
)

rem Reuse an already healthy server instead of starting a duplicate process.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8765/api/health -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  if not defined SILENT start "" "http://127.0.0.1:8765/"
  exit /b 0
)

python -c "import fastapi, uvicorn, httpx, psutil, yt_dlp, imageio_ffmpeg" >nul 2>nul
if errorlevel 1 (
  echo Installing requirements...
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Dependency installation failed.
    if not defined SILENT pause
    exit /b 1
  )
)
:run_server
echo Starting Hoza YT server at http://127.0.0.1:8765
python server.py --no-browser
if errorlevel 1 (
  echo The server stopped unexpectedly. Restarting in 5 seconds...
  timeout /t 5 /nobreak >nul
  goto run_server
)
echo Server stopped normally.
if not defined SILENT pause
