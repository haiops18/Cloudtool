@echo off
setlocal

set "ROOT=%~dp0"
set "BACKEND_DIR=%ROOT%backend"
set "PYTHON=%BACKEND_DIR%\.venv\Scripts\python.exe"
set "APP_ENV=development"

if not exist "%PYTHON%" (
  echo Backend virtual environment was not found:
  echo %PYTHON%
  pause
  exit /b 1
)

start "CloudTool Backend - 8003" /D "%BACKEND_DIR%" cmd /k ""%PYTHON%" -m uvicorn app.terraform_app:app --host 127.0.0.1 --port 8003 --reload"

echo CloudTool backend is starting at http://127.0.0.1:8003
endlocal
