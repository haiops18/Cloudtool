#ps1
try {
    . (Join-Path $PSScriptRoot '_common.ps1')
    . (Join-Path $PSScriptRoot '_network.ps1')
    # Run from the VM console: updating the NIC can disconnect an RDP session.
    # Redetect current DHCP details instead of trusting the saved step-02 JSON.
    Invoke-StaticNetwork

    Write-CloudToolLog 'STEP_03_SUCCESS'
} catch {
    $message = "STEP_ERROR $($_.Exception.Message) line=$($_.InvocationInfo.ScriptLineNumber) stack=$($_.ScriptStackTrace)"
    Write-Host $message -ForegroundColor Red
    if (Test-Path variable:LogFile) { Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $message }
    if ($Changed) { Restore-Network }
    throw
}
