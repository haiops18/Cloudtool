@echo off
setlocal
set "VITE_API_BASE_URL=/api/v1"
set "VITE_AGENT_API_BASE_URL=/agent-api/api/v1"
cd /d "%~dp0"
"C:\Program Files\nodejs\node.exe" "%~dp0node_modules\vite\bin\vite.js" --config vite.9999.config.ts --mode development --host 127.0.0.1 --port 9999 --strictPort
