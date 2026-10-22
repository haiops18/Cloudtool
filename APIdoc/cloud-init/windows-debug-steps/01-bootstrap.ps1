#ps1
# Minimal independent probe: no shared scripts, config, networking or account modules.
$ErrorActionPreference = 'Stop'
$directory = 'C:\ProgramData\CloudTool\cloud-init'
Write-Host 'STEP_01_STARTED'
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$message = "$(Get-Date -Format o) STEP_01_SUCCESS powershell=$($PSVersionTable.PSVersion) process64=$([Environment]::Is64BitProcess) language=$($ExecutionContext.SessionState.LanguageMode)"
$message | Set-Content -LiteralPath (Join-Path $directory 'step-01-bootstrap.log') -Encoding UTF8
Write-Host $message
