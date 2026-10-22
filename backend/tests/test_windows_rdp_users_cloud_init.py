import json
import subprocess

import pytest
from test_windows_cloud_init_network import MOCKS, POWERSHELL, TEMPLATE

pytestmark = pytest.mark.skipif(not POWERSHELL, reason="Windows PowerShell required")
USER_TEMPLATE = TEMPLATE.with_name("windows-rdp-users.ps1")


@pytest.mark.parametrize("existing,configured,repeat", [(False, True, False), (False, True, True), (True, False, False), (False, False, False)])
def test_standalone_rdp_and_users_without_network_changes(tmp_path, existing, configured, repeat):
    source = USER_TEMPLATE.read_text(encoding="utf-8").replace(r"C:\ProgramData\CloudTool", str(tmp_path))
    if configured:
        source = source.replace("$AppPassword = ''", "$AppPassword = 'Test-App-Password1!'")
        source = source.replace("$VtsAdminPassword = ''", "$VtsAdminPassword = 'Test-Admin-Password1!'")
    setup = MOCKS + "\n$Failure=''\n"
    if existing:
        setup += "foreach ($name in 'app','vts_admin') { $script:Users[$name]=[pscustomobject]@{Name=$name; SID=\"local-$name\"; Password='original'} }\n"
    result_file = tmp_path / "result.json"
    tail = """
} catch { $script:CapturedError=$_.Exception.Message }
[pscustomobject]@{Error=$script:CapturedError; Mutations=$script:Mutations; Rdp=$script:RdpEnabled;
    Created=$script:CreatedUsers; Users=$script:Users; Groups=$script:Groups} | ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath '__RESULT__' -Encoding UTF8
""".replace("__RESULT__", str(result_file))
    runner = tmp_path / "runner.ps1"
    runner.write_text(setup + "\ntry {\n" + source + ("\n" + source if repeat else "") + tail, encoding="utf-8-sig")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(runner)],
                            capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(result_file.read_text(encoding="utf-8-sig"))
    assert data["Mutations"] == 0 and data["Rdp"]
    assert (tmp_path / "cloud-init/rdp-users.log").exists()
    if existing or configured:
        assert not data["Error"], data["Error"]
        assert data["Created"] == (0 if existing else 2)
        assert [user["Name"] for user in data["Groups"]["S-1-5-32-544"]] == ["vts_admin"]
        assert [user["Name"] for user in data["Groups"]["S-1-5-32-545"]] == ["app"]
        if existing:
            assert all(user["Password"] == "original" for user in data["Users"].values())
    else:
        assert "Set the password" in data["Error"] and data["Created"] == 0


@pytest.mark.parametrize("gateway_available", [True, False])
def test_network_detection_with_reported_vm_ips(tmp_path, gateway_available):
    source = TEMPLATE.read_text(encoding="utf-8")
    functions = source[source.index("function Test-IPv4Address"):source.index("# ==================== STATIC NETWORK")]
    setup = MOCKS + """
$Failure=''
$DesiredPrivateIP='10.60.160.44'; $DesiredGateway='10.60.160.1'
$ElasticEnabled='true'; $ElasticIP='171.254.93.162'; $VpcCidr='10.60.160.0/24'
$MonitorEnabled='false'; $MonitorIP=''
Add-MockNic 42 '10.60.160.44' 24 '10.60.160.1'
"""
    # Prefix/gateway below are synthetic DHCP details, not inferred VM values.
    setup += "Add-MockNic 7 '171.254.93.162' 22 " + ("'171.254.95.254'" if gateway_available else "''") + "\n"
    result_file = tmp_path / "plan.json"
    tail = """
$plan=@(Get-NetworkPlan)
[pscustomobject]@{Plan=$plan; Reason=$NetworkWaitReason; Mutations=$script:Mutations} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath '__RESULT__' -Encoding UTF8
""".replace("__RESULT__", str(result_file))
    runner = tmp_path / "network.ps1"
    runner.write_text(functions + setup + tail, encoding="utf-8-sig")
    result = subprocess.run([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(runner)],
                            capture_output=True, text=True, check=False, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    data = json.loads(result_file.read_text(encoding="utf-8-sig"))
    assert data["Mutations"] == 0
    if gateway_available:
        assert [nic["Role"] for nic in data["Plan"]] == ["local", "elastic"]
        assert data["Plan"][0]["Destination"] == "10.60.160.0/24"
        assert data["Plan"][0]["Gateway"] == "10.60.160.1"
        assert data["Plan"][1]["Destination"] == "0.0.0.0/0"
        assert data["Plan"][1]["Gateway"] == "171.254.95.254"
    else:
        assert not data["Plan"] and "Elastic NIC index=7 has no unique" in data["Reason"]
