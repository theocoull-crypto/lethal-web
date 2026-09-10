@echo off
cd /d "%~dp0\.."
python tools\extract.py %*
pause
