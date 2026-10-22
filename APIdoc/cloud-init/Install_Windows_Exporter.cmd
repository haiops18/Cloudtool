@echo off
setlocal EnableExtensions

REM Cai Prometheus windows_exporter x64. Chay file nay bang CMD "Run as administrator".
REM Metrics: http://localhost:9182/metrics

set "EXPORTER_VERSION=0.31.8"
set "EXPORTER_PORT=9182"
set "SERVICE_NAME=windows_exporter"
set "FIREWALL_RULE_NAME=Prometheus windows_exporter (TCP 9182) - Remote monitoring"
set "MSI_FILE=%TEMP%\windows_exporter-%EXPORTER_VERSION%-amd64.msi"
set "DOWNLOAD_URL=https://github.com/prometheus-community/windows_exporter/releases/download/v%EXPORTER_VERSION%/windows_exporter-%EXPORTER_VERSION%-amd64.msi"

fltmc >nul 2>&1
if errorlevel 1 (
    echo ERROR: Hay mo Command Prompt bang "Run as administrator", sau do chay lai file nay.
    exit /b 1
)

set "IS_64BIT=0"
if /I "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "IS_64BIT=1"
if /I "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "IS_64BIT=1"
if "%IS_64BIT%"=="0" (
    echo ERROR: Script nay dung goi cai dat Windows x64.
    exit /b 1
)

sc query "%SERVICE_NAME%" >nul 2>&1
set "SC_EXIT=%ERRORLEVEL%"
if "%SC_EXIT%"=="0" goto :configure_firewall
if not "%SC_EXIT%"=="1060" (
    echo ERROR: Khong kiem tra duoc service %SERVICE_NAME%. Ma loi: %SC_EXIT%
    exit /b %SC_EXIT%
)

echo ==^> Dang tai windows_exporter %EXPORTER_VERSION%...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%DOWNLOAD_URL%' -OutFile '%MSI_FILE%'"
if errorlevel 1 (
    echo ERROR: Khong tai duoc goi cai dat tu GitHub.
    exit /b 1
)

echo ==^> Dang cai windows_exporter...
msiexec.exe /i "%MSI_FILE%" /qn /norestart LISTEN_PORT=%EXPORTER_PORT%
set "MSI_EXIT=%ERRORLEVEL%"
del /q "%MSI_FILE%" >nul 2>&1
if not "%MSI_EXIT%"=="0" if not "%MSI_EXIT%"=="3010" (
    echo ERROR: Cai dat MSI that bai. Ma loi: %MSI_EXIT%
    exit /b %MSI_EXIT%
)

:configure_firewall
REM Mo TCP 9182 cho node Prometheus o bat ky profile mang va IP nguon nao.
REM Neu can gioi han, thay remoteip=any bang IP/CIDR cua node Prometheus.
netsh advfirewall firewall show rule name="%FIREWALL_RULE_NAME%" | findstr /I /C:"Rule Name" >nul
if errorlevel 1 (
    netsh advfirewall firewall add rule name="%FIREWALL_RULE_NAME%" dir=in action=allow protocol=TCP localport=%EXPORTER_PORT% profile=any remoteip=any >nul
)

:already_installed
echo ==^> Dam bao service dang chay...
sc start "%SERVICE_NAME%" >nul 2>&1

echo ==^> Kiem tra metrics...
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:%EXPORTER_PORT%/health' -TimeoutSec 15; if ($r.StatusCode -ne 200) { exit 1 } } catch { exit 1 }"
if errorlevel 1 (
    echo ERROR: Service chua san sang. Kiem tra bang: sc query %SERVICE_NAME%
    exit /b 1
)

echo.
echo SUCCESS: windows_exporter da chay.
echo Metrics: http://^<IP-Windows^>:%EXPORTER_PORT%/metrics
echo Service: %SERVICE_NAME%
exit /b 0
