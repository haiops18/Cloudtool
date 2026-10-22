import re
from ipaddress import ip_address, ip_network

from app.provisioning.schemas import ServerSpec

VARIABLE_PATTERN = re.compile(r"\{\{\s*([\w.\[\]]+)\s*\}\}")


def cloud_init_values(server: ServerSpec) -> dict[str, str]:
    data_volumes = [volume for volume in server.volumes if volume.mount_as == "data"]
    root_volume = next((volume for volume in server.volumes if volume.mount_as == "root"), None)
    subnet_network = ip_network(server.subnet_cidr, strict=False) if server.subnet_cidr else None
    local_gateway = str(subnet_network.network_address + 1) if subnet_network else ""
    values = {
        "server_name": server.name,
        "server.name": server.name,
        "hostnamectl": server.name,
        "zone": server.zone_name or server.zone_id or server.zone,
        "private_ip": server.eni_address or server.private_ip or "",
        # Network values are resolved from the selected Private IP subnet by
        # the provisioning service immediately before the Cloud API call.
        "local_gateway": local_gateway,
        "private_gateway": local_gateway,
        "subnet_cidr": server.subnet_cidr or "",
        "vpc_cidr": server.vpc_cidr or server.subnet_cidr or "",
        "TP_REGION": server.teleport_region,
        "TP_SYSTEM": server.teleport_system or server.name,
        "TP_HOSTNAME": server.teleport_hostname or server.name,
        "TP_MONITOR_IP": server.teleport_monitor_ip or "",
        "TELEPORT_ENABLE": "true" if server.teleport_enabled else "false",
        "volume_count": str(len(server.volumes)),
        "data_volume_count": str(len(data_volumes)),
        "has_data_volumes": "true" if data_volumes else "false",
        "has_other_volumes": "true" if data_volumes else "false",
        "root_volume": f"{root_volume.mount_as},{root_volume.volume_type_name or root_volume.volume_type},{root_volume.size},{root_volume.mount_point or '/'}" if root_volume else "",
        "data_volumes": "\n".join(f"{volume.mount_as},{volume.volume_type_name or volume.volume_type},{volume.size},{volume.mount_point or '/data'}" for volume in data_volumes),
        # Escaped newlines keep the list on one YAML line so it can safely be
        # consumed by a custom shell while-loop in cloud-init.
        "data_volumes_shell": "\\n".join(f"{volume.mount_as},{volume.volume_type_name or volume.volume_type},{volume.size},{volume.mount_point or '/data'}" for volume in data_volumes),
        "data_volume_types": ",".join(volume.volume_type_name or volume.volume_type for volume in data_volumes),
        "data_volume_mounts": "\n".join(volume.mount_point or '/data' for volume in data_volumes),
        "volume_mounts": "\n".join(f"{volume.mount_as},{volume.mount_point or ('/' if volume.mount_as == 'root' else '/data')}" for volume in server.volumes),
    }
    for index, volume in enumerate(server.volumes, start=1):
        values[f"volume[{index}].mount_path"] = volume.mount_point or ("/" if volume.mount_as == "root" else "/data")
        values[f"volume[{index}].type"] = volume.volume_type_name or volume.volume_type
        values[f"volume[{index}].size"] = str(volume.size)
        values[f"volume_{index}_mount_path"] = volume.mount_point or ("/" if volume.mount_as == "root" else "/data")
        values[f"volume_{index}_type"] = volume.volume_type_name or volume.volume_type
        values[f"volume_{index}_size"] = str(volume.size)
    for index, volume in enumerate(data_volumes, start=1):
        values[f"data_volume[{index}].mount_path"] = volume.mount_point or "/data"
        values[f"data_volume[{index}].type"] = volume.volume_type_name or volume.volume_type
        values[f"data_volume[{index}].size"] = str(volume.size)
        values[f"data_volume_{index}_mount_path"] = volume.mount_point or "/data"
        values[f"data_volume_{index}_type"] = volume.volume_type_name or volume.volume_type
        values[f"data_volume_{index}_size"] = str(volume.size)
    values.update(server.cloud_init_variables)
    # These values describe the selected allocation, so custom variables must
    # not override them with a stale or unrelated address.
    elastic_enabled = server.elastic_ip_mode != "none" or server.assign_public_ip
    elastic_address = ""
    if server.elastic_ip_mode == "existing" and server.elastic_ip_address:
        try:
            elastic_address = str(ip_address(server.elastic_ip_address.strip()))
        except ValueError:
            pass
    values.update({
        "elastic_ip_enabled": "true" if elastic_enabled else "false",
        "elastic_ip_address": elastic_address if elastic_enabled else "",
    })
    return {key: str(value) for key, value in values.items()}


def render_cloud_init_variables(content: str, server: ServerSpec) -> str:
    values = cloud_init_values(server)
    requested = {match.group(1) for match in VARIABLE_PATTERN.finditer(content)}
    if "elastic_ip_address" in requested:
        if server.elastic_ip_mode == "auto" or (
            server.elastic_ip_mode == "none" and server.assign_public_ip
        ):
            raise ValueError(
                "elastic_ip_address is unavailable before automatic allocation. "
                "Select an existing Elastic IP to use its exact address in cloud-init."
            )
        if server.elastic_ip_mode == "existing" and not values["elastic_ip_address"]:
            raise ValueError("elastic_ip_address requires a valid address from the selected Elastic IP")
    missing: set[str] = set()

    def replace(match: re.Match[str]) -> str:
        key = match.group(1)
        if key not in values:
            missing.add(key)
            return match.group(0)
        return values[key]

    rendered = VARIABLE_PATTERN.sub(replace, content)
    if missing:
        raise ValueError(f"Cloud-init variables are missing: {', '.join(sorted(missing))}")
    # Cloudbase-Init matches the Windows script header at byte zero. A BOM or
    # leading blank line from pasted content makes it silently unsupported.
    windows_content = rendered.lstrip("\ufeff \t\r\n")
    if re.match(r"#ps1(?:_sysnative|_x86)?\s", windows_content):
        return windows_content
    return rendered
