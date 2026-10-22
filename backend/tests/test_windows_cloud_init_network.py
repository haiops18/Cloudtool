"""Run Windows PowerShell 5.1 with sandboxed files and mocked network cmdlets."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[2] / "APIdoc/cloud-init/windows-static-ip.ps1"
POWERSHELL = shutil.which("powershell") if os.name == "nt" else None
pytestmark = pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")

MOCKS = r"""
$script:Addresses = @()
$script:Routes = @()
$script:Dns = @{}
$script:Dhcp = @{}
$script:Mutations = 0
$script:FailedOnce = $false
$script:Users = @{}
$script:Groups = @{'S-1-5-32-544'=@(); 'S-1-5-32-545'=@()}
$script:CreatedUsers = 0
$script:RdpEnabled = $false
function Import-Module { [CmdletBinding()] param($Name) }
function netsh {
    $index = [int](($args | Where-Object { $_ -like 'name=*' }) -replace '^name=', '')
    $script:Dns[$index]=@()
    $global:LASTEXITCODE=0
}
function Get-LocalUser { [CmdletBinding()] param($Name); $script:Users[$Name] }
function New-LocalUser {
    param($Name, $Password, $Description)
    if ($script:Users.ContainsKey($Name)) { throw 'Duplicate user creation' }
    $script:CreatedUsers++
    $script:Users[$Name]=[pscustomobject]@{Name=$Name; SID="local-$Name"; Password='new'}
    $script:Users[$Name]
}
function Get-LocalGroupMember { param($SID); $script:Groups[$SID] }
function Add-LocalGroupMember {
    param($SID, $Member)
    if ($Member.SID -in $script:Groups[$SID].SID) { throw 'Duplicate group membership' }
    $script:Groups[$SID] += $Member
}
function Add-MockNic($index, $address, $prefix, $gateway) {
    $script:Addresses += [pscustomobject]@{InterfaceIndex=$index; IPAddress=$address; PrefixLength=$prefix; AddressState='Preferred'; PrefixOrigin='Dhcp'}
    $script:Dns[$index] = @('9.9.9.9')
    $script:Dhcp[$index] = 'Enabled'
    if ($gateway) {
        $script:Routes += [pscustomobject]@{InterfaceIndex=$index; DestinationPrefix='0.0.0.0/0'; NextHop=$gateway; RouteMetric=100; InterfaceMetric=10; Protocol='Dhcp'; Persistent=$false}
    }
}
function Get-NetIPAddress {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily)
    $script:Addresses | Where-Object { -not $PSBoundParameters.ContainsKey('InterfaceIndex') -or $_.InterfaceIndex -eq $InterfaceIndex }
}
function Get-NetRoute {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily, $DestinationPrefix, $PolicyStore)
    $script:Routes | Where-Object {
        (-not $PSBoundParameters.ContainsKey('InterfaceIndex') -or $_.InterfaceIndex -eq $InterfaceIndex) -and
        (-not $DestinationPrefix -or $_.DestinationPrefix -eq $DestinationPrefix) -and
        ($PolicyStore -ne 'PersistentStore' -or $_.Persistent) }
}
function Set-NetIPInterface {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily, $Dhcp)
    $script:Mutations++
    $script:Dhcp[$InterfaceIndex] = $Dhcp
    if ($Dhcp -eq 'Disabled') {
        $script:Routes = @($script:Routes | Where-Object { $_.InterfaceIndex -ne $InterfaceIndex -or $_.Protocol -ne 'Dhcp' })
        $script:Addresses = @($script:Addresses | Where-Object { $_.InterfaceIndex -ne $InterfaceIndex -or $_.PrefixOrigin -ne 'Dhcp' })
    }
}
function Get-NetIPInterface {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily)
    [pscustomobject]@{Dhcp=$script:Dhcp[$InterfaceIndex]}
}
function Remove-NetRoute {
    [CmdletBinding(SupportsShouldProcess)] param([Parameter(ValueFromPipeline)]$InputObject)
    process { $script:Routes = @($script:Routes | Where-Object { $_ -ne $InputObject }) }
}
function Remove-NetIPAddress {
    [CmdletBinding(SupportsShouldProcess)] param([Parameter(ValueFromPipeline)]$InputObject)
    process { $script:Addresses = @($script:Addresses | Where-Object { $_ -ne $InputObject }) }
}
function New-NetIPAddress {
    [CmdletBinding()] param($InterfaceIndex, $IPAddress, $PrefixLength)
    if ($Failure -in 'apply', 'static_restore' -and $InterfaceIndex -eq 7 -and -not $script:FailedOnce) { $script:FailedOnce=$true; throw 'Injected apply failure' }
    $script:Addresses += [pscustomobject]@{InterfaceIndex=$InterfaceIndex; IPAddress=$IPAddress; PrefixLength=$PrefixLength; AddressState='Preferred'; PrefixOrigin='Manual'}
}
function New-NetRoute {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily, $DestinationPrefix, $NextHop, $RouteMetric, $PolicyStore)
    $script:Routes += [pscustomobject]@{InterfaceIndex=$InterfaceIndex; DestinationPrefix=$DestinationPrefix; NextHop=$NextHop; RouteMetric=$RouteMetric; Protocol='NetMgmt'; Persistent=($PolicyStore -ne 'ActiveStore')}
}
function Get-NetAdapter {
    [CmdletBinding()] param($InterfaceIndex)
    foreach ($index in 42, 7, 93, 99) {
        [pscustomobject]@{Name="NIC-$index"; ifIndex=$index; InterfaceGuid=[guid]'00000000-0000-0000-0000-000000000001'}
    }
}
function Get-DnsClientServerAddress {
    [CmdletBinding()] param($InterfaceIndex, $AddressFamily)
    [pscustomobject]@{ServerAddresses=@($script:Dns[$InterfaceIndex])}
}
function Set-DnsClientServerAddress {
    [CmdletBinding()] param($InterfaceIndex, [AllowEmptyCollection()][string[]]$ServerAddresses, [switch]$ResetServerAddresses)
    if ($ResetServerAddresses) { $script:Dns[$InterfaceIndex]=@('9.9.9.9') }
    else { $script:Dns[$InterfaceIndex]=@($ServerAddresses) }
}
function Get-ItemProperty {
    [CmdletBinding()] param($LiteralPath, $Name)
    [pscustomobject]@{NameServer=$(if ($Failure -eq 'static_restore') {'4.4.4.4'} else {''}); ProductName=$(if ($Failure -eq 'home') {'Windows 10 Home'} else {'Windows Server 2019'})}
}
function Start-Sleep {
    param($Seconds)
    if ($Failure -eq 'delayed' -and -not $script:FailedOnce -and $Seconds -eq 2) {
        $script:FailedOnce=$true
        $script:Routes += [pscustomobject]@{InterfaceIndex=7; DestinationPrefix='0.0.0.0/0'; NextHop='171.253.171.254'; RouteMetric=100; Protocol='Dhcp'; Persistent=$false}
    }
}
function Set-ItemProperty { param($Path,$Name,$Value); $script:RdpEnabled=$true }
function Set-Service { param($Name,$StartupType) }
function Start-Service { param($Name) }
function Get-NetFirewallRule { [CmdletBinding()] param($Name) }
function Remove-NetFirewallRule { [CmdletBinding()] param() }
function New-NetFirewallRule { param($Name,$DisplayName,$Direction,$Action,$Protocol,$LocalPort,$Profile) }
"""


def run_script(tmp_path, elastic=True, monitor=True, failure="", fallback="", required_monitor=None, repeat=False, existing_users=False, missing_password=False, powershell=None, unresolved=False):
    source = TEMPLATE.read_text(encoding="utf-8")
    values = {"private_ip": "10.1.27.99" if fallback == "" else "", "local_gateway": "" if fallback == "default" else "10.1.27.97",
              "elastic_ip_enabled": str(elastic).lower(), "elastic_ip_address": "171.253.170.90" if elastic else "",
              "vpc_cidr": "10.1.27.0/24", "TELEPORT_ENABLE": str(monitor if required_monitor is None else required_monitor).lower(),
              "TP_MONITOR_IP": "10.129.26.204" if monitor or required_monitor else ""}
    if not unresolved:
        for name, value in values.items():
            source = source.replace("{{" + name + "}}", value)
    source = source.replace(r"C:\ProgramData\CloudTool", str(tmp_path))
    if not missing_password:
        source = source.replace("$AppPassword = ''", "$AppPassword = 'Test-App-Password1!'")
        source = source.replace("$VtsAdminPassword = ''", "$VtsAdminPassword = 'Test-Admin-Password1!'")
    setup = "$Failure='" + failure + "'\n" + MOCKS + "\nAdd-MockNic 42 '10.1.27.99' 27 '10.1.27.97'\n"
    if elastic:
        gateway = "''" if failure in ("missing_gateway", "delayed") else "'171.253.171.254'"
        setup += "Add-MockNic 7 '171.253.170.90' 22 " + gateway + "\n"
    if monitor:
        setup += "Add-MockNic 93 '10.129.26.204' 21 '10.129.24.1'\n"
    if failure == "ambiguous":
        setup += "Add-MockNic 88 '10.1.27.99' 27 '10.1.27.97'\n"
    # A fourth NIC must remain unchanged, including its DNS and DHCP state.
    setup += "Add-MockNic 99 '192.168.50.10' 24 ''\n"
    if existing_users:
        setup += """
