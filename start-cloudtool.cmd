@echo off
setlocal

set "ROOT=%~dp0"
call "%ROOT%start-backend.cmd"
if errorlevel 1 exit /b %errorlevel%

call "%ROOT%start-agent-service.cmd"
if errorlevel 1 exit /b %errorlevel%

call "%ROOT%start-frontend.cmd"
if errorlevel 1 exit /b %errorlevel%

echo CloudTool is starting...
echo Backend:  http://127.0.0.1:8003
echo Agent:    http://127.0.0.1:8005
echo Frontend: http://localhost:5000
endlocal
