#ps1
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

try {
    . (Join-Path $PSScriptRoot '_common.ps1')
    Invoke-EnableRdp

    Write-CloudToolLog 'STEP_04_SUCCESS'
} catch {
    $message = "STEP_ERROR $($_.Exception.Message) line=$($_.InvocationInfo.ScriptLineNumber) stack=$($_.ScriptStackTrace)"
    Write-Host $message -ForegroundColor Red
    if (Test-Path variable:LogFile) { Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $message }
    throw
}
