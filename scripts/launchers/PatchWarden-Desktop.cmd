@echo off
setlocal
cd /d "%~dp0..\.."
start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0..\control\control-center-tray.ps1" %*
endlocal & exit /b 0
