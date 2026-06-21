@echo off
setlocal
set "PROJECT_ROOT=%~dp0.."
set "SAFE_BIFROST_CONFIG=%PROJECT_ROOT%\safe-bifrost.config.json"
set "SAFE_BIFROST_TOOL_PROFILE=chatgpt_core"
cd /d "%PROJECT_ROOT%"
"node" "%PROJECT_ROOT%\dist\index.js"
