@echo off
cd /d "%~dp0"
echo Starting LETHAL WEB for other devices on your network (and Tailscale)...
python serve.py 8220 --lan
