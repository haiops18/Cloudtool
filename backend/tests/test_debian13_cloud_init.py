"""Sandbox the Debian template; never call real network/disk mutation tools."""
import re
import shlex
import subprocess
import textwrap
from pathlib import Path

import pytest
from test_elastic_cloud_init_netplan import BASH, ROUTES, ROWS, mock_commands

pytestmark = pytest.mark.skipif(not BASH or not Path(BASH).exists(), reason="Bash required")
TEMPLATE = Path(__file__).resolve().parents[2] / "APIdoc/cloud-init/debian13-cloudtool-static-teleport.yaml"


def script(name):
    text = TEMPLATE.read_text(encoding="utf-8")
    entry = text.split("  - path: /usr/local/sbin/" + name + "\n", 1)[1]
    entry = re.split(r"\n(?:  - path:|runcmd:)", entry, maxsplit=1)[0]
    return textwrap.dedent(entry.split("    content: |\n", 1)[1])


def run(source):
    return subprocess.run([BASH, "--noprofile", "--norc"], input=source, text=True, capture_output=True, check=False, timeout=30)


def paths(source, **values):
    for name, value in values.items():
        source = re.sub(r"^" + name + r"=.*$", name + "=" + shlex.quote(str(value).replace("\\", "/")), source, count=1, flags=re.MULTILINE)
    return source


@pytest.mark.parametrize("enabled", [True, False])
@pytest.mark.parametrize("monitor", [True, False])
@pytest.mark.parametrize("failure", ["", "validation", "apply", "verify", "restart_skipped"])
def test_ifupdown_all_nics_validation_apply_and_rollback(tmp_path, enabled, monitor, failure):
    network = tmp_path / "network"
    network.mkdir()
    (network / "interfaces.d").mkdir()
    (network / "interfaces.d/original").write_text("# original DHCP fragment\n")
    original = "auto lo\niface lo inet loopback\nsource /etc/network/interfaces.d/*\n"
    (network / "interfaces").write_text(original)
    source = script("cloudtool-static-ip.sh")
    values = {"elastic_ip_enabled": str(enabled).lower(), "elastic_ip_address": "171.253.170.90" if enabled else "", "private_ip": "10.1.27.99", "local_gateway": "10.1.27.97", "vpc_cidr": "10.1.27.0/24", "TELEPORT_ENABLE": str(monitor).lower(), "TP_MONITOR_IP": "10.129.26.204" if monitor else ""}
    for key, value in values.items():
        source = source.replace("{{" + key + "}}", value)
    source = paths(source, NETWORK_DIR=network, BACKUP_ROOT=tmp_path / "backup", LOG_DIR=tmp_path / "logs", LOCK_FILE=tmp_path / "lock")
    rows = "\n".join(row for row in ROWS.splitlines() if (enabled or "eth0" not in row) and (monitor or "eth1" not in row))
    routes = ROUTES if enabled else ROUTES.splitlines()[0]
    mocks = mock_commands(rows, routes, failure) + """
ifquery() { [ "$FAILURE" != validation ]; }
ifdown() { :; }
ifup() { if [ "$FAILURE" = restart_skipped ]; then applied=true; ADDR_ROWS="$saved_rows"; fi; }
systemctl() {
  apply_count=$((apply_count+1))
  if [ "$FAILURE" = apply ] && [ "$apply_count" = 1 ]; then return 9; fi
  if [ "$FAILURE" = verify ] && [ "$apply_count" = 1 ]; then ADDR_ROWS=''; fi
  if [ "$FAILURE" = restart_skipped ]; then saved_rows="$ADDR_ROWS"; ADDR_ROWS=''; fi
  if [ "$FAILURE" != verify ] && [ "$FAILURE" != restart_skipped ]; then applied=true; fi
}
"""
    result = run(source.replace("# Main:", mocks + "\n# Main:", 1))
    log = (tmp_path / "logs/static-ip.log").read_text()
    assert (network / "interfaces.d/original").read_text() == "# original DHCP fragment\n"
    if failure and failure != "restart_skipped":
        assert result.returncode != 0
        assert (network / "interfaces").read_text() == original
        if failure != "validation":
            assert "ROLLBACK_SUCCESS" in log
    else:
        assert result.returncode == 0, log + result.stderr
        config = (network / "interfaces").read_text()
        assert "address 10.1.27.99/27" in config
        assert ("iface eth0 inet static" in config) == enabled
        assert ("iface eth1 inet static" in config) == monitor
        assert config.count("dns-nameservers") == 1
        assert config.count("post-up ip -4 route replace 0.0.0.0/0") == 1
        if enabled:
            assert "post-up ip -4 route replace 10.1.27.0/24 via 10.1.27.97 dev eth2 onlink" in config
            assert "post-up ip -4 route replace 0.0.0.0/0 via 171.253.171.254 dev eth0 onlink" in config
        if monitor:
            assert "post-up" not in config.split("iface eth1 inet static", 1)[1]
        assert "SUCCESS local=" in log
        if failure == "restart_skipped":
            assert "REAPPLY explicitly configuring managed NICs" in log


