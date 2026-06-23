@echo off
setlocal
cd /d "%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\manage-patchwarden.ps1" restart core
echo.
pause
