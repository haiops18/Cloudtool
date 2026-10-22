@echo off
setlocal

set "ROOT=%~dp0"
set "AGENT_DIR=%ROOT%agent-service"
set "PYTHON=%ROOT%backend\.venv\Scripts\python.exe"
set "APP_ENV=development"

if not exist "%PYTHON%" (
  echo CloudTool backend virtual environment was not found:
  echo %PYTHON%
  pause
  exit /b 1
)

if not exist "%AGENT_DIR%\.env" (
  copy "%AGENT_DIR%\.env.example" "%AGENT_DIR%\.env" >nul
  echo Created agent-service\.env. Review it before production use.
)

start "CloudTool Agent Service - 8005" /D "%AGENT_DIR%" cmd /k ""%PYTHON%" -m uvicorn app.main:app --host 127.0.0.1 --port 8005"

echo CloudTool Agent Service is starting at http://127.0.0.1:8005
endlocal