@pytest.mark.parametrize("region,version,host", [("public", "13.4.14", "public.teleport.gpdn.net"), ("vpublic", "16.4.11", "vpublic.teleport.gpdn.net")])
def test_teleport_profiles_install_and_preserve_identity(tmp_path, region, version, host):
    hosts = tmp_path / "hosts"
    hosts.write_text("127.0.0.1 localhost\n10.129.0.232 public.teleport.gpdn.net\n10.129.24.54 vpublic.teleport.gpdn.net\n")
    source = script("cloudtool-teleport.sh")
    for key, value in {"TELEPORT_ENABLE": "true", "TP_REGION": region, "TP_SYSTEM": "app", "TP_HOSTNAME": "node", "TP_MONITOR_IP": "10.129.26.204", "private_ip": "10.1.27.99"}.items():
        source = source.replace("{{" + key + "}}", value)
    source = re.sub(r"^token=.*$", "token='test-token'", source, flags=re.MULTILINE)
    source = source.replace("binary=$(command -v teleport)", "binary=$(command -v bash)")
    source = source.replace("/etc/hosts", hosts.as_posix()).replace("/etc/cloudtool", (tmp_path / "config").as_posix()).replace("/etc/systemd/system/teleport.service", (tmp_path / "teleport.service").as_posix())
    trace = tmp_path / "trace"
    mocks = "TRACE=" + shlex.quote(trace.as_posix()) + r"""
dpkg() { if [ "$1" = --print-architecture ]; then echo amd64; else echo "INSTALL $*" >> "$TRACE"; fi; }
dpkg-query() { return 1; }
curl() { echo "DOWNLOAD $*" >> "$TRACE"; }
systemctl() { echo "SERVICE $*" >> "$TRACE"; }
install() { mkdir -p "${@: -1}"; }
teleport() { :; }
"""
    result = run(source.replace("set -Eeuo pipefail", "set -Eeuo pipefail\n" + mocks, 1))
    assert result.returncode == 0, result.stderr
    unit = (tmp_path / "teleport.service").read_text()
    assert f"--auth-server={host}:443" in unit
    assert "ip_local=10.1.27.99" in unit
    assert "--insecure" not in unit
    assert "test-token" not in unit and "${TELEPORT_JOIN_TOKEN}" in unit
    assert (tmp_path / "config/teleport.env").read_text().strip() == "TELEPORT_JOIN_TOKEN=test-token"
    assert f"teleport_{version}_amd64.deb" in trace.read_text()
    assert hosts.read_text().count(host) == 1
    assert "rm -rf /var/lib/teleport" not in source


def test_teleport_disabled_never_downloads_or_changes_hosts():
    source = script("cloudtool-teleport.sh").replace("{{TELEPORT_ENABLE}}", "false")
    result = run(source)
    assert result.returncode == 0 and "TELEPORT_SKIPPED" in result.stdout


@pytest.mark.parametrize("region", ["hni", "", "unknown"])
def test_teleport_rejects_unsupported_regions_before_installation(region):
    source = script("cloudtool-teleport.sh").replace("{{TELEPORT_ENABLE}}", "true").replace("{{TP_REGION}}", region)
    result = run(source)
    assert result.returncode != 0 and "Unsupported TP_REGION:" in result.stderr
    assert "hni.teleport" not in source and "region_override" not in source


