@echo off
cd /d "%~dp0backend"
echo Starting Calorie Scanner server...
echo.
echo On your phone (same WiFi), open:
echo   http://192.168.1.156:8420
echo (if that doesn't load, run "ipconfig" here and use the IPv4 Address instead)
echo.
.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8420
