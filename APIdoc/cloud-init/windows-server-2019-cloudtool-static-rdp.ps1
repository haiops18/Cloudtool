#ps1
# Cloudbase-Init user-data for Windows Server 2019.
# It keeps the current DHCP IPv4 address, makes it static, and enables RDP.
# Optional CloudTool variables: {{private_ip}}, {{local_gateway}}.
# A valid private_ip/local_gateway is used as-is; an empty value falls back to
# the address/gateway currently supplied by DHCP.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$LogDirectory = 'C:\ProgramData\CloudTool\Logs'
$BackupDirectory = 'C:\ProgramData\CloudTool\Backups'
$LogFile = Join-Path $LogDirectory 'static-network-rdp.log'
$DesiredPrivateIP = '{{private_ip}}'
$DesiredGateway = '{{local_gateway}}'

New-Item -ItemType Directory -Force -Path $LogDirectory, $BackupDirectory | Out-Null

function Write-CloudToolLog {
    param([string]$Message)
    "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') [cloudtool] $Message" |
        Tee-Object -FilePath $LogFile -Append
}

function Test-IPv4Address {
    param([string]$Address)
    $parsed = [System.Net.IPAddress]::None
    return [System.Net.IPAddress]::TryParse($Address, [ref]$parsed) -and
        $parsed.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

try {
    # Cloudbase-Init can begin before the virtual NIC receives DHCP details.
    Start-Sleep -Seconds 30
    $defaultRoute = $null
    $ipv4 = $null
    for ($attempt = 1; $attempt -le 90; $attempt++) {
        $defaultRoute = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
            Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' } |
            Sort-Object RouteMetric, InterfaceMetric |
            Select-Object -First 1
        if ($defaultRoute) {
            $ipv4 = Get-NetIPAddress -InterfaceIndex $defaultRoute.ifIndex -AddressFamily IPv4 |
                Where-Object { $_.IPAddress -notmatch '^127\.|^169\.254\.' } |
                Select-Object -First 1
        }
        if ($defaultRoute -and $ipv4) { break }
        if ($attempt -eq 1 -or $attempt % 10 -eq 0) {
            Write-CloudToolLog "WAIT attempt=$attempt/90 route=$($null -ne $defaultRoute) ip=$($null -ne $ipv4)"
        }
        Start-Sleep -Seconds 2
    }
    if (-not $defaultRoute -or -not $ipv4) {
        throw 'No DHCP IPv4 address and default gateway were available after 180 seconds.'
    }

    $interfaceIndex = $defaultRoute.ifIndex
    $adapter = Get-NetAdapter -InterfaceIndex $interfaceIndex
    $address = if (Test-IPv4Address $DesiredPrivateIP) { $DesiredPrivateIP } else { $ipv4.IPAddress }
    $prefixLength = $ipv4.PrefixLength
    $gateway = if (Test-IPv4Address $DesiredGateway) { $DesiredGateway } else { $defaultRoute.NextHop }
    $addressSource = if (Test-IPv4Address $DesiredPrivateIP) { 'variable' } else { 'dhcp' }
    $gatewaySource = if (Test-IPv4Address $DesiredGateway) { 'variable' } else { 'dhcp' }
    Write-CloudToolLog "NETWORK_DETECTED adapter=$($adapter.Name) index=$interfaceIndex address=$address/$prefixLength address_source=$addressSource gateway=$gateway gateway_source=$gatewaySource"

    # Do not use the `K` format here: its +07:00 offset contains ':' and is
    # invalid in Windows file names. Keep this timestamp filesystem-safe.
    $timestamp = Get-Date -Format 'yyyyMMddTHHmmss'
    $backupFile = Join-Path $BackupDirectory "network-$timestamp.json"
    [pscustomobject]@{
        captured_at = (Get-Date).ToString('o')
        adapter = $adapter | Select-Object Name, InterfaceDescription, ifIndex, MacAddress, Status
        ipv4 = Get-NetIPAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 |
            Select-Object IPAddress, PrefixLength, PrefixOrigin, SuffixOrigin
        routes = Get-NetRoute -InterfaceIndex $interfaceIndex -AddressFamily IPv4 |
            Select-Object DestinationPrefix, NextHop, RouteMetric, Protocol
    } | ConvertTo-Json -Depth 5 | Set-Content -Path $backupFile -Encoding UTF8
    Write-CloudToolLog "NETWORK_BACKUP path=$backupFile"

    # Remove only IPv4 addresses and default routes on the selected default NIC.
    # This avoids modifying unrelated management, monitor, or secondary NICs.
    Set-NetIPInterface -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -Dhcp Disabled
    # Disabling DHCP often removes its default route immediately. Treat an
    # already-absent route as expected, not as a terminating error.
    $existingDefaultRoutes = @(
        Get-NetRoute -InterfaceIndex $interfaceIndex -AddressFamily IPv4 `
            -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue
    )
    if ($existingDefaultRoutes.Count -gt 0) {
        $existingDefaultRoutes | Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
    }
    # As with the route, disabling DHCP can remove the leased address before
    # this query runs. The desired address was captured above, so an empty
    # result here is safe and we can proceed directly to New-NetIPAddress.
    $existingIPv4Addresses = @(
        Get-NetIPAddress -InterfaceIndex $interfaceIndex -AddressFamily IPv4 `
            -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notmatch '^127\.' }
    )
    if ($existingIPv4Addresses.Count -gt 0) {
        $existingIPv4Addresses | Remove-NetIPAddress -Confirm:$false -ErrorAction Stop
    }

    New-NetIPAddress -InterfaceIndex $interfaceIndex -IPAddress $address -PrefixLength $prefixLength -DefaultGateway $gateway | Out-Null
    Set-DnsClientServerAddress -InterfaceIndex $interfaceIndex -ServerAddresses @('8.8.8.8', '1.1.1.1')

    $verifiedRoute = Get-NetRoute -InterfaceIndex $interfaceIndex -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
        Where-Object { $_.NextHop -eq $gateway } |
        Select-Object -First 1
    if (-not $verifiedRoute) {
        throw "Static-network verification failed: default gateway $gateway was not installed."
    }
    Write-CloudToolLog "STATIC_NETWORK_SUCCESS adapter=$($adapter.Name) address=$address/$prefixLength gateway=$gateway"

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
catch {
    Write-CloudToolLog "ERROR $($_.Exception.Message)"
    throw
}
