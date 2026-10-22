"""Isolated Codex workspaces for CloudTool projects.

The Codex app-server needs a stable working directory to treat a conversation
as a code project.  This module creates one non-secret directory per CloudTool
project and exposes only explicit source directories as read-only workspace
roots.  In particular, it never makes the repository root (and therefore
``.env`` files or service data) available to Codex.
"""

from __future__ import annotations

import re
import json
import base64
import csv
import mimetypes
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from io import StringIO
from typing import Any
from uuid import uuid4

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

from app.config import get_settings


_SAFE_PROJECT_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_GENERATED_ARTIFACT_BYTES = 25 * 1024 * 1024
MAX_MANAGED_WORKSPACE_ARCHIVE_BYTES = 250 * 1024 * 1024


@dataclass(frozen=True)
class ProjectWorkspace:
    path: str
    source_roots: list[str]


@dataclass(frozen=True)
class ProjectContextRefresh:
    path: str
    files: list[str]
    refreshed_at: str


def _project_directory_name(project_id: str) -> str:
    """Return a path-safe, stable directory name without accepting traversal."""
    normalized = project_id.strip()
    if not _SAFE_PROJECT_ID.fullmatch(normalized):
        # Caller project IDs are normally UUIDs.  Fail closed instead of
        # allowing an unusual upstream ID to alter a host path.
        raise ValueError("CloudTool project ID contains unsupported characters")
    return normalized


