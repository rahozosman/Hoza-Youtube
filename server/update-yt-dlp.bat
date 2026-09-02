@echo off
cd /d "%~dp0"
echo Updating yt-dlp. YouTube changes often, so run this when downloads start failing.
python -m pip install --upgrade yt-dlp
pause
