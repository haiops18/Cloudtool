"""Run the embedded Bash with fake ip/netplan and sandboxed network files."""

import os
import re
import shlex
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

TEMPLATE = Path(__file__).resolve().parents[2] / "APIdoc/cloud-init/cloud-init-ip-local-elastic-teleport-mount-lmv-new.yaml"
BASH = "C:/Program Files/Git/bin/bash.exe" if os.name == "nt" else shutil.which("bash")
pytestmark = pytest.mark.skipif(not BASH or not Path(BASH).exists(), reason="Bash required")


def script():
    text = TEMPLATE.read_text(encoding="utf-8")
    entry = text.split("  - path: /usr/local/sbin/cloudtool-static-ip.sh\n", 1)[1]
    entry = re.split(r"\n(?:  - path:|runcmd:)", entry, maxsplit=1)[0]
    return textwrap.dedent(entry.split("    content: |\n", 1)[1])


ROWS = """1: eth1 inet 10.129.26.204/21 scope global eth1
2: eth2 inet 10.1.27.99/27 scope global eth2
3: eth0 inet 171.253.170.90/22 scope global eth0"""
ROUTES = """default via 10.1.27.97 dev eth2 proto dhcp metric 100
default via 171.253.171.254 dev eth0 proto dhcp metric 200"""


def mock_commands(rows=ROWS, routes=ROUTES, failure=""):
    return f'''
ADDR_ROWS={shlex.quote(rows)}
OLD_ROUTES={shlex.quote(routes)}
FAILURE={shlex.quote(failure)}
applied=false
apply_count=0
ip() {{
  if [ "$1" = -o ]; then
    if [ "${{5:-}}" = dev ]; then printf '%s\\n' "$ADDR_ROWS" | awk -v iface="$6" '$2==iface';
    else printf '%s\\n' "$ADDR_ROWS"; fi
  elif [ "${{4:-}}" = default ]; then
    if [ "$applied" = true ]; then
      if [ "$ELASTIC_ENABLED" = true ]; then active="default via 171.253.171.254 dev eth0";
      else active="default via 10.1.27.97 dev eth2"; fi
    else active="$OLD_ROUTES"; fi
    if [ "${{5:-}}" = dev ]; then printf '%s\\n' "$active" | awk -v iface="$6" '{{for(i=1;i<NF;i++) if($i=="dev" && $(i+1)==iface) print}}';
    else printf '%s\\n' "$active"; fi
  else printf '10.1.27.0/24 via 10.1.27.97 dev eth2\\n'; fi
}}
sleep() {{ :; }}
flock() {{ :; }}
netplan() {{
  if [ "$1" = generate ] && [ "${{2:-}}" = --root-dir ] && [ "$FAILURE" = validation ]; then return 9; fi
  if [ "$1" = apply ]; then
    apply_count=$((apply_count+1))
    if [ "$FAILURE" = apply ] && [ "$apply_count" = 1 ]; then return 9; fi
    applied=true
  fi
}}
'''


def run_functions(body, rows=ROWS, routes=ROUTES):
    source = script().split("# Main:", 1)[0]
    return subprocess.run([BASH, "--noprofile", "--norc"], input=source + mock_commands(rows, routes) + body,
                          text=True, capture_output=True, check=False)


def setup():
    return """
ELASTIC_ENABLED=true
ELASTIC_IP=171.253.170.90
LOCAL_IP=10.1.27.99
LOCAL_GATEWAY=10.1.27.97
VPC_CIDR=10.1.27.0/24
MONITOR_IP=10.129.26.204
TELEPORT_ENABLED=true
"""


def test_exact_sample_with_elastic_and_monitor():
    result = run_functions(setup() + "detect_nics\nrender_netplan\n")
    assert result.returncode == 0, result.stderr
    assert result.stdout == '''network:
  version: 2
  ethernets:
    "eth2":
      addresses:
        - "10.1.27.99/27"
      dhcp4: false
      routes:
        - to: "10.1.27.0/24"
          via: "10.1.27.97"
    "eth0":
      addresses:
        - "171.253.170.90/22"
      dhcp4: false
      routes:
        - to: "0.0.0.0/0"
          via: "171.253.171.254"
      nameservers:
        addresses: [8.8.8.8, 1.1.1.1]
    "eth1":
      addresses:
        - "10.129.26.204/21"
      dhcp4: false
'''


def test_no_elastic_keeps_local_default_and_dns_and_static_monitor():
    result = run_functions(setup() + "ELASTIC_ENABLED=false\ndetect_nics\nrender_netplan\n", rows=ROWS.split("\n3:")[0], routes=ROUTES.splitlines()[0])
    assert result.returncode == 0, result.stderr
    assert '"eth0"' not in result.stdout
    assert 'to: "0.0.0.0/0"\n          via: "10.1.27.97"' in result.stdout
    assert result.stdout.count("nameservers:") == 1
    monitor = result.stdout.split('"eth1":', 1)[1]
    assert "10.129.26.204/21" in monitor and "routes:" not in monitor


