@echo off
setlocal

set "ROOT=%~dp0"
set "FRONTEND_DIR=%ROOT%frontend"

if not exist "%FRONTEND_DIR%\node_modules" (
  echo Frontend dependencies were not found:
  echo %FRONTEND_DIR%\node_modules
  pause
  exit /b 1
)

start "CloudTool Frontend - 5000" /D "%FRONTEND_DIR%" cmd /k "npm run dev -- --mode development --host localhost --port 5000"

echo CloudTool frontend is starting at http://localhost:5000
endlocal