MOUNT_MOCKS = r"""
VG=false; LV=false; FS=''; MOUNTED=false
case "$SCENARIO" in existing|foreignfs|foreignvg|rootvg) VG=true; LV=true; FS=ext4 ;; esac
[ "$SCENARIO" != foreignfs ] || FS=xfs
flock() { :; }; sleep() { :; }; systemctl() { :; }
mkdir() { if [ "$*" != '-p /data' ]; then command mkdir "$@"; fi; }
findmnt() {
  if [ "$*" = '-n -o SOURCE /' ]; then echo /dev/vda1;
  elif [ "$*" = '-n -o UUID --mountpoint /data' ]; then [ "$MOUNTED" = true ] && echo uuid-data;
  else return 1; fi
}
mountpoint() { [ "$MOUNTED" = true ]; }
lsblk() {
  local last="${@: -1}"
  case "$*" in
    '-dnpo NAME,TYPE') echo '/dev/vda disk'; [ "$SCENARIO" = rootonly ] || echo '/dev/sdb disk' ;;
    '-dnro RO /dev/sdb') echo 0 ;;
    '-nrpo NAME /dev/sdb') echo /dev/sdb ;;
    '-nrpo MOUNTPOINT /dev/sdb') : ;;
    '-nrpo NAME,TYPE /dev/sdb') printf '/dev/sdb disk\n/dev/sdb1 part\n' ;;
    *) if [ "$last" = /dev/vda1 ]; then echo '/dev/vda disk'; else echo '/dev/sdb disk'; fi ;;
  esac
}
wipefs() {
  # Match the real CLI: -o means --offset, not the output column selector.
  [ "$#" -eq 5 ] && [ "$1" = --no-act ] && [ "$2" = --noheadings ] && [ "$3" = --output ] && [ "$4" = TYPE ] || return 64
  if [ "$SCENARIO" = signed ]; then echo ext4; fi
}
blockdev() { echo 21474836480; }
pvcreate() { echo "PV $*" >> "$TRACE"; }
vgcreate() { VG=true; echo VG >> "$TRACE"; }
lvcreate() { LV=true; echo LV >> "$TRACE"; }
pvs() { if [ "$SCENARIO" = rootvg ]; then echo /dev/vda1; else echo /dev/sdb1; fi; }
vgs() {
  [ "$VG" = true ] || return 1
  if [ "$1" = --noheadings ]; then
    if [ "$SCENARIO" = foreignvg ]; then echo unrelated; else echo cloudtool; fi
  fi
}
lvs() { [ "$LV" = true ] || return 1; if [ "$1" = --noheadings ]; then echo cloudtool; fi; }
blkid() { if [ "$2" = TYPE ]; then [ -n "$FS" ] && echo "$FS"; else echo uuid-data; fi; }
mkfs.ext4() { FS=ext4; echo FORMAT >> "$TRACE"; }
mount() { MOUNTED=true; echo MOUNT >> "$TRACE"; }
"""


@pytest.mark.parametrize("scenario", ["blank", "existing", "foreignfs", "foreignvg", "rootonly", "rootvg", "signed"])
@pytest.mark.parametrize("raw_path,target,lv_path", [("/data", "/data", "/dev/data/data"), ("/ opt/es-hot", "/opt/es-hot", "/dev/opt_es_hot/opt_es_hot")])
def test_mount_blank_disks_rerun_and_refuse_existing_data(tmp_path, scenario, raw_path, target, lv_path):
    source = script("cloudtool-mount-volumes-ext4.sh").replace("{{data_volumes_shell}}", "data,ssd,20," + raw_path)
    fstab = tmp_path / "fstab"
    fstab.write_text("# original\nUUID=root / ext4 defaults 0 1\n")
    trace = tmp_path / "trace"
    trace.write_text("")
    source = paths(source, LOG_DIR=tmp_path / "logs", FSTAB=fstab, BACKUP_ROOT=tmp_path / "backup", STATE_DIR=tmp_path / "state", SYS_BLOCK=tmp_path / "sys")
    source = source.replace("/run/cloudtool-mount-volumes.lock", (tmp_path / "lock").as_posix())
    source = source.replace('is_block() { [ -b "$1" ]; }', 'is_block() { case "$1" in /dev/vda|/dev/sdb|/dev/sdb1|' + lv_path + ') return 0 ;; *) return 1 ;; esac; }')
    prefix = "SCENARIO=" + scenario + "\nTRACE=" + shlex.quote(trace.as_posix()) + "\n" + MOUNT_MOCKS.replace("/data", target)
    # A complete new-disk run, followed by a rerun in the same simulated VM.
    result = run(prefix + source + ("\n" + source if scenario in ("blank", "existing") else ""))
    log = (tmp_path / "logs/mount-volumes.log").read_text()
    mutations = trace.read_text()
    if scenario in ("blank", "existing"):
        assert result.returncode == 0, log + result.stderr
        assert mutations.count("FORMAT") == (1 if scenario == "blank" else 0)
        assert ("PV /dev/sdb" in mutations) == (scenario == "blank")
        assert mutations.count("MOUNT") == 1
        assert fstab.read_text().count(f"UUID=uuid-data {target} ext4") == 1
        assert "UUID=root /" in fstab.read_text()
    else:
        assert result.returncode != 0
        assert "FORMAT" not in mutations and "PV " not in mutations
        assert fstab.read_text() == "# original\nUUID=root / ext4 defaults 0 1\n"


