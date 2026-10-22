import re
from pathlib import Path

from app.core.config import get_settings
from app.provisioning.schemas import ServerSpec

TEMPLATES = Path(__file__).with_name("templates")


def _block(text: str, expression: str, enabled: bool, replacement: str | None = None) -> str:
    pattern = rf"%\{{ if {re.escape(expression)} ~\}}(.*?)%\{{ endif ~\}}"
    content = replacement if replacement is not None else r"\1"
    return re.sub(pattern, content if enabled else "", text, flags=re.DOTALL)


def _teleport(server: ServerSpec, region: str) -> str:
    settings = get_settings()
    token = settings.PROVISIONING_TELEPORT_TOKENS.get(region)
    version = settings.PROVISIONING_TELEPORT_VERSIONS.get(region)
    if not token or not version:
        raise ValueError(f"Teleport is not configured for region {region!r}")
    text = (TEMPLATES / "teleport.sh.tftpl").read_text(encoding="utf-8")
    text = text.replace("$${", "__SHELL_OPEN__")
    values = {
        "teleport_version": version,
        "teleport_token": token,
        "teleport_region": region,
        "teleport_system": server.teleport_system or server.name,
        "teleport_hostname": server.name,
        "teleport_ip": server.private_ip or "",
    }
    for key, value in values.items():
        text = text.replace("${" + key + "}", value)
    return text.replace("__SHELL_OPEN__", "${")


def render_cloud_init(server: ServerSpec, region: str, teleport_enabled: bool) -> str | None:
    image = server.image_name.casefold()
    if "windows" in image:
        return None
    family = "centos" if any(x in image for x in ("centos", "rhel", "rocky", "alma")) else "ubuntu"
    text = (TEMPLATES / f"{family}.yaml.tftpl").read_text(encoding="utf-8")
    disks = "".join(
        f"      {d.size_gb} {d.mount_point} {d.filesystem}\n" for d in server.data_disks
    )
    text = re.sub(
        r"%\{ for d in extra_disks ~\}.*?%\{ endfor ~\}\n?", disks, text, flags=re.DOTALL
    )
    text = text.replace("$${", "${")
    if family == "ubuntu":
        monitor = bool(server.monitor_ip)
        text = _block(text, 'monitor_ip != ""', monitor)
        text = text.replace("${monitor_ip}", server.monitor_ip or "")
        text = text.replace(
            "${monitor_nic_prefix}", str(get_settings().PROVISIONING_MONITOR_NIC_PREFIX)
        )
        script = _teleport(server, region) if teleport_enabled else ""
        text = _block(text, "teleport_enabled", teleport_enabled)
        text = text.replace("${indent(6, teleport_script)}", "\n".join("      " + x for x in script.splitlines()))
    return text