def prepare_project_workspace(
    project_id: str, *, initialize_files: bool = True
) -> ProjectWorkspace:
    settings = get_settings()
    service_root = Path(__file__).resolve().parents[1]
    configured_workspace_root = Path(settings.CODEX_PROJECT_WORKSPACE_ROOT).expanduser()
    workspace_root = (configured_workspace_root if configured_workspace_root.is_absolute() else service_root / configured_workspace_root).resolve()
    workspace = (workspace_root / _project_directory_name(project_id)).resolve()
    if workspace.parent != workspace_root:
        raise ValueError("Invalid CloudTool project workspace path")
    workspace.mkdir(parents=True, exist_ok=True)

    configured_source_root = Path(settings.CODEX_SOURCE_ROOT).expanduser()
    source_root = (configured_source_root if configured_source_root.is_absolute() else service_root / configured_source_root).resolve()
    # Make code available explicitly.  Do not expose repository-level dotfiles,
    # service databases, generated uploads, or environment files.
    candidates = [
        source_root / "frontend" / "src",
        source_root / "backend" / "app",
        source_root / "agent-service" / "app",
    ]
    source_roots = [str(path.resolve()) for path in candidates if path.is_dir()]
    if not source_roots:
        raise RuntimeError("No permitted CloudTool source directories were found")

    # History browsing only needs a stable cwd and the read-only source roots.
    # Avoid rewriting workspace/config files in that path: an editor or Codex
    # may hold them open while the user opens the history modal.
    if not initialize_files:
        return ProjectWorkspace(path=str(workspace), source_roots=source_roots)

    context_file = workspace / "PROJECT_CONTEXT.md"
    if not context_file.exists():
        context_file.write_text(
            "# CloudTool Codex workspace\n\n"
            f"CloudTool project ID: `{project_id}`\n\n"
            "This directory is the isolated working directory for this project's Codex conversations. "
            "Application source is supplied separately as read-only workspace roots. "
            "No credentials, environment files, databases, or generated runtime data are available here.\n",
            encoding="utf-8",
        )
    api_docs = workspace / "api-docs"
    api_docs.mkdir(exist_ok=True)
    (api_docs / "vm-creation-lookups.md").write_text(
        (service_root / "app" / "docs" / "vm-creation-lookups.md").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    (api_docs / "project-create-actions.md").write_text(
        (service_root / "app" / "docs" / "project-create-actions.md").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    # Codex may produce user-requested deliverables, but its permission profile
    # grants write access solely to this dedicated directory.
    (workspace / "outputs").mkdir(exist_ok=True)
    codex_config = workspace / ".codex"
    codex_config.mkdir(exist_ok=True)
    (codex_config / "config.toml").write_text(
        "[permissions.cloudtool-artifact-write]\n"
        "description = 'Read the CloudTool workspace and write only generated deliverables.'\n"
        "extends = ':workspace'\n\n"
        "[permissions.cloudtool-artifact-write.filesystem]\n"
        "':root' = 'deny'\n"
        "':minimal' = 'read'\n\n"
        "[permissions.cloudtool-artifact-write.filesystem.':workspace_roots']\n"
        "'.' = 'read'\n"
        "'outputs' = 'write'\n",
        encoding="utf-8",
    )
    # Legacy proposal/continuation documentation. The pending gateway is now
    # documented per capability, so remove this stale direct-write
    # guide whenever a project workspace is prepared or refreshed.
    (api_docs / "security-group-rules.md").unlink(missing_ok=True)
    (api_docs / "agent-local-gateway.md").unlink(missing_ok=True)
    (api_docs / "security-group-rule-pending-gateway.md").unlink(missing_ok=True)

    direct_gateway_doc = api_docs / "security-group-rule-create-gateway.md"
    direct_gateway_doc.write_text(
        "# Create security-group rules: approval action API\n\n"
        "Use the native CloudTool action API `create_security_group_rule` for an approved write. It can create 1-20 rules for one exact Security Group in one browser approval. It is handled only by the local Agent Service pending gateway; Codex has no endpoint, capability, cloud credential, cookie, CSRF value, shell, or network access for this operation. Never call CloudTool directly.\n\n"
        "## Input\n\n"
        "```json\n{\"security_group_id\":\"exact-id\",\"rules\":[{\"direction\":\"ingress\",\"protocol\":\"tcp\",\"port_range_min\":443,\"port_range_max\":443,\"remote_ip_prefix\":\"203.0.113.0/24\"},{\"direction\":\"ingress\",\"protocol\":\"tcp\",\"port_range_min\":80,\"port_range_max\":80,\"remote_ip_prefix\":\"203.0.113.0/24\"}]}\n```\n\n"
        "## Wait and handle the response\n\nThe request blocks until the user decides and execution completes. Do not poll or retry while waiting.\n\n"
        "- `200 {\"status\":\"success\",\"result\":...}`: confirm the created rule using `result`.\n"
        "- `200 {\"status\":\"rejected\",\"reason\":\"User denied this action\"}`: acknowledge the denial; do not retry unless the user explicitly asks.\n"
        "- `200 {\"status\":\"failed\",\"reason\":...}`: explain the failure; inspect inputs/current data before a user-requested retry.\n"
        "- `401/403`: capability is invalid/expired; do not invent a token or retry.\n"
        "- `422`: fix the action schema or exact security-group ID before another request.\n"
        "- `200 {\"status\":\"rejected\",\"reason\":\"Approval timed out; user did not approve this action\"}`: tell the user and do not assume a write occurred.\n\n"
        "Validate every rule first. Rules in one batch must use the same Security Group and run sequentially only after one approval. Multiple batches are allowed when necessary; never issue concurrent or blind non-idempotent retries.\n",
        encoding="utf-8",
    )
    vm_deployment_doc = api_docs / "vm-deployment-create-action-api.md"
    vm_deployment_doc.write_text(
        "# Create VM deployment: approval action API\n\n"
        "Use the native CloudTool action API `create_vm_deployment` to request VM creation. The local Agent Service creates a pending action and waits for browser approval. Codex never receives a CloudTool token, cookie, CSRF value, service key, shell, or network access. Never call CloudTool directly.\n\n"
        "## Required input\n\n"
        "First read `api-docs/vm-creation-lookups.md` and resolve configuration using the live read-only tools. Batch independent lookups and repeat calls for dependencies within the same chat turn.\n\n"
        "Read `api-docs/project-create-actions.md` for IP creation, VM input requirements and attaching allocated IPs. Basic VMs require an explicit disk_type or volumes. Use deployment_status for actual server IDs after queue acceptance.\n\n"
        "Pass one `deployment` object. It must contain a deployment `name`, `region`, and non-empty `servers`. Each server needs at minimum a unique `name`, a subnet (`subnet_id` or `subnet_name`), and the normal provisioning selections required by the project. Use exact IDs/names already known from project data; ask the user when required provisioning details are absent.\n\n"
        "```json\n{\"deployment\":{\"name\":\"web-tier-01\",\"region\":\"public\",\"execution_mode\":\"standard\",\"servers\":[{\"name\":\"web-01\",\"zone\":\"zone-a\",\"flavor_name\":\"2c-4g\",\"image_name\":\"Ubuntu 22.04\",\"disk_type\":\"exact-disk-type-name\",\"subnet_id\":\"exact-subnet-id\",\"security_group_ids\":[\"exact-sg-id\"]}]}}\n```\n\n"
        "## Response and asynchronous status\n\n"
        "The action call blocks only until approval and queue acceptance. VM provisioning then runs asynchronously; do not wait for it as though it were an immediate create response.\n\n"
        "- `{\"status\":\"queued\",\"result\":{\"id\":\"deployment-id\",\"status\":\"queued\",\"poll_url\":\"/api/v1/provisioning/deployments/deployment-id\"}}`: accepted. Tell the user the deployment ID and that provisioning is queued; do not claim a VM is ready.\n"
        "- `{\"status\":\"rejected\",\"reason\":\"User denied this action\"}`: acknowledge the denial; do not retry without a new explicit request.\n"
        "- `{\"status\":\"failed\",\"reason\":...}`: explain the failure and correct the payload only after confirming the needed values.\n"
        "- `422`: deployment/server schema is incomplete or invalid.\n"
        "- approval timeout: do not assume the deployment was queued.\n\n"
        "You may make multiple sequential action API calls in one chat. Each deployment is separately visible and approved; never send concurrent or blind non-idempotent retries.\n",
        encoding="utf-8",
    )

    return ProjectWorkspace(
        path=str(workspace),
        source_roots=source_roots,
    )


def _compact_snapshot_value(value: Any, field_name: str = "", drop_inventory_snapshot: bool = False) -> Any:
    """Keep workspace snapshots readable and avoid durable bootstrap payloads."""
    normalized = field_name.lower().replace("-", "_")
    if normalized in {"user_data", "userdata"}:
        return None
    if normalized == "snapshot" and drop_inventory_snapshot:
        return None
    if normalized in {"key_pair", "keypair"} and isinstance(value, dict):
        return {key: value.get(key) for key in ("id", "name") if value.get(key) is not None}
    if isinstance(value, dict):
        return {str(key): compact for key, item in value.items() if (compact := _compact_snapshot_value(item, str(key), drop_inventory_snapshot)) is not None}
    if isinstance(value, list):
        return [_compact_snapshot_value(item, drop_inventory_snapshot=drop_inventory_snapshot) for item in value]
    return value


def _compact_server_inventory(value: Any) -> Any:
    """Flatten each inventory row's server-detail snapshot into a readable row.

    The backend inventory API keeps the complete server detail below ``snapshot``.
    Persisting only the outer inventory fields loses useful server data; persisting
    that nested key makes the document both bulky and awkward to use.  Flatten it
    here, retaining the inventory record ID separately when it differs from the
    Cloud server ID.  ``user_data`` and every ``snapshot`` field are excluded.
    """
    rows = value if isinstance(value, list) else value.get("items", value.get("results", [])) if isinstance(value, dict) else []
    result: list[Any] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            result.append(_compact_snapshot_value(row, drop_inventory_snapshot=True))
            continue
        inventory = _compact_snapshot_value(
            {key: item for key, item in row.items() if key != "snapshot"},
            drop_inventory_snapshot=True,
        )
        detail = _compact_snapshot_value(row.get("snapshot"), drop_inventory_snapshot=True)
        if isinstance(inventory, dict) and isinstance(detail, dict):
            inventory_id = inventory.get("id")
            detail_id = detail.get("id")
            if inventory_id is not None and detail_id is not None and inventory_id != detail_id:
                inventory["inventory_id"] = inventory_id
            result.append({**inventory, **detail})
        else:
            result.append(inventory)
    return result


def _compact_elastic_ips(value: Any) -> list[dict[str, Any]]:
    rows = value if isinstance(value, list) else value.get("items", value.get("results", [])) if isinstance(value, dict) else []
    result: list[dict[str, Any]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        ip = row.get("ip_address") or row.get("address") or row.get("ip")
        server = row.get("server")
        if isinstance(server, dict):
            server = {key: server.get(key) for key in ("id", "name", "display_name") if server.get(key) is not None}
        result.append({key: item for key, item in {"id": row.get("id"), "ip": ip, "server": server}.items() if item is not None})
    return result


def write_security_group_rule_template(workspace: ProjectWorkspace, project_id: str, groups: list[dict[str, Any]]) -> str:
    """Write the project-wide multi-SG rule workbook used by Security Groups.

    It deliberately has a SECURITY GROUP column rather than binding the
    workbook to one group, matching the multi-group template flow in the web
    Security Groups header.
    """
    template_dir = Path(workspace.path) / "excel-template"
    template_dir.mkdir(exist_ok=True)
    target = template_dir / "security-group-multi-rules-template.xlsx"
    temporary = template_dir / "security-group-multi-rules-template.tmp.xlsx"
    group_names = list(dict.fromkeys(
        str(group.get("display_name") or group.get("name") or "").strip()
        for group in groups if isinstance(group, dict)
        if str(group.get("display_name") or group.get("name") or "").strip()
    ))
    sample_groups = ",".join(group_names[:2]) or "SG_All,SG_App"
    headers = ["SECURITY GROUP", "DIRECTION", "PROTOCOL", "PORT", "REMOTE IP PREFIX", "DESCRIPTION", "DELETE AT"]

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Firewall Rules"
    sheet.merge_cells("A1:G1")
    sheet["A1"] = "MULTI SECURITY GROUP RULE TEMPLATE"
    sheet["A1"].font = Font(bold=True, size=16, color="1F2937")
    sheet["A1"].alignment = Alignment(horizontal="center")
    metadata = [
        ("Project", project_id),
        ("Target & rule", "SECURITY GROUP / PROTOCOL accept comma or new-line lists. DIRECTION: inbound, outbound, or both."),
        ("Network", "REMOTE IP PREFIX accepts comma or new-line CIDRs. PORT accepts 22, 22-25, or comma/new-line lists; leave blank for all ports."),
        ("Result", "Every combination is expanded into individual rules and reviewed before creation."),
        ("Delete at", "Optional: dd/mm/yyyy HH:mm:ss (example: 31/12/2026 23:59:00)."),
    ]
    for row_index, (label, value) in enumerate(metadata, start=2):
        sheet.cell(row_index, 1, label).font = Font(bold=True, color="1E3A5F")
        sheet.merge_cells(start_row=row_index, start_column=2, end_row=row_index, end_column=7)
        sheet.cell(row_index, 2, value).alignment = Alignment(wrap_text=True)
    header_row = len(metadata) + 3
    for column, header in enumerate(headers, start=1):
        cell = sheet.cell(header_row, column, header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2563EB")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    sheet.append([sample_groups, "both", "tcp,udp", "22,80,443,1000-2000", "10.0.0.0/24\n192.168.10.0/24", "Example: management and application access", "31/12/2026 23:59:00"])
    sheet.freeze_panes = f"A{header_row + 1}"
    for index, width in enumerate((32, 14, 18, 24, 32, 44, 25), start=1):
        sheet.column_dimensions[chr(64 + index)].width = width

    lists = workbook.create_sheet("Lists")
    lists.sheet_state = "hidden"
    for row_index, name in enumerate(group_names, start=1):
        lists.cell(row_index, 1, name)
    directions = ["inbound", "outbound", "both"]
    protocols = ["tcp", "udp", "any", "icmp", "igmp", "ip", "ipv6-icmp", "gre", "esp", "ah", "ospf", "sctp", "vrrp", "rsvp", "dccp", "egp", "hopopt", "ipip", "ipv6-encap", "ipv6-frag", "ipv6-nontx", "ipv6-opts", "ipv6-route", "pgm", "udplite"]
    for row_index, value in enumerate(directions, start=1):
        lists.cell(row_index, 2, value)
    for row_index, value in enumerate(protocols, start=1):
        lists.cell(row_index, 3, value)
    data_start, data_end = header_row + 1, header_row + 1000
    if group_names:
        groups_validation = DataValidation(type="list", formula1=f"'Lists'!$A$1:$A${len(group_names)}", allow_blank=False)
        sheet.add_data_validation(groups_validation)
        groups_validation.add(f"A{data_start}:A{data_end}")
    for column, list_column, values in (("B", "B", directions), ("C", "C", protocols)):
        validation = DataValidation(type="list", formula1=f"'Lists'!${list_column}$1:${list_column}${len(values)}", allow_blank=False)
        sheet.add_data_validation(validation)
        validation.add(f"{column}{data_start}:{column}{data_end}")
    workbook.save(temporary)
    temporary.replace(target)
    return target.relative_to(workspace.path).as_posix()


def write_server_creation_template(workspace: ProjectWorkspace, project_id: str, lookups: dict[str, list[str]]) -> str:
    """Create the Terraform server workbook from its existing Cloud lookup APIs."""
    template_dir = Path(workspace.path) / "excel-template"
    template_dir.mkdir(exist_ok=True)
    target = template_dir / "server-creation-template.xlsx"
    temporary = template_dir / "server-creation-template.tmp.xlsx"
    headers = ["SERVER NAME", "SERVER TYPE", "ZONE", "SPECS MODE", "FLAVOR", "RAM GB", "VCPUS", "PUBLIC IMAGE", "KEY PAIR", "BANDWIDTH", "ELASTIC IP ENABLED", "ELASTIC IP", "ENABLE IPV4", "PRIVATE IP MODE", "SUBNET", "PRIVATE IP", "SECURITY GROUPS", "PLACEMENT GROUP", "ROOT VOLUME", "OTHER VOLUMES", "CLOUD INIT ENABLED", "CLOUD INIT TEMPLATE", "TELEPORT_ENABLE", "TP_REGION", "TP_SYSTEM", "TP_HOSTNAME", "TP_SUBNET", "TP_MONITOR_IP"]
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Servers"
    sheet.merge_cells(start_row=1, start_column=1, end_row=1, end_column=len(headers))
    sheet["A1"] = "SERVER CREATION TEMPLATE"
    sheet["A1"].font = Font(bold=True, size=16, color="1F2937")
    sheet["A1"].alignment = Alignment(horizontal="center")
    sheet["A2"], sheet["B2"] = "Project", project_id
    sheet["A2"].font = Font(bold=True, color="1E3A5F")
    sheet.merge_cells(start_row=3, start_column=2, end_row=3, end_column=len(headers))
    sheet["A3"], sheet["B3"] = "Instructions", "Use the dropdown values loaded from the same Cloud APIs as Terraform. Separate multiple Security Groups with commas."
    sheet["A3"].font = Font(bold=True, color="1E3A5F")
    sheet["B3"].alignment = Alignment(wrap_text=True)
    header_row = 5
    for index, header in enumerate(headers, start=1):
        cell = sheet.cell(header_row, index, header)
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2563EB")
        cell.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        sheet.column_dimensions[get_column_letter(index)].width = max(14, min(26, len(header) + 4))
    sample = {"SERVER NAME": "app-01", "SERVER TYPE": "basic", "SPECS MODE": "predefined", "RAM GB": "4", "VCPUS": "2", "BANDWIDTH": "300", "ELASTIC IP ENABLED": "no", "ENABLE IPV4": "yes", "PRIVATE IP MODE": "Auto Allocate", "CLOUD INIT ENABLED": "no", "TELEPORT_ENABLE": "no", "TP_REGION": "public"}
    for key, lookup_key in {"ZONE": "zones", "FLAVOR": "flavors", "PUBLIC IMAGE": "images", "KEY PAIR": "keypairs", "SUBNET": "subnets", "SECURITY GROUPS": "security_groups"}.items():
        if lookups.get(lookup_key): sample[key] = lookups[lookup_key][0]
    if lookups.get("volume_types"):
        sample["ROOT VOLUME"] = f"root,{lookups['volume_types'][0]},50,/"
    sheet.append([sample.get(header, "") for header in headers])
    sheet.freeze_panes = "A6"
    lists = workbook.create_sheet("Lists")
    lists.sheet_state = "hidden"
    volume_examples = [f"root,{item},50,/" for item in lookups.get("volume_types", [])]
    data_examples = [f"data,{item},50,/data" for item in lookups.get("volume_types", [])]
    validation_map = {"SERVER TYPE": ["basic", "gpu"], "SPECS MODE": ["predefined", "custom"], "ELASTIC IP ENABLED": ["yes", "no"], "ENABLE IPV4": ["yes", "no"], "PRIVATE IP MODE": ["Auto Allocate", "Select Existing", "Create ordered"], "CLOUD INIT ENABLED": ["yes", "no"], "TELEPORT_ENABLE": ["yes", "no"], "TP_REGION": ["public", "vpublic"], "ZONE": lookups.get("zones", []), "FLAVOR": lookups.get("flavors", []), "PUBLIC IMAGE": lookups.get("images", []), "KEY PAIR": lookups.get("keypairs", []), "ELASTIC IP": lookups.get("elastic_ips", []), "SUBNET": lookups.get("subnets", []), "PRIVATE IP": lookups.get("private_ips", []), "SECURITY GROUPS": lookups.get("security_groups", []), "PLACEMENT GROUP": lookups.get("placement_groups", []), "ROOT VOLUME": volume_examples, "OTHER VOLUMES": data_examples, "CLOUD INIT TEMPLATE": lookups.get("cloud_init_templates", []), "TP_SUBNET": lookups.get("subnets", []), "TP_MONITOR_IP": lookups.get("private_ips", [])}
    for index, header in enumerate(headers, start=1):
        values = validation_map.get(header, [])
        if not values:
            continue
        for row, value in enumerate(values, start=1): lists.cell(row, index, value)
        letter = get_column_letter(index)
        validation = DataValidation(type="list", formula1=f"'Lists'!${letter}$1:${letter}${len(values)}", allow_blank=True)
        sheet.add_data_validation(validation)
        validation.add(f"{letter}{header_row + 1}:{letter}{header_row + 1000}")
    workbook.save(temporary)
    temporary.replace(target)
    return target.relative_to(workspace.path).as_posix()


def _simple_label(value: Any, lookup: dict[str, str] | None = None) -> str:
    if isinstance(value, dict):
        return str(value.get("display_name") or value.get("name") or value.get("ip_address") or value.get("cidr") or "").strip()
    return (lookup or {}).get(str(value), str(value or "")).strip()


def _simple_list(value: Any, lookup: dict[str, str] | None = None) -> str:
    values = value if isinstance(value, list) else [value]
    return "; ".join(item for item in (_simple_label(entry, lookup) for entry in values) if item)


def _simple_id(value: Any) -> str:
    return str(value.get("id") or "") if isinstance(value, dict) else str(value or "")


def _simple_ips(value: Any) -> list[str]:
    result: list[str] = []
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict):
            item = item.get("ip_address") or item.get("address") or item.get("ip")
        if isinstance(item, str) and item.strip(): result.append(item.strip())
    return list(dict.fromkeys(result))


def _flavor_specs(value: Any) -> tuple[str, str]:
    """Extract CPU/RAM from live flavor objects or their Cloud display label."""
    if isinstance(value, dict):
        vcpus = value.get("vcpus") or value.get("cpu") or value.get("cores")
        ram = value.get("ram_gb") or value.get("ram") or value.get("memory")
        if vcpus is not None or ram is not None:
            return str(vcpus or ""), str(ram or "")
    text = _simple_label(value)
    cpu = re.search(r"(?:v?cpu|cpu)\s*:\s*(\d+)|\b(\d+)c\b", text, re.I)
    ram = re.search(r"ram\s*:\s*(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s*gb\b", text, re.I)
    return (next((item for item in (cpu.groups() if cpu else ()) if item), ""), next((item for item in (ram.groups() if ram else ()) if item), ""))


def _simple_volumes(value: Any) -> str:
    """Keep complete useful volume facts from the live server-detail payload.

    CloudTool returns an attachment wrapper (``mount_as``/``mount_point``)
    around the actual ``volume`` object.  Older responses return the volume
    directly, so support both shapes without leaking opaque volume IDs.
    """
    result: list[str] = []
    for item in value if isinstance(value, list) else [value]:
        if isinstance(item, dict):
            source = item.get("volume") if isinstance(item.get("volume"), dict) else item
            name = _simple_label(source) or _simple_label(item) or str(source.get("device") or item.get("device") or "volume")
            size = source.get("size") or source.get("size_gb") or source.get("volume_size") or source.get("capacity")
            type_value = source.get("volume_type") or source.get("disk_type") or source.get("type")
            volume_type = _simple_label(type_value) or (str(type_value) if isinstance(type_value, str) else "")
            mount_as = item.get("mount_as") or source.get("mount_as")
            mount = item.get("mount_point") or item.get("mount_path") or source.get("mount_point") or source.get("mount_path") or item.get("device") or source.get("device")
            iops = source.get("iops") or source.get("max_iops")
            throughput = source.get("throughput") or source.get("speed")
            parts = [
                name,
                *([f"{size} GB"] if size is not None else []),
                *([volume_type] if volume_type else []),
                *([str(mount_as)] if mount_as else []),
                *([str(mount)] if mount else []),
                *([f"{iops} IOPS"] if iops is not None else []),
                *([f"{throughput} MB/s"] if throughput is not None else []),
            ]
            result.append(" | ".join(parts))
        elif item:
            result.append(str(item))
    return "; ".join(dict.fromkeys(result))


def _write_simple_csv(directory: Path, name: str, fields: list[str], rows: list[dict[str, Any]]) -> str:
    output = StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=fields, extrasaction="ignore")
    writer.writeheader()
    writer.writerows({field: str(row.get(field, "") or "") for field in fields} for row in rows)
    target = directory / name
    temporary = target.with_suffix(".tmp")
    temporary.write_text(output.getvalue(), encoding="utf-8-sig", newline="")
    temporary.replace(target)
    return target.name


_SIMPLE_CSV_FILES = {
    "simple_server_inventory": "server-inventory.csv",
    "simple_vpcs": "vpcs.csv",
    "simple_subnets": "subnets.csv",
    "simple_security_groups": "security-groups.csv",
    "simple_security_group_rules": "security-group-rules.csv",
}

_SIMPLE_JSON_FILES = {
    "simple_server_inventory_json": "server-inventory.json",
    "simple_vpcs_json": "vpcs.json",
    "simple_subnets_json": "subnets.json",
    "simple_security_groups_json": "security-groups.json",
    "simple_security_group_rules_json": "security-group-rules.json",
}


def _write_simple_json(directory: Path, name: str, rows: list[dict[str, Any]]) -> str:
    """Atomically write the same normalized records as the simple CSV export."""
    target = directory / name
    temporary = target.with_suffix(".tmp")
    temporary.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    return target.name


def write_simple_project_data(
    workspace: ProjectWorkspace, data: dict[str, list[dict]], selected: set[str] | None = None
) -> list[str]:
    """Write compact, ID-free CSVs that explain a project without large JSON."""
    directory = Path(workspace.path) / "project-data-simple"
    directory.mkdir(exist_ok=True)
    requested = selected or (set(_SIMPLE_CSV_FILES) | set(_SIMPLE_JSON_FILES))
    vpcs, subnets, groups = data.get("vpcs", []), data.get("subnets", []), data.get("security_groups", [])
    vpc_names = {str(row.get("id")): _simple_label(row) for row in vpcs if row.get("id")}
    vpc_cidrs = {str(row.get("id")): str(row.get("cidr") or "") for row in vpcs if row.get("id")}
    subnet_names = {str(row.get("id")): _simple_label(row) for row in subnets if row.get("id")}
    subnet_cidrs = {str(row.get("id")): str(row.get("cidr") or "") for row in subnets if row.get("id")}
    group_names = {str(row.get("id")): _simple_label(row) for row in groups if row.get("id")}
    zones = data.get("zones", [])
    zone_names = {str(row.get("id")): _simple_label(row) for row in zones if row.get("id")}
    region_names: dict[str, str] = {}
    for zone in zones:
        region = zone.get("region") if isinstance(zone, dict) else None
        region_id, region_name = _simple_id(region), _simple_label(region)
        if region_id and region_name: region_names[region_id] = region_name
    image_names = {str(row.get("id")): _simple_label(row) for row in data.get("images", []) if row.get("id")}
    private_ip_rows = data.get("private_ips", [])
    ip_subnets = {str(row.get("ip_address") or row.get("address") or row.get("ip")): _simple_id(row.get("subnet")) for row in private_ip_rows if isinstance(row, dict)}
    ip_vips: dict[str, list[str]] = {}
    for row in private_ip_rows:
        if not isinstance(row, dict): continue
        address = str(row.get("ip_address") or row.get("address") or row.get("ip") or "")
        if address: ip_vips[address] = _simple_ips(row.get("vips"))
    elastic_by_server: dict[str, list[str]] = {}
    for elastic in data.get("elastic_ips", []):
        if not isinstance(elastic, dict): continue
        server = _simple_id(elastic.get("server"))
        address = _simple_label(elastic)
        if server and address: elastic_by_server.setdefault(server, []).append(address)
    files: list[str] = []
    server_rows: list[dict[str, Any]] = []
    for server in data.get("servers", []):
        private = _simple_ips(server.get("private_ips") or server.get("private_ip"))
        public = _simple_ips(server.get("public_ips") or server.get("public_ip") or server.get("addresses"))
        server_id = str(server.get("id") or server.get("server_id") or "")
        subnet_ids_for_server = list(dict.fromkeys(ip_subnets.get(ip, "") for ip in private if ip_subnets.get(ip)))
        subnets_for_server = [subnet_names.get(subnet_id, "") for subnet_id in subnet_ids_for_server]
        vpc_ids_for_server = list(dict.fromkeys(_simple_id(next((row.get("vpc") for row in subnets if str(row.get("id")) == subnet_id), None)) for subnet_id in subnet_ids_for_server))
        vpcs_for_server = [vpc_names.get(vpc_id, "") for vpc_id in vpc_ids_for_server]
        vip_ips = list(dict.fromkeys(
            [ip for address in private for ip in ip_vips.get(address, [])]
            + _simple_ips(server.get("vip_ip") or server.get("vip_ips"))
        ))
        elastic_ips = list(dict.fromkeys(_simple_ips(server.get("elastic_ip") or server.get("elastic_ips")) + elastic_by_server.get(server_id, [])))
        flavor = server.get("flavor") or server.get("flavor_name")
        vcpus, ram_gb = _flavor_specs(flavor)
        server_rows.append({
            "id": server_id, "server_name": _simple_label(server), "status": server.get("status") or server.get("state"),
            "region": _simple_label(server.get("region"), region_names) or region_names.get(_simple_id(next((zone.get("region") for zone in zones if str(zone.get("id")) == _simple_id(server.get("zone"))), None)), ""), "zone": _simple_label(server.get("zone"), zone_names),
            "flavor": _simple_label(flavor), "image": _simple_label(server.get("image") or server.get("image_name"), image_names),
            "vcpus": server.get("vcpus") or server.get("cpu") or vcpus, "ram_gb": server.get("ram") or server.get("ram_gb") or ram_gb,
            "private_ips": "; ".join(private), "vip_ips": "; ".join(vip_ips), "elastic_ips": "; ".join(elastic_ips),
            "vpcs": "; ".join(vpc for vpc in vpcs_for_server if vpc), "vpc_cidrs": "; ".join(vpc_cidrs.get(vpc_id, "") for vpc_id in vpc_ids_for_server if vpc_cidrs.get(vpc_id)), "subnets": "; ".join(subnet for subnet in subnets_for_server if subnet) or _simple_list(server.get("private_subnets") or server.get("subnets"), subnet_names), "subnet_cidrs": "; ".join(subnet_cidrs.get(subnet_id, "") for subnet_id in subnet_ids_for_server if subnet_cidrs.get(subnet_id)),
            "security_groups": _simple_list(server.get("security_groups"), group_names),
            "key_pair": _simple_label(server.get("key_pair") or server.get("keypair")), "placement_group": _simple_label(server.get("placement_group")), "volumes": _simple_volumes(server.get("volume_details") or server.get("volumes")), "bandwidth": server.get("bandwidth"), "created_at": server.get("created_at"), "updated_at": server.get("updated_at"),
        })
    if "simple_server_inventory" in requested:
        files.append(_write_simple_csv(directory, "server-inventory.csv", ["id", "server_name", "status", "region", "zone", "flavor", "image", "vcpus", "ram_gb", "private_ips", "vip_ips", "elastic_ips", "vpcs", "vpc_cidrs", "subnets", "subnet_cidrs", "security_groups", "key_pair", "placement_group", "volumes", "bandwidth", "created_at", "updated_at"], server_rows))
    vpc_rows = [{"id": row.get("id"), "vpc_name": _simple_label(row), "cidr": row.get("cidr"), "region": _simple_label(row.get("region"), region_names), "internet_access": row.get("internet_access") or row.get("enable_internet_access"), "status": row.get("status"), "description": row.get("description")} for row in vpcs]
    if "simple_vpcs" in requested:
        files.append(_write_simple_csv(directory, "vpcs.csv", ["id", "vpc_name", "cidr", "region", "internet_access", "status", "description"], vpc_rows))
    subnet_rows = [{"id": row.get("id"), "subnet_name": _simple_label(row), "vpc": _simple_label(row.get("vpc"), vpc_names), "cidr": row.get("cidr"), "region": _simple_label(row.get("region"), region_names), "zone": _simple_label(row.get("zone"), zone_names), "gateway_ip": row.get("gateway_ip") or row.get("gateway"), "dhcp_enabled": row.get("enable_dhcp") or row.get("dhcp_enabled"), "status": row.get("status"), "description": row.get("description")} for row in subnets]
    if "simple_subnets" in requested:
        files.append(_write_simple_csv(directory, "subnets.csv", ["id", "subnet_name", "vpc", "cidr", "region", "zone", "gateway_ip", "dhcp_enabled", "status", "description"], subnet_rows))
    rule_counts = {str(bundle.get("security_group", {}).get("id")): len(bundle.get("rules") or []) for bundle in data.get("security_group_rules", []) if isinstance(bundle.get("security_group"), dict)}
    group_rows = [{"id": row.get("id"), "security_group_name": _simple_label(row), "vpc": _simple_label(row.get("vpc"), vpc_names), "region": _simple_label(row.get("region"), region_names), "description": row.get("description"), "rule_count": rule_counts.get(str(row.get("id")), 0)} for row in groups]
    if "simple_security_groups" in requested:
        files.append(_write_simple_csv(directory, "security-groups.csv", ["id", "security_group_name", "vpc", "region", "description", "rule_count"], group_rows))
    rule_rows: list[dict[str, Any]] = []
    for bundle in data.get("security_group_rules", []):
        group = bundle.get("security_group") if isinstance(bundle.get("security_group"), dict) else {}
        for rule in bundle.get("rules") or []:
            if not isinstance(rule, dict): continue
            minimum, maximum = rule.get("port_range_min"), rule.get("port_range_max")
            ports = "all" if minimum is None and maximum is None else str(minimum if minimum == maximum or maximum is None else f"{minimum}-{maximum}")
            rule_rows.append({"id": rule.get("id"), "security_group": _simple_label(group), "direction": rule.get("direction") or rule.get("type"), "protocol": rule.get("protocol"), "ports": ports, "remote_ip_prefix": rule.get("remote_ip_prefix") or rule.get("cidr"), "remote_security_group": _simple_label(rule.get("remote_group") or rule.get("remote_security_group"), group_names), "description": rule.get("description")})
    if "simple_security_group_rules" in requested:
        files.append(_write_simple_csv(directory, "security-group-rules.csv", ["id", "security_group", "direction", "protocol", "ports", "remote_ip_prefix", "remote_security_group", "description"], rule_rows))
    json_rows = {
        "simple_server_inventory_json": server_rows,
        "simple_vpcs_json": vpc_rows,
        "simple_subnets_json": subnet_rows,
        "simple_security_groups_json": group_rows,
        "simple_security_group_rules_json": rule_rows,
    }
    for source, name in _SIMPLE_JSON_FILES.items():
        if source in requested:
            files.append(_write_simple_json(directory, name, json_rows[source]))
    return [f"project-data-simple/{name}" for name in files]


def write_project_context_snapshot(workspace: ProjectWorkspace, project_id: str, context: dict[str, Any]) -> ProjectContextRefresh:
    """Atomically persist the redacted project snapshot in readable files."""
    snapshot_dir = Path(workspace.path) / "project-data"
    snapshot_dir.mkdir(exist_ok=True)
    refreshed_at = datetime.now(UTC).isoformat()
    files: list[str] = []
    names = {
        "inventory": "server-inventory.json",
        "subnets": "subnets.json",
        "security_groups": "security-groups.json",
        "security_group_rules": "security-group-rules.json",
        "private_ips": "private-ips.json",
        "elastic_ips": "elastic-ips.json",
        "audit_events": "audit-events.json",
        "cloud_api_history": "cloud-api-history.json",
    }
    # Refresh is incremental. A user may deliberately refresh one expensive
    # source, so preserve every other workspace file and replace only the
    # selected source atomically.
    for key, filename in names.items():
        if key not in context:
            continue
        target = snapshot_dir / filename
        temporary = target.with_suffix(f"{target.suffix}.tmp")
        content = _compact_server_inventory(context[key]) if key == "inventory" else _compact_elastic_ips(context[key]) if key == "elastic_ips" else _compact_snapshot_value(context[key])
        temporary.write_text(json.dumps(content, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(target)
        files.append(target.relative_to(workspace.path).as_posix())
    manifest = {
        "project_id": project_id,
        "refreshed_at": refreshed_at,
        "files": files,
        "note": "Snapshot is redacted, read-only project context. Use CloudTool MCP for data newer than this refresh.",
    }
    target = snapshot_dir / "manifest.json"
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    files.insert(0, target.relative_to(workspace.path).as_posix())
    return ProjectContextRefresh(path=str(snapshot_dir), files=files, refreshed_at=refreshed_at)


def store_workspace_attachments(workspace: ProjectWorkspace, attachments: list[dict[str, str]]) -> list[dict[str, Any]]:
    """Persist uploads only beneath the selected project's isolated workspace."""
    uploads = Path(workspace.path) / "uploads"
    uploads.mkdir(exist_ok=True)
    stored: list[dict[str, Any]] = []
    for attachment in attachments:
        try:
            raw = base64.b64decode(attachment["content_base64"], validate=True)
        except (KeyError, ValueError) as exc:
            raise ValueError("Attachment could not be decoded") from exc
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise ValueError("Each attachment must be 5 MB or smaller")
        original_name = Path(attachment["name"]).name.strip() or "attachment"
        safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", original_name)[:140]
        safe_path = Path(safe_name)
        suffix = safe_path.suffix
        stem = safe_path.stem[:100] or "attachment"
        # Keep the original extension while making each visible workspace name
        # unique, even for rapid repeated uploads of the same source filename.
        unique_name = f"{stem}-{datetime.now(UTC).strftime('%y%m%d%H%M%S')}-{uuid4().hex[:4]}{suffix}"
        target = uploads / unique_name
        target.write_bytes(raw)
        stored.append({"path": target.relative_to(workspace.path).as_posix(), "name": unique_name, "original_name": original_name, "media_type": attachment["media_type"], "size": len(raw)})
    return stored


def workspace_files(workspace: ProjectWorkspace, query: str = "") -> list[dict[str, Any]]:
    """Return a bounded, workspace-only file/folder index for @mentions."""
    root = Path(workspace.path).resolve()
    needle = query.lower().strip()
    result: list[dict[str, Any]] = []
    protected = {"api-docs/security-group-rule-create-gateway.md", "api-docs/vm-deployment-create-action-api.md"}
    for path in root.rglob("*"):
        if path.is_symlink() or path.name.startswith("."):
            continue
        relative = path.relative_to(root).as_posix()
        if relative in protected or any(part.startswith(".") for part in path.relative_to(root).parts):
            continue
        mention_path = f"{relative}/" if path.is_dir() else relative
        if needle and needle not in mention_path.lower():
            continue
        if path.is_dir():
            result.append({"path": mention_path, "name": f"{path.name}/", "kind": "folder", "size": 0, "media_type": "inode/directory"})
        elif path.is_file():
            result.append({"path": mention_path, "name": path.name, "kind": "file", "size": path.stat().st_size, "media_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
        if len(result) >= 200:
            break
    return sorted(result, key=lambda item: (item["kind"] != "folder", item["path"].lower()))


def _managed_workspace_path(workspace: ProjectWorkspace, relative_path: str) -> tuple[Path, Path]:
    root = Path(workspace.path).resolve()
    target = (root / relative_path).resolve()
    if not target.is_relative_to(root) or ".codex" in target.relative_to(root).parts or target.is_symlink():
        raise ValueError("Workspace path is unavailable")
    return root, target


def managed_workspace_tree(workspace: ProjectWorkspace) -> list[dict[str, Any]]:
    root = Path(workspace.path).resolve()
    rows: list[dict[str, Any]] = []
    for path in root.rglob("*"):
        if path.is_symlink() or ".codex" in path.relative_to(root).parts:
            continue
        stat = path.stat()
        rows.append({"path": path.relative_to(root).as_posix(), "name": path.name, "kind": "folder" if path.is_dir() else "file", "size": 0 if path.is_dir() else stat.st_size, "modified_at": datetime.fromtimestamp(stat.st_mtime, UTC).isoformat(), "media_type": "inode/directory" if path.is_dir() else mimetypes.guess_type(path.name)[0] or "application/octet-stream"})
        if len(rows) >= 1500:
            break
    # Sorting by path components (rather than depth) produces a pre-order tree:
    # each directory is followed immediately by all of its children.
    return sorted(rows, key=lambda item: tuple(part.lower() for part in item["path"].split("/")))


def read_managed_workspace_text(workspace: ProjectWorkspace, relative_path: str) -> dict[str, Any]:
    root, target = _managed_workspace_path(workspace, relative_path)
    if not target.is_file():
        raise ValueError("File is unavailable")
    size = target.stat().st_size
    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    previewable_images = {"image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"}
    if media_type in previewable_images:
        if size > 5 * 1024 * 1024:
            raise ValueError("Image is too large to preview (maximum 5 MB)")
        encoded = base64.b64encode(target.read_bytes()).decode("ascii")
        return {
            "path": target.relative_to(root).as_posix(),
            "kind": "image",
            "data_url": f"data:{media_type};base64,{encoded}",
            "size": size,
        }
    if size > 500 * 1024:
        raise ValueError("File is unavailable or too large to edit")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("Binary files cannot be edited in Workspace management") from exc
    return {"path": target.relative_to(root).as_posix(), "kind": "text", "content": content, "size": size}


def write_managed_workspace_text(workspace: ProjectWorkspace, relative_path: str, content: str) -> None:
    _root, target = _managed_workspace_path(workspace, relative_path)
    if not target.is_file() or len(content.encode("utf-8")) > 500 * 1024:
        raise ValueError("File is unavailable or too large to edit")
    temporary = target.with_suffix(f"{target.suffix}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(target)


def delete_managed_workspace_path(workspace: ProjectWorkspace, relative_path: str) -> None:
    _root, target = _managed_workspace_path(workspace, relative_path)
    if target.is_file():
        target.unlink()
    elif target.is_dir():
        target.rmdir()
    else:
        raise ValueError("Workspace path was not found")


def rename_managed_workspace_file(
    workspace: ProjectWorkspace, relative_path: str, new_name: str
) -> str:
    """Rename one workspace file without allowing it to leave its folder."""
    root, target = _managed_workspace_path(workspace, relative_path)
    name = new_name.strip()
    if (
        not name
        or name in {".", ".."}
        or "/" in name
        or "\\" in name
        or Path(name).name != name
    ):
        raise ValueError("Enter a valid file name")
    if not target.is_file():
        raise ValueError("Only files can be renamed")
    destination = target.with_name(name)
    if not destination.is_relative_to(root) or destination.exists():
        raise ValueError("A file with this name already exists")
    target.rename(destination)
    return destination.relative_to(root).as_posix()


def managed_workspace_download(workspace: ProjectWorkspace, relative_path: str) -> tuple[Path, bool]:
    """Return a safe file, or a temporary ZIP for a safe workspace folder."""
    root, target = _managed_workspace_path(workspace, relative_path)
    if target.is_file():
        return target, False
    if not target.is_dir():
        raise ValueError("Workspace path was not found")

    archive = tempfile.NamedTemporaryFile(prefix="cloudtool-workspace-", suffix=".zip", delete=False)
    archive_path = Path(archive.name)
    archive.close()
    total = 0
    try:
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as output:
            for item in target.rglob("*"):
                if item.is_symlink() or not item.is_file() or ".codex" in item.relative_to(root).parts:
                    continue
                size = item.stat().st_size
                total += size
                if total > MAX_MANAGED_WORKSPACE_ARCHIVE_BYTES:
                    raise ValueError("Folder is too large to download (maximum 250 MB)")
                output.write(item, item.relative_to(target.parent).as_posix())
    except Exception:
        archive_path.unlink(missing_ok=True)
        raise
    return archive_path, True


def workspace_artifact_snapshot(workspace: ProjectWorkspace) -> dict[str, tuple[int, int]]:
    """Return safe signatures for existing Codex-generated deliverables."""
    root = Path(workspace.path).resolve()
    outputs = (root / "outputs").resolve()
    result: dict[str, tuple[int, int]] = {}
    if not outputs.is_dir():
        return result
    for path in outputs.rglob("*"):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_GENERATED_ARTIFACT_BYTES:
            continue
        stat = path.stat()
        result[path.relative_to(root).as_posix()] = (stat.st_mtime_ns, stat.st_size)
    return result


def created_workspace_artifacts(workspace: ProjectWorkspace, before: dict[str, tuple[int, int]]) -> list[dict[str, Any]]:
    """Expose only newly created or updated output files from one Codex turn."""
    root = Path(workspace.path).resolve()
    artifacts: list[dict[str, Any]] = []
    for relative, signature in workspace_artifact_snapshot(workspace).items():
        if before.get(relative) == signature:
            continue
        path = root / relative
        artifacts.append({
            "path": relative,
            "name": path.name,
            "media_type": mimetypes.guess_type(path.name)[0] or "application/octet-stream",
            "size": signature[1],
            "kind": "generated_artifact",
        })
    return sorted(artifacts, key=lambda item: item["path"].lower())[:20]


def resolve_workspace_artifact(workspace: ProjectWorkspace, relative_path: str) -> Path:
    root = Path(workspace.path).resolve()
    outputs = (root / "outputs").resolve()
    target = (root / relative_path).resolve()
    if not target.is_relative_to(outputs) or not target.is_file() or target.is_symlink():
        raise ValueError("Generated workspace file is unavailable")
    if target.stat().st_size > MAX_GENERATED_ARTIFACT_BYTES:
        raise ValueError("Generated workspace file is too large")
    return target


def read_workspace_file(workspace: ProjectWorkspace, relative_path: str) -> dict[str, Any]:
    root = Path(workspace.path).resolve()
    target = (root / relative_path).resolve()
    allowed_roots = (root / "uploads", root / "project-data", root / "outputs")
    if target != root / "PROJECT_CONTEXT.md" and not any(target.is_relative_to(folder.resolve()) for folder in allowed_roots):
        raise ValueError("Workspace file is not available")
    if not target.is_file() or target.is_symlink() or target.stat().st_size > MAX_ATTACHMENT_BYTES:
        raise ValueError("Workspace file is unavailable or too large")
    return {"path": target.relative_to(root).as_posix(), "media_type": mimetypes.guess_type(target.name)[0] or "application/octet-stream", "content_base64": base64.b64encode(target.read_bytes()).decode("ascii")}
