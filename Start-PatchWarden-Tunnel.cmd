@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-patchwarden-tunnel.ps1"
echo.
echo PatchWarden tunnel launcher exited.
pause
