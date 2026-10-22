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
$LogDirectory = Join-Path $RootDirectory 'Logs'
$BackupDirectory = Join-Path $RootDirectory 'Backups'
$LogFile = Join-Path $LogDirectory 'static-network-rdp.log'
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

# ==================== USER PASSWORDS (fill before deployment) ====================
$AppPassword = ''
$VtsAdminPassword = ''

$DesiredPrivateIP = '{{private_ip}}'
$DesiredGateway = '{{local_gateway}}'
$ElasticEnabled = '{{elastic_ip_enabled}}'
$ElasticIP = '{{elastic_ip_address}}'
$VpcCidr = '{{vpc_cidr}}'
$MonitorEnabled = '{{TELEPORT_ENABLE}}'
$MonitorIP = '{{TP_MONITOR_IP}}'
$Snapshots = @()
$Changed = $false

function Write-CloudToolLog {
    param([string]$Message)
    $line = "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK') [cloudtool] $Message"
    Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value $line
    Add-Content -LiteralPath $BootstrapLog -Encoding UTF8 -Value $line
    Write-Host $line
}
function Get-CloudValue {
    param([string]$Value)
    if ($Value -match '^\{\{[^{}]+\}\}$') { return '' }
    return $Value.Trim()
}
$DesiredPrivateIP = Get-CloudValue $DesiredPrivateIP
$DesiredGateway = Get-CloudValue $DesiredGateway
$ElasticIP = Get-CloudValue $ElasticIP
$VpcCidr = Get-CloudValue $VpcCidr
$MonitorIP = Get-CloudValue $MonitorIP
$ElasticEnabled = Get-CloudValue $ElasticEnabled
$MonitorEnabled = Get-CloudValue $MonitorEnabled
if (-not $ElasticEnabled) { $ElasticEnabled = 'false' }
if (-not $MonitorEnabled) { $MonitorEnabled = 'false' }