def test_different_nic_names_and_empty_local_variable_are_detected():
    rows = ROWS.replace("eth2", "ens7").replace("eth0", "enp1s0").replace("eth1", "ens9")
    routes = ROUTES.replace("eth2", "ens7").replace("eth0", "enp1s0")
    result = run_functions(setup() + "LOCAL_IP=''\ndetect_nics\nrender_netplan\n", rows, routes)
    assert result.returncode == 0, result.stderr
    assert all('"' + name + '":' in result.stdout for name in ("ens7", "enp1s0", "ens9"))


def test_missing_elastic_gateway_is_not_replaced_with_local_gateway(tmp_path):
    result = run_functions(setup() + f"SYS_NET={shlex.quote(tmp_path.as_posix())}\nif detect_nics; then exit 8; fi\n", routes=ROUTES.splitlines()[0])
    assert result.returncode == 0, result.stderr


def test_gateway_readiness_waits_for_dhcp_route_instead_of_guessing():
    body = setup() + """
    sleep() { OLD_ROUTES="$OLD_ROUTES"$'\n''default via 171.253.171.254 dev eth0 proto dhcp metric 200'; }
    wait_for 2 detect_nics
    printf '%s' "$elastic_gateway"
    """
    result = run_functions(body, routes=ROUTES.splitlines()[0])
    assert result.returncode == 0, result.stderr
    assert result.stdout.endswith("171.253.171.254")


@pytest.mark.parametrize("failure", ["", "validation", "apply"])
@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize("monitor", [True, False])
def test_entire_bash_flow_validates_applies_or_restores_netplan(tmp_path, failure, enabled, monitor):
    netplan_dir = tmp_path / "netplan"
    netplan_dir.mkdir()
    original = "network:\n  version: 2\n  ethernets: {}\n"
    (netplan_dir / "original.yaml").write_text(original)
    source = script()
    substitutions = {"elastic_ip_enabled": "true" if enabled else "false", "elastic_ip_address": "171.253.170.90" if enabled else "", "private_ip": "10.1.27.99", "local_gateway": "10.1.27.97", "vpc_cidr": "10.1.27.0/24", "TELEPORT_ENABLE": "true" if monitor else "false", "TP_MONITOR_IP": "10.129.26.204" if monitor else ""}
    for name, value in substitutions.items():
        source = source.replace("{{" + name + "}}", value)
    for name, value in {"NETPLAN_DIR": netplan_dir, "BACKUP_ROOT": tmp_path / "backups", "LOG_DIR": tmp_path / "logs", "LOCK_FILE": tmp_path / "lock"}.items():
        source = re.sub(r"^" + name + r"=.*$", name + "=" + shlex.quote(value.as_posix()), source, count=1, flags=re.MULTILINE)
    rows = ROWS if enabled else ROWS.split("\n3:")[0]
    if not monitor:
        rows = "\n".join(row for row in rows.splitlines() if "eth1" not in row)
    routes = ROUTES if enabled else ROUTES.splitlines()[0]
    source = source.replace("# Main:", mock_commands(rows, routes, failure) + "\n# Main:", 1)
    result = subprocess.run([BASH, "--noprofile", "--norc"], input=source, text=True, capture_output=True, check=False)
    log = (tmp_path / "logs/static-ip.log").read_text()
    if not failure:
        assert result.returncode == 0, log + result.stderr
        expected_gateway = "171.253.171.254" if enabled else "10.1.27.97"
        assert f'via: "{expected_gateway}"' in (netplan_dir / "50-cloud-init.yaml").read_text()
        assert "SUCCESS local=" in log
        rendered = (netplan_dir / "50-cloud-init.yaml").read_text()
        assert ('"eth1":' in rendered) == monitor
        assert ('"eth0":' in rendered) == enabled
        assert rendered.count("nameservers:") == 1
        assert rendered.count('to: "0.0.0.0/0"') == 1
    else:
        assert result.returncode != 0
        assert (netplan_dir / "original.yaml").read_text() == original
        assert not (netplan_dir / "50-cloud-init.yaml").exists()
        if failure == "apply":
            assert "ROLLBACK_SUCCESS" in log


@pytest.mark.parametrize("local_variables", ["", "LOCAL_IP=''", "LOCAL_IP=''; LOCAL_GATEWAY=''"])
def test_local_only_detects_nic_by_ip_gateway_or_default_route(local_variables):
    body = setup() + "ELASTIC_ENABLED=false\nELASTIC_IP=''\nTELEPORT_ENABLED=false\nMONITOR_IP=''\n"
    result = run_functions(body + local_variables + "\ndetect_nics\nrender_netplan\n",
                           rows=ROWS.splitlines()[1], routes=ROUTES.splitlines()[0])
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("dhcp4: false") == 1
    assert '"eth2":' in result.stdout
    assert '"10.1.27.99/27"' in result.stdout
    assert 'to: "0.0.0.0/0"\n          via: "10.1.27.97"' in result.stdout
    assert "addresses: [8.8.8.8, 1.1.1.1]" in result.stdout


def test_bash_syntax_and_no_python_helper():
    result = subprocess.run([BASH, "-n"], input=script(), text=True, capture_output=True, check=False)
    assert result.returncode == 0, result.stderr
    text = TEMPLATE.read_text(encoding="utf-8")
    assert "cloudtool-elastic-netplan.py" not in text
    assert "python3" not in script()
