@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "LAUNCHERS_DIR=%~dp0scripts\launchers"
set "PATCHWARDEN_COMMAND=%~1"

if /i "%PATCHWARDEN_COMMAND%"=="control" goto dispatch_control
if /i "%PATCHWARDEN_COMMAND%"=="desktop" goto dispatch_desktop
if /i "%PATCHWARDEN_COMMAND%"=="tray" goto dispatch_tray
if /i "%PATCHWARDEN_COMMAND%"=="stop" goto dispatch_stop
if /i "%PATCHWARDEN_COMMAND%"=="restart-control" goto dispatch_restart_control
goto default_behavior

:dispatch_control
call "%LAUNCHERS_DIR%\PatchWarden-Control.cmd" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:dispatch_desktop
call "%LAUNCHERS_DIR%\PatchWarden-Desktop.cmd" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:dispatch_tray
call "%LAUNCHERS_DIR%\PatchWarden-Control-Tray.cmd" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:dispatch_stop
call "%LAUNCHERS_DIR%\Stop-PatchWarden.cmd" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:dispatch_restart_control
call "%LAUNCHERS_DIR%\Restart-PatchWarden-Control.cmd" %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:default_behavior
set "DEFAULT_PROXY=http://127.0.0.1:7892"

if not defined PATCHWARDEN_PROXY_URL (
  if defined HTTPS_PROXY (
    set "PATCHWARDEN_PROXY_URL=%HTTPS_PROXY%"
  ) else if defined HTTP_PROXY (
    set "PATCHWARDEN_PROXY_URL=%HTTP_PROXY%"
  ) else (
    set "PATCHWARDEN_PROXY_URL=%DEFAULT_PROXY%"
  )
)

set "HTTP_PROXY=%PATCHWARDEN_PROXY_URL%"
set "HTTPS_PROXY=%PATCHWARDEN_PROXY_URL%"
set "ALL_PROXY=%PATCHWARDEN_PROXY_URL%"
set "NO_PROXY=localhost,127.0.0.1,::1"

set "MANAGER=%~dp0scripts\control\manage-patchwarden.ps1"

if not exist "%MANAGER%" (
  echo [error] manage-patchwarden.ps1 not found:
  echo         %MANAGER%
  echo.
  pause
  exit /b 1
)

echo ========================================
echo  PatchWarden Control
echo ========================================
echo Project: %~dp0
echo Proxy : %PATCHWARDEN_PROXY_URL%
echo NO_PROXY: %NO_PROXY%
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%MANAGER%" %*
set "PATCHWARDEN_EXIT_CODE=%ERRORLEVEL%"

if not "%PATCHWARDEN_EXIT_CODE%"=="0" (
  echo.
  echo PatchWarden control exited with code %PATCHWARDEN_EXIT_CODE%.
  pause
)

exit /b %PATCHWARDEN_EXIT_CODE%