function Test-IPv4Address {
    param([string]$Address)
    if ($Address -notmatch '^(\d{1,3}\.){3}\d{1,3}$') { return $false }
    return @($Address.Split('.') | Where-Object { [int]$_ -gt 255 }).Count -eq 0
}
function Get-NetworkCidr {
    param([string]$Address, [int]$Prefix)
    $bytes = [System.Net.IPAddress]::Parse($Address).GetAddressBytes()
    for ($i = 0; $i -lt 4; $i++) {
        $bits = [Math]::Max(0, [Math]::Min(8, $Prefix - 8 * $i))
        $bytes[$i] = $bytes[$i] -band (256 - [Math]::Pow(2, 8 - $bits))
    }
    return "$($bytes -join '.')/$Prefix"
}
function Get-Gateway {
    param([int]$Index, [object[]]$Routes)
    $candidates = @($Routes | Where-Object { $_.InterfaceIndex -eq $Index -and
        $_.DestinationPrefix -eq '0.0.0.0/0' -and (Test-IPv4Address $_.NextHop) -and $_.NextHop -ne '0.0.0.0' } |
        Sort-Object @{Expression={if ($_.Protocol -eq 'Dhcp') {0} else {1}}}, RouteMetric)
    if (-not $candidates.Count) { return $null }
    $best = $candidates[0]
    $ties = @($candidates | Where-Object { ($_.Protocol -eq 'Dhcp') -eq ($best.Protocol -eq 'Dhcp') -and $_.RouteMetric -eq $best.RouteMetric } |
        Select-Object -ExpandProperty NextHop -Unique)
    if ($ties.Count -ne 1) { return $null }
    return $best.NextHop
}
function Find-Address {
    param([object[]]$Rows)
    # Refuse ambiguous matches instead of configuring the wrong NIC.
    if ($Rows.Count -ne 1) { return $null }
    return $Rows[0]
}
function Get-NetworkPlan {
    $script:NetworkWaitReason = ''
    $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
        $_.IPAddress -notmatch '^127\.|^169\.254\.' -and $_.AddressState -eq 'Preferred' })
    $routes = @(Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue)
    $elastic = $null; $monitor = $null; $local = $null
    if ($ElasticEnabled -eq 'true') {
        $elastic = Find-Address @($addresses | Where-Object { $_.IPAddress -eq $ElasticIP })
        if (-not $elastic) { return }
        $elasticGateway = Get-Gateway $elastic.InterfaceIndex $routes
        if (-not $elasticGateway) { $script:NetworkWaitReason = "Elastic NIC index=$($elastic.InterfaceIndex) has no unique DHCP/default gateway."; return }
    }
    if ($MonitorIP) {
        $monitor = Find-Address @($addresses | Where-Object { $_.IPAddress -eq $MonitorIP })
    }
    if ($MonitorEnabled -eq 'true' -and -not $monitor) { return }
    $available = @($addresses | Where-Object { $_.InterfaceIndex -ne $elastic.InterfaceIndex -and
        $_.InterfaceIndex -ne $monitor.InterfaceIndex })
    if ($DesiredPrivateIP) {
        $local = Find-Address @($available | Where-Object { $_.IPAddress -eq $DesiredPrivateIP })
    } elseif ($DesiredGateway) {
        $local = Find-Address @($available | Where-Object {
            (Get-NetworkCidr $_.IPAddress $_.PrefixLength) -eq (Get-NetworkCidr $DesiredGateway $_.PrefixLength) })
    } else {
        $default = $routes | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' -and
            $_.InterfaceIndex -in $available.InterfaceIndex } | Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
        $local = Find-Address @($available | Where-Object { $_.InterfaceIndex -eq $default.InterfaceIndex })
    }
    if (-not $local -or ($elastic -and $monitor -and $elastic.InterfaceIndex -eq $monitor.InterfaceIndex)) { return }
    $localGateway = if ($DesiredGateway) { $DesiredGateway } else { Get-Gateway $local.InterfaceIndex $routes }
    if (-not $localGateway) { return }
    [pscustomobject]@{ Role='local'; Index=$local.InterfaceIndex; Address=$local.IPAddress; Prefix=$local.PrefixLength
        Destination=$(if ($elastic) {$VpcCidr} else {'0.0.0.0/0'}); Gateway=$localGateway }
    if ($elastic) {
        [pscustomobject]@{ Role='elastic'; Index=$elastic.InterfaceIndex; Address=$elastic.IPAddress; Prefix=$elastic.PrefixLength
            Destination='0.0.0.0/0'; Gateway=$elasticGateway }
    }
    if ($monitor) {
        [pscustomobject]@{ Role='monitor'; Index=$monitor.InterfaceIndex; Address=$monitor.IPAddress; Prefix=$monitor.PrefixLength
            Destination=''; Gateway='' }
    }
}
function Clear-Network {
    param([int]$Index)
    # Remove static routes from BOTH stores so old defaults cannot return on reboot.
    # Connected routes are managed automatically when addresses change.
    foreach ($store in 'PersistentStore', 'ActiveStore') {
        Get-NetRoute -InterfaceIndex $Index -AddressFamily IPv4 -PolicyStore $store -ErrorAction SilentlyContinue |
            Where-Object { $_.Protocol -ne 'Local' } | Remove-NetRoute -Confirm:$false
    }
    Get-NetIPAddress -InterfaceIndex $Index -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notmatch '^127\.' } | Remove-NetIPAddress -Confirm:$false
}
function Add-Route {
    param([int]$Index, [string]$Destination, [string]$Gateway, [int]$Metric = 10)
    # Omitting PolicyStore writes both the active and persistent stores.
    New-NetRoute -InterfaceIndex $Index -AddressFamily IPv4 -DestinationPrefix $Destination -NextHop $Gateway -RouteMetric $Metric | Out-Null
}
function Test-NetworkPlan {
    param([object[]]$Plan)
    foreach ($nic in $Plan) {
        if ((Get-NetIPInterface -InterfaceIndex $nic.Index -AddressFamily IPv4).Dhcp -ne 'Disabled') { return $false }
        $address = @(Get-NetIPAddress -InterfaceIndex $nic.Index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
            $_.IPAddress -eq $nic.Address -and $_.PrefixLength -eq $nic.Prefix -and $_.AddressState -eq 'Preferred' })
        if ($address.Count -ne 1) { return $false }
        if ($nic.Destination) {
            $route = @(Get-NetRoute -InterfaceIndex $nic.Index -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
                $_.DestinationPrefix -eq $nic.Destination -and $_.NextHop -eq $nic.Gateway })
            if (-not $route.Count) { return $false }
            $savedRoute = @(Get-NetRoute -InterfaceIndex $nic.Index -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue | Where-Object {
                $_.DestinationPrefix -eq $nic.Destination -and $_.NextHop -eq $nic.Gateway })
            if (-not $savedRoute.Count) { return $false }
        }
        $dns = @(Get-DnsClientServerAddress -InterfaceIndex $nic.Index -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses)
        $expectedDns = if ($nic.Destination -eq '0.0.0.0/0') { '8.8.8.8,1.1.1.1' } else { '' }
        if (($dns -join ',') -ne $expectedDns) { return $false }
    }
    $defaultNic = $Plan | Where-Object { $_.Destination -eq '0.0.0.0/0' }
    $defaults = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Where-Object { $_.InterfaceIndex -in $Plan.Index })
    return $defaults.Count -eq 1 -and $defaults[0].InterfaceIndex -eq $defaultNic.Index -and $defaults[0].NextHop -eq $defaultNic.Gateway
}
function Restore-Network {
    foreach ($saved in $Snapshots) {
        try {
            Set-NetIPInterface -InterfaceIndex $saved.Index -AddressFamily IPv4 -Dhcp Disabled
            Clear-Network $saved.Index
            foreach ($address in $saved.Addresses | Where-Object { $_.PrefixOrigin -eq 'Manual' }) {
                New-NetIPAddress -InterfaceIndex $saved.Index -IPAddress $address.IPAddress -PrefixLength $address.PrefixLength | Out-Null
            }
            foreach ($route in $saved.Routes | Where-Object { $_.Protocol -ne 'Dhcp' -and $_.Protocol -ne 'Local' }) {
                $persistent = @($saved.PersistentRoutes | Where-Object { $_.DestinationPrefix -eq $route.DestinationPrefix -and $_.NextHop -eq $route.NextHop })
                $parameters = @{InterfaceIndex=$saved.Index; AddressFamily='IPv4'; DestinationPrefix=$route.DestinationPrefix
                    NextHop=$route.NextHop; RouteMetric=$route.RouteMetric}
                if (-not $persistent.Count) { $parameters.PolicyStore = 'ActiveStore' }
                New-NetRoute @parameters | Out-Null
            }
            Set-NetIPInterface -InterfaceIndex $saved.Index -AddressFamily IPv4 -Dhcp $saved.Dhcp
            if ($saved.StaticDns) {
                Set-DnsClientServerAddress -InterfaceIndex $saved.Index -ServerAddresses $saved.Dns
            } else {
                Set-DnsClientServerAddress -InterfaceIndex $saved.Index -ResetServerAddresses
            }
            Write-CloudToolLog "ROLLBACK_RESTORED index=$($saved.Index) dhcp=$($saved.Dhcp)"
        } catch { Write-CloudToolLog "ROLLBACK_FAILED index=$($saved.Index) $($_.Exception.Message)" }
    }
}