def test_empty_volume_list_is_a_clean_skip(tmp_path):
    source = script("cloudtool-mount-volumes-ext4.sh").replace("{{data_volumes_shell}}", "")
    source = paths(source, LOG_DIR=tmp_path / "logs", BACKUP_ROOT=tmp_path / "backup", STATE_DIR=tmp_path / "state")
    source = source.replace("/run/cloudtool-mount-volumes.lock", (tmp_path / "lock").as_posix())
    result = run("flock() { :; }\n" + source)
    assert result.returncode == 0, result.stderr
    assert "SKIPPED no data volumes" in (tmp_path / "logs/mount-volumes.log").read_text()


@pytest.mark.parametrize("mode", ["present", "install", "install_failed", "still_missing"])
def test_volume_dependencies_are_checked_before_any_disk_changes(mode):
    template = TEMPLATE.read_text(encoding="utf-8")
    packages = re.search(r"^packages: \[(.*)\]$", template, re.MULTILINE).group(1)
    assert not {"lvm2", "e2fsprogs", "util-linux", "mount"}.intersection(packages.split(", "))
    source = script("cloudtool-mount-volumes-ext4.sh")
    dependencies = source[source.index("required_tools="):source.index("\nensure_tools\n")]
    mocks = "set -Eeuo pipefail\nMODE=" + mode + "\n" + r"""
READY=false
[ "$MODE" != present ] || READY=true
log() { printf '%s\n' "$*"; }
fail() { log "$*"; return 1; }
command() {
  if [ "$1" = -v ]; then
    if [ "$2" = pvcreate ] && [ "$READY" = false ]; then return 1; fi
    return 0
  fi
  builtin command "$@"
}
apt-get() {
  printf 'APT %s\n' "$*"
  if [[ " $* " == *' install '* ]]; then
    [[ "$MODE" != *install_failed ]] || return 42
    if [ "$MODE" != still_missing ]; then READY=true; fi
  fi
}
"""
    result = run(mocks + dependencies + "\nensure_tools\necho DEPENDENCIES_READY\n")
    if mode in ("present", "install"):
        assert result.returncode == 0, result.stderr + result.stdout
        assert "DEPENDENCIES_READY" in result.stdout
        assert ("APT " in result.stdout) == (mode != "present")
        if mode != "present":
            assert "install --no-install-recommends lvm2 e2fsprogs util-linux mount" in result.stdout
    else:
        assert result.returncode != 0 and "DEPENDENCIES_READY" not in result.stdout
        if mode == "still_missing":
            assert "Volume tools still missing after installation: pvcreate" in result.stdout
    assert not re.search(r"\bapt-get\b[^\n]*\bupdate\b", source)
    assert not re.search(r"^APT .*\bupdate\b", result.stdout, re.MULTILINE)
    assert source.index("ensure_tools\n") < source.index('root_source=$(findmnt') < source.index('pvcreate "$disk"')