foreach ($name in 'app', 'vts_admin') { $script:Users[$name]=[pscustomobject]@{Name=$name; SID="local-$name"; Password='original'} }
"""
    if failure == "off_subnet":
        setup += "$script:Addresses | Where-Object { $_.InterfaceIndex -eq 7 } | ForEach-Object { $_.PrefixLength=32 }\n"
    if failure == "static_restore":
        setup += """
foreach ($row in $script:Addresses | Where-Object { $_.InterfaceIndex -ne 99 }) { $row.PrefixOrigin='Manual'; $script:Dhcp[$row.InterfaceIndex]='Disabled'; $script:Dns[$row.InterfaceIndex]=@('4.4.4.4') }
foreach ($route in $script:Routes) { $route.Protocol='NetMgmt'; $route.Persistent=$true }
"""
    if failure == "verify":
        source = source.replace("if (Test-NetworkPlan $Plan)", "if ($false)")
    tail = r"""
} catch { $script:CapturedError=$_.Exception.Message }
$dnsOutput=@{}; $dhcpOutput=@{}
foreach ($key in $script:Dns.Keys) { $dnsOutput[$key.ToString()]=$script:Dns[$key] }
foreach ($key in $script:Dhcp.Keys) { $dhcpOutput[$key.ToString()]=$script:Dhcp[$key] }
[pscustomobject]@{Error=$script:CapturedError; Addresses=@($script:Addresses); Routes=@($script:Routes);
    Dns=$dnsOutput; Dhcp=$dhcpOutput; Mutations=$script:Mutations; Users=$script:Users; Groups=$script:Groups; CreatedUsers=$script:CreatedUsers; RdpEnabled=$script:RdpEnabled} | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath '__RESULT__' -Encoding UTF8
