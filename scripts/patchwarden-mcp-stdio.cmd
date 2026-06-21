@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "PATCHWARDEN_CONFIG=%PROJECT_ROOT%\patchwarden.config.json"
set "PATCHWARDEN_TOOL_PROFILE=chatgpt_core"
cd /d "%PROJECT_ROOT%"
"node" "%PROJECT_ROOT%\dist\index.js"