@pytest.mark.parametrize("rows,error", [
    (["data,ssd,20,/ etc"], "Refusing system mount path /etc"),
    (["data,ssd,20,/opt/ ../etc"], "Mount path must be canonical"),
    (["data,ssd,20,/opt/es hot"], "Invalid mount path"),
    (["data,ssd,20,/ opt/es-hot", "data,ssd,20,/opt/es-hot"], "Duplicate mount path/VG"),
])
def test_normalized_mount_paths_still_enforce_safety(rows, error):
    source = script("cloudtool-mount-volumes-ext4.sh")
    validation = source[source.index("parse_row()"):source.index("backup=$(mktemp")]
    prefix = "set -Eeuo pipefail\nvolumes=(" + " ".join(shlex.quote(row) for row in rows) + ")\n"
    prefix += 'log() { printf "%s\\n" "$*"; }; fail() { log "$*"; return 1; }; mountpoint() { return 1; }\n'
    result = run(prefix + validation + "\necho VALIDATION_DONE\n")
    assert result.returncode != 0 and error in result.stdout
    assert "VALIDATION_DONE" not in result.stdout


def test_all_embedded_bash_parses_and_mount_is_invoked():
    text = TEMPLATE.read_text(encoding="utf-8")
    for name in ("cloudtool-set-hostname.sh", "cloudtool-static-ip.sh", "cloudtool-teleport.sh", "cloudtool-mount-volumes-ext4.sh"):
        result = subprocess.run([BASH, "-n"], input=script(name), text=True, capture_output=True, check=False)
        assert result.returncode == 0, result.stderr
    assert "/usr/local/sbin/cloudtool-mount-volumes-ext4.sh" in text.split("runcmd:", 1)[1]
    assert "netplan" not in script("cloudtool-static-ip.sh").lower()


@pytest.mark.parametrize("failed_step", ["set-hostname", "static-ip", "teleport", "mount-volumes-ext4"])
def test_sample_runner_keeps_all_four_steps_independent(tmp_path, failed_step):
    text = TEMPLATE.read_text(encoding="utf-8")
    runner = text.split("runcmd:\n", 1)[1]
    reference = (TEMPLATE.parent / "mau_ubuntu_teleport.txt").read_text(encoding="utf-8").split("runcmd:\n", 1)[1]
    assert runner.startswith(reference.rstrip() + "\n")
    commands = re.findall(r"^  - \[bash, -c, '(.*)'\]$", runner, re.MULTILINE)
    assert len(commands) == 4
    mocks = "FAILED_STEP=" + shlex.quote(failed_step) + "\n" + r"""
sleep() { :; }
run_step() { printf 'RUN %s\n' "$1"; [ "$1" != "$FAILED_STEP" ]; }
"""
    for command in commands:
        command = command.replace("/var/log/cloudtool", shlex.quote(tmp_path.as_posix()))
        command = re.sub(r"/usr/local/sbin/cloudtool-([a-z0-9-]+)\.sh", r"run_step \1", command)
        result = run(mocks + command)
        assert result.returncode == 0, result.stderr
    lines = (tmp_path / "bootstrap.log").read_text().splitlines()
    assert len(lines) == 4
    assert sum(" FAILED " in line for line in lines) == 1
    assert sum(" SUCCESS " in line for line in lines) == 3


def test_full_template_uses_supported_cloudtool_variables():
    from app.provisioning.schemas import ServerSpec
    from app.provisioning.variables import VARIABLE_PATTERN, render_cloud_init_variables

    server = ServerSpec(name="debian-test", zone="zone", flavor_name="flavor", image_name="debian13", subnet_id="subnet",
                        eni_address="10.1.27.99", subnet_cidr="10.1.27.96/27", vpc_cidr="10.1.27.0/24",
                        elastic_ip_mode="existing", elastic_ip_id="eip", elastic_ip_address="171.253.170.90",
                        cloud_init_enabled=True, teleport_enabled=True, teleport_monitor_ip="10.129.26.204",
                        volumes=[{"mount_as": "root", "volume_type": "ssd", "size": 20, "mount_point": "/"},
                                 {"mount_as": "data", "volume_type": "ssd", "size": 20, "mount_point": "/data"}])
    rendered = render_cloud_init_variables(TEMPLATE.read_text(encoding="utf-8"), server)
    assert not VARIABLE_PATTERN.search(rendered)
    assert "ROWS='data,ssd,20,/data'" in rendered

