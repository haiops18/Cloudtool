#ps1
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


try {
    . (Join-Path $PSScriptRoot '_common.ps1')
    Invoke-LocalUsers

    Write-CloudToolLog 'STEP_05_SUCCESS'
} catch {
    $message = "STEP_ERROR $($_.Exception.Message) line=$($_.InvocationInfo.ScriptLineNumber) stack=$($_.ScriptStackTrace)"
    Write-Host $message -ForegroundColor Red
    if (Test-Path variable:LogFile) { Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $message }
    throw
}
