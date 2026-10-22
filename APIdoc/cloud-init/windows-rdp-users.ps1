#ps1
# Cloudbase-Init / Windows 10, Windows 11 and Windows Server 2019+.
# Run with native Windows PowerShell 5.1 (64-bit on a 64-bit OS).
# Elastic: default route + DNS. Local: VPC route when Elastic is enabled,
# otherwise default route + DNS. Monitor: static address, no gateway/DNS.
# Startup/stage errors: C:\ProgramData\CloudTool\cloud-init\bootstrap.log
# Optional template variables left unresolved fall back to DHCP/local-only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$RootDirectory = 'C:\ProgramData\CloudTool'
$CloudInitDirectory = Join-Path $RootDirectory 'cloud-init'
$LogDirectory = $CloudInitDirectory
$BackupDirectory = Join-Path $RootDirectory 'Backups'
$LogFile = Join-Path $LogDirectory 'rdp-users.log'
$BootstrapLog = Join-Path $CloudInitDirectory 'bootstrap.log'
# Bootstrap logging must work before modules, variable validation or NIC detection.
try {
    foreach ($directory in $CloudInitDirectory, $LogDirectory, $BackupDirectory) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value "$(Get-Date -Format o) START version=windows-network-v3 powershell=$($PSVersionTable.PSVersion) process64=$([Environment]::Is64BitProcess) os64=$([Environment]::Is64BitOperatingSystem) language=$($ExecutionContext.SessionState.LanguageMode)"
    # Covers manual execution and older Cloudbase-Init agents that ignore sysnative.
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
        if (-not $PSCommandPath) { throw 'Save this script as a .ps1 file and run it in 64-bit Windows PowerShell.' }
        $nativePowerShell = Join-Path $env:WINDIR 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
        & $nativePowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $PSCommandPath
        exit $LASTEXITCODE
    }
    if ($PSVersionTable.PSVersion -lt [version]'5.1') { throw 'Windows PowerShell 5.1 or later is required.' }
} catch {
    $message = "$(Get-Date -Format o) BOOTSTRAP_ERROR $($_.Exception.Message)"
    if (Test-Path -LiteralPath $CloudInitDirectory) { Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value $message }
    Write-Error $message
    throw
}

$AppPassword = ''
$VtsAdminPassword = ''
function Write-CloudToolLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') [cloudtool] $Message"
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $line
    Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value $line
    Write-Host $line
}
function Invoke-EnableRdp {
    # Home editions do not provide an RDP host; keep other stages working.
    $productName = (Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -Name ProductName -ErrorAction SilentlyContinue).ProductName
    if ($productName -match 'Windows (10|11).*Home') {
        Write-CloudToolLog 'RDP_SKIPPED Windows Home does not support an RDP host.'
        return
    }
    # Enable RDP at the OS level and create a language-independent firewall
    # rule. Internet access still requires an Elastic IP and Cloud Security
    # Group rule allowing TCP/3389 from trusted source addresses.
    Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -Name 'fDenyTSConnections' -Value 0
    Set-Service -Name 'TermService' -StartupType Automatic
    Start-Service -Name 'TermService'
    Get-NetFirewallRule -Name 'CloudTool-Allow-RDP-TCP-3389' -ErrorAction SilentlyContinue |
        Remove-NetFirewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name 'CloudTool-Allow-RDP-TCP-3389' -DisplayName 'CloudTool Allow RDP TCP 3389' `
        -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3389 -Profile Any | Out-Null
    Write-CloudToolLog 'RDP_SUCCESS service=TermService firewall=CloudTool-Allow-RDP-TCP-3389'

}

function Invoke-LocalUsers {
    Import-Module Microsoft.PowerShell.LocalAccounts -ErrorAction Stop
    # Required only when the account does not exist. Existing passwords stay intact.
    $LocalUsers = @(
        @{ Name='app'; Password=$AppPassword; GroupSid='S-1-5-32-545' },       # Users
        @{ Name='vts_admin'; Password=$VtsAdminPassword; GroupSid='S-1-5-32-544' } # Administrators
    )
    # Group SIDs work on Windows installations in any language.
    $userErrors = @()
    foreach ($entry in $LocalUsers) {
        try {
        $user = Get-LocalUser -Name $entry.Name -ErrorAction SilentlyContinue
        if (-not $user) {
            if ([string]::IsNullOrWhiteSpace($entry.Password)) {
                throw "Set the password in LOCAL USERS before creating '$($entry.Name)'."
            }
            $password = ConvertTo-SecureString $entry.Password -AsPlainText -Force
            $user = New-LocalUser -Name $entry.Name -Password $password -Description 'CloudTool local account'
            Write-CloudToolLog "USER_CREATED name=$($entry.Name)"
        } else {
            Write-CloudToolLog "USER_EXISTS name=$($entry.Name) password_unchanged=true"
        }
        $members = @(Get-LocalGroupMember -SID $entry.GroupSid)
        if ($user.SID -notin $members.SID) {
            Add-LocalGroupMember -SID $entry.GroupSid -Member $user
            Write-CloudToolLog "USER_GROUP_ADDED name=$($entry.Name) group_sid=$($entry.GroupSid)"
        }
    }
        catch {
            $userErrors += "$($entry.Name): $($_.Exception.Message)"
            Write-CloudToolLog "USER_ERROR name=$($entry.Name) $($_.Exception.Message)"
        }
    }
    if ($userErrors.Count) { throw ($userErrors -join '; ') }
    Write-CloudToolLog 'LOCAL_USERS_SUCCESS'
    # ==================== END LOCAL USERS ====================
}

# Each stage reports its own failure; network errors must not block RDP.
$Failures = @()
foreach ($stage in @(
    @{ Name='RDP'; Action={ Invoke-EnableRdp } },
    @{ Name='LOCAL_USERS'; Action={ Invoke-LocalUsers } }
)) {
    try {
        Write-CloudToolLog "STAGE_START $($stage.Name)"
        & $stage.Action
        Write-CloudToolLog "STAGE_SUCCESS $($stage.Name)"
    } catch {
        $failure = "$($stage.Name): $($_.Exception.Message)"
        $Failures += $failure
        Write-CloudToolLog "STAGE_ERROR $failure line=$($_.InvocationInfo.ScriptLineNumber)"
    }
}
if ($Failures.Count) {
    Write-CloudToolLog "BOOTSTRAP_FAILED stages=$($Failures.Count)"
    throw ($Failures -join '; ')
}
Write-CloudToolLog 'BOOTSTRAP_SUCCESS'
