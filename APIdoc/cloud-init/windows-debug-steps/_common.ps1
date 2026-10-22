$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RootDirectory = 'C:\ProgramData\CloudTool'
$CloudInitDirectory = Join-Path $RootDirectory 'cloud-init'
$LogDirectory = Join-Path $RootDirectory 'Logs'
$BackupDirectory = Join-Path $RootDirectory 'Backups'
$LogFile = Join-Path $LogDirectory 'windows-debug-steps.log'
$BootstrapLog = Join-Path $CloudInitDirectory 'debug-bootstrap.log'
foreach ($directory in $CloudInitDirectory, $LogDirectory, $BackupDirectory) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
function Write-CloudToolLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') [cloudtool] $Message"
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $line
    Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value $line
    Write-Host $line
}

Write-CloudToolLog "DEBUG_START powershell=$($PSVersionTable.PSVersion) process64=$([Environment]::Is64BitProcess) language=$($ExecutionContext.SessionState.LanguageMode)"
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
    throw 'Use 64-bit Windows PowerShell (System32, or Sysnative from a 32-bit console).'
}
if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1+ is required.' }
. (Join-Path $PSScriptRoot '00-config.ps1')
$Snapshots = @()
$Changed = $false
