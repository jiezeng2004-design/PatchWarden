@echo off
setlocal
cd /d "%~dp0"
echo.
echo ========================================
echo  Safe-Bifrost One-Click Restart
echo ========================================
echo.
echo This will:
echo   1. Stop only processes owned by the current Safe-Bifrost launcher
echo   2. Rebuild the project
echo   3. Start a fresh tunnel launcher window
echo.
echo Close this window to cancel, or
pause
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\restart-safe-bifrost.ps1"
echo.
echo Restart script finished.
pause