# ==================== STATIC NETWORK ====================
function Invoke-StaticNetwork {
    Import-Module NetTCPIP, DnsClient, NetAdapter -ErrorAction Stop
    $script:Snapshots = @()
    $script:Changed = $false
    if ($ElasticEnabled -notin 'true', 'false') { throw 'elastic_ip_enabled must be true or false.' }
    foreach ($value in $DesiredPrivateIP, $DesiredGateway, $MonitorIP) {
        if ($value -and -not (Test-IPv4Address $value)) { throw "Invalid IPv4 variable: $value" }
    }
    if ($MonitorEnabled -eq 'true' -and -not $MonitorIP) { throw 'Monitor IP is required.' }
    if ($ElasticEnabled -eq 'true') {
        if (-not (Test-IPv4Address $ElasticIP) -or -not $DesiredGateway) { throw 'Elastic IP and local gateway are required.' }
        if ($VpcCidr -notmatch '^(.+)/([0-9]|[12][0-9]|3[0-2])$' -or -not (Test-IPv4Address $Matches[1])) { throw 'Invalid vpc_cidr.' }
        $VpcCidr = Get-NetworkCidr $Matches[1] ([int]$Matches[2])
        if ($VpcCidr -eq '0.0.0.0/0' -or $ElasticIP -in $DesiredPrivateIP, $MonitorIP) { throw 'VPC route or NIC addresses are invalid.' }
    }
    Start-Sleep -Seconds 30
    $Plan = @()
    for ($attempt = 1; $attempt -le 90; $attempt++) {
        $Plan = @(Get-NetworkPlan)
        if ($Plan.Count) { break }
        if ($attempt -eq 1 -or $attempt % 10 -eq 0) { Write-CloudToolLog "WAIT NIC detection $attempt/90" }
        if ($attempt -lt 90) { Start-Sleep -Seconds 2 }
    }
    if (-not $Plan.Count) { throw 'Required NICs or DHCP gateways were not available after 180 seconds.' }
    foreach ($nic in $Plan) {
        # Filter the result instead of using newer Get-NetAdapter parameter sets.
        $adapter = Get-NetAdapter | Where-Object { $_.ifIndex -eq $nic.Index } | Select-Object -First 1
        if (-not $adapter) { throw "Adapter index $($nic.Index) was not found." }
        $registry = "HKLM:\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\$(([guid]$adapter.InterfaceGuid).ToString('B'))"
        $script:Snapshots += [pscustomobject]@{
            Index=$nic.Index; Adapter=$adapter.Name
            Dhcp=(Get-NetIPInterface -InterfaceIndex $nic.Index -AddressFamily IPv4).Dhcp.ToString()
            Addresses=@(Get-NetIPAddress -InterfaceIndex $nic.Index -AddressFamily IPv4 |
                Select-Object IPAddress, PrefixLength, PrefixOrigin)
            Routes=@(Get-NetRoute -InterfaceIndex $nic.Index -AddressFamily IPv4 -ErrorAction SilentlyContinue |
                Select-Object DestinationPrefix, NextHop, RouteMetric, Protocol)
            PersistentRoutes=@(Get-NetRoute -InterfaceIndex $nic.Index -AddressFamily IPv4 -PolicyStore PersistentStore -ErrorAction SilentlyContinue |
                Select-Object DestinationPrefix, NextHop, RouteMetric, Protocol)
            Dns=@(Get-DnsClientServerAddress -InterfaceIndex $nic.Index -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses)
            StaticDns=[bool](Get-ItemProperty -LiteralPath $registry -Name NameServer -ErrorAction SilentlyContinue).NameServer
        }
        Write-CloudToolLog "NIC_READY role=$($nic.Role) index=$($nic.Index) address=$($nic.Address)/$($nic.Prefix) route=$($nic.Destination) gateway=$($nic.Gateway)"
    }
    $backupFile = Join-Path $BackupDirectory "network-$(Get-Date -Format 'yyyyMMddTHHmmss')-$([guid]::NewGuid().ToString('N')).json"
    $Snapshots | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $backupFile -Encoding UTF8
    Write-CloudToolLog "NETWORK_BACKUP path=$backupFile"
    $script:Changed = $true
    foreach ($nic in $Plan) {
        Set-NetIPInterface -InterfaceIndex $nic.Index -AddressFamily IPv4 -Dhcp Disabled
        Clear-Network $nic.Index
        New-NetIPAddress -InterfaceIndex $nic.Index -IPAddress $nic.Address -PrefixLength $nic.Prefix | Out-Null
        if ($nic.Destination) {
            # Windows equivalent of netplan on-link for an off-subnet gateway.
            if ((Get-NetworkCidr $nic.Address $nic.Prefix) -ne (Get-NetworkCidr $nic.Gateway $nic.Prefix)) {
                Add-Route $nic.Index "$($nic.Gateway)/32" '0.0.0.0'
            }
            Add-Route $nic.Index $nic.Destination $nic.Gateway
            Write-CloudToolLog "ROUTE_SET role=$($nic.Role) index=$($nic.Index) destination=$($nic.Destination) gateway=$($nic.Gateway) metric=10"
        }
        if ($nic.Destination -eq '0.0.0.0/0') {
            Set-DnsClientServerAddress -InterfaceIndex $nic.Index -ServerAddresses @('8.8.8.8', '1.1.1.1')
        } else {
            # Explicitly clear DNS; empty ServerAddresses can reset to DHCP on
            # some Windows builds. netsh is included with all supported images.
            $dnsResult = netsh interface ipv4 set dnsservers "name=$($nic.Index)" source=static address=none validate=no 2>&1
            if ($LASTEXITCODE -ne 0) { throw "Could not clear DNS on index $($nic.Index): $dnsResult" }
        }
    }
    $verified = $false
    for ($attempt = 1; $attempt -le 15; $attempt++) {
        if (Test-NetworkPlan $Plan) { $verified = $true; break }
        Start-Sleep -Seconds 2 # Allow Windows Duplicate Address Detection to finish.
    }
    if (-not $verified) { throw 'Static address, DNS or route verification failed.' }
    if ($ElasticEnabled -eq 'true') {
        Write-CloudToolLog "LOCAL_VPC_ROUTE_VERIFIED destination=$VpcCidr gateway=$DesiredGateway default_route=Elastic_only"
    }
    $script:Changed = $false
    Write-CloudToolLog 'STATIC_NETWORK_SUCCESS'

}

# ==================== ENABLE RDP ====================
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

# ==================== LOCAL USERS ====================
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
    @{ Name='NETWORK'; Action={ Invoke-StaticNetwork } },
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
        if ($stage.Name -eq 'NETWORK' -and $Changed) { Restore-Network }
    }
}
if ($Failures.Count) {
    Write-CloudToolLog "BOOTSTRAP_FAILED stages=$($Failures.Count)"
    throw ($Failures -join '; ')
}
Write-CloudToolLog 'BOOTSTRAP_SUCCESS'
