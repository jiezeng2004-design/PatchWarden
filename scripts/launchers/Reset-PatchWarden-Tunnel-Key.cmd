@echo off
setlocal
cd /d "%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\start-patchwarden-tunnel.ps1" -ForgetSavedApiKey
echo.
pause