""".replace("__RESULT__", str(tmp_path / "result.json"))
    file = tmp_path / "mock-run.ps1"
    file.write_text(setup + "\ntry {\n" + source + ("\n" + source if repeat else "") + tail, encoding="utf-8-sig")
    result = subprocess.run([powershell or POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(file)],
                            capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads((tmp_path / "result.json").read_text(encoding="utf-8-sig"))
    assert data["Dhcp"]["99"] == "Enabled"
    assert data["Dns"]["99"] == ["9.9.9.9"]
    assert (tmp_path / "cloud-init/bootstrap.log").exists()
    return data


@pytest.mark.parametrize("elastic", [True, False])
@pytest.mark.parametrize("monitor", [True, False])
def test_all_nic_combinations(tmp_path, elastic, monitor):
    data = run_script(tmp_path, elastic, monitor)
    assert not data["Error"], data["Error"]
    indexes = {42} | ({7} if elastic else set()) | ({93} if monitor else set())
    addresses = {row["InterfaceIndex"]: row for row in data["Addresses"]}
    assert addresses[42]["IPAddress"] == "10.1.27.99" and addresses[42]["PrefixLength"] == 27
    assert all(data["Dhcp"][str(index)] == "Disabled" for index in indexes)
    default_index = 7 if elastic else 42
    defaults = [row for row in data["Routes"] if row["DestinationPrefix"] == "0.0.0.0/0"]
    assert len(defaults) == 1 and defaults[0]["InterfaceIndex"] == default_index
    assert defaults[0]["NextHop"] == ("171.253.171.254" if elastic else "10.1.27.97")
    assert all(row["Persistent"] for row in data["Routes"])
    assert data["Dns"][str(default_index)] == ["8.8.8.8", "1.1.1.1"]
    if elastic:
        assert addresses[7]["PrefixLength"] == 22
        assert data["Dns"]["42"] == []
        assert any(row["DestinationPrefix"] == "10.1.27.0/24" and row["InterfaceIndex"] == 42 and row["NextHop"] == "10.1.27.97" for row in data["Routes"])
    if monitor:
        assert addresses[93]["PrefixLength"] == 21 and data["Dns"]["93"] == []
        assert not any(row["InterfaceIndex"] == 93 for row in data["Routes"])


@pytest.mark.parametrize("fallback", ["gateway", "default"])
def test_local_only_detection_fallbacks(tmp_path, fallback):
    data = run_script(tmp_path, elastic=False, monitor=False, fallback=fallback)
    assert not data["Error"], data["Error"]


@pytest.mark.parametrize("failure", ["apply", "verify"])
def test_failure_restores_dhcp_and_dns_for_all_selected_nics(tmp_path, failure):
    data = run_script(tmp_path, failure=failure)
    assert data["Error"]
    assert all(value == "Enabled" for value in data["Dhcp"].values())
    assert all(value == ["9.9.9.9"] for value in data["Dns"].values())
    assert not data["Routes"]
    assert "ROLLBACK_RESTORED" in (tmp_path / "Logs/static-network-rdp.log").read_text(encoding="utf-8-sig")
    assert data["RdpEnabled"] and data["CreatedUsers"] == 2


@pytest.mark.parametrize("failure", ["missing_gateway", "ambiguous"])
def test_missing_or_ambiguous_network_never_mutates(tmp_path, failure):
    data = run_script(tmp_path, failure=failure)
    assert data["Error"] and data["Mutations"] == 0


def test_required_missing_monitor_never_mutates(tmp_path):
    data = run_script(tmp_path, monitor=False, required_monitor=True)
    assert data["Error"] and data["Mutations"] == 0


def test_waits_for_elastic_own_dhcp_gateway(tmp_path):
    data = run_script(tmp_path, failure="delayed")
    assert not data["Error"], data["Error"]


def test_rerun_keeps_static_addresses_and_routes_without_duplicates(tmp_path):
    data = run_script(tmp_path, repeat=True)
    assert not data["Error"], data["Error"]
    assert len(data["Addresses"]) == 4
    assert len(data["Routes"]) == 2
    assert data["CreatedUsers"] == 2
    assert [user["Name"] for user in data["Groups"]["S-1-5-32-544"]] == ["vts_admin"]
    assert [user["Name"] for user in data["Groups"]["S-1-5-32-545"]] == ["app"]


def test_off_subnet_elastic_gateway_has_persistent_on_link_host_route(tmp_path):
    data = run_script(tmp_path, failure="off_subnet")
    assert not data["Error"], data["Error"]
    assert any(route["DestinationPrefix"] == "171.253.171.254/32" and route["NextHop"] == "0.0.0.0"
               and route["InterfaceIndex"] == 7 and route["Persistent"] for route in data["Routes"])


def test_rollback_restores_original_static_addresses_routes_and_dns(tmp_path):
    data = run_script(tmp_path, failure="static_restore")
    assert data["Error"]
    assert len(data["Addresses"]) == 4
    assert len(data["Routes"]) == 3
    for index in (42, 7, 93):
        assert data["Dhcp"][str(index)] == "Disabled"
        assert data["Dns"][str(index)] == ["4.4.4.4"]
    assert all(route["Persistent"] for route in data["Routes"])


def test_existing_users_keep_passwords_and_receive_group_membership(tmp_path):
    data = run_script(tmp_path, existing_users=True, missing_password=True)
    assert not data["Error"], data["Error"]
    assert data["CreatedUsers"] == 0
    assert all(user["Password"] == "original" for user in data["Users"].values())
    assert [user["Name"] for user in data["Groups"]["S-1-5-32-544"]] == ["vts_admin"]


def test_missing_user_password_is_reported_after_network_and_rdp(tmp_path):
    data = run_script(tmp_path, missing_password=True)
    assert "Set the password" in data["Error"]
    assert data["CreatedUsers"] == 0
    assert data["RdpEnabled"]


def test_unrendered_optional_variables_keep_original_dhcp_fallback(tmp_path):
    data = run_script(tmp_path, elastic=False, monitor=False, unresolved=True)
    assert not data["Error"], data["Error"]
    assert data["Routes"][0]["NextHop"] == "10.1.27.97"


def test_32_bit_launcher_reexecutes_native_powershell(tmp_path):
    x86 = Path(os.environ["WINDIR"]) / "SysWOW64/WindowsPowerShell/v1.0/powershell.exe"
    if not x86.exists():
        pytest.skip("64-bit Windows required")
    data = run_script(tmp_path, powershell=str(x86))
    assert not data["Error"], data["Error"]
    log = (tmp_path / "cloud-init/bootstrap.log").read_text(encoding="utf-8-sig")
    assert "process64=False" in log and "process64=True" in log
    assert "BOOTSTRAP_SUCCESS" in log


def test_windows_home_skips_unsupported_rdp_without_blocking_network(tmp_path):
    data = run_script(tmp_path, failure="home")
    assert not data["Error"], data["Error"]
    assert not data["RdpEnabled"] and data["CreatedUsers"] == 2
    assert data["Dhcp"]["42"] == "Disabled"
