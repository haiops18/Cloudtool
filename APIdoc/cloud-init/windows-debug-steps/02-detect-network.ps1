#ps1
try {
    . (Join-Path $PSScriptRoot '_common.ps1')
    . (Join-Path $PSScriptRoot '_network.ps1')
    Import-Module NetTCPIP, DnsClient, NetAdapter -ErrorAction Stop
    Test-InputConfiguration
    Write-Host 'CURRENT IPv4 ADDRESSES'
    Get-NetIPAddress -AddressFamily IPv4 | Format-Table InterfaceIndex, InterfaceAlias, IPAddress, PrefixLength, AddressState -AutoSize | Out-Host
    Write-Host 'CURRENT DEFAULT ROUTES'
    Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Format-Table InterfaceIndex, NextHop, RouteMetric, Protocol -AutoSize | Out-Host
    $Plan = @(Get-NetworkPlan)
    if (-not $Plan.Count) { throw "Could not identify the required NICs/gateways: $NetworkWaitReason Check 00-config.ps1 against the inventory above." }
    Write-Host 'PROPOSED STATIC CONFIGURATION (NOT APPLIED)'
    $Plan | Format-Table Role, Index, Address, Prefix, Destination, Gateway -AutoSize | Out-Host
    $Plan | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $CloudInitDirectory 'step-02-network-plan.json') -Encoding UTF8

    Write-CloudToolLog 'STEP_02_SUCCESS'
} catch {
    $message = "STEP_ERROR $($_.Exception.Message) line=$($_.InvocationInfo.ScriptLineNumber) stack=$($_.ScriptStackTrace)"
    Write-Host $message -ForegroundColor Red
    if (Test-Path variable:LogFile) { Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $message }
    throw
}
