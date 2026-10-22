import asyncio
import re
from datetime import UTC, datetime
from ipaddress import ip_network

from fastapi import HTTPException
from sqlalchemy import select

from app.db.session import SessionFactory
from app.gateway import cloud_v1
from app.models import User
from app.provisioning.history import compact_history
from app.provisioning.models import ProvisioningDeployment, ProvisioningServerLog
from app.provisioning.schemas import DeploymentCreate
from app.provisioning.variables import render_cloud_init_variables
from app.services.audit import write_audit
from app.core.time import db_now

TRANSIENT_CLOUD_STATES = {"", "accepted", "queued", "pending", "creating", "building", "build", "provisioning", "rebooting", "created", "starting", "starting_up"}
RUNNING_STATE_POLL_SECONDS = 10


def _items(payload):
    return payload.get("results", payload.get("items", payload if isinstance(payload, list) else []))


def _same(row, name):
    return str(row.get("name") or row.get("display_name") or "").casefold() == name.casefold()


def _volume_type(rows, requested: str, zone_id: str):
    """Resolve a user-facing SSD/HDD choice to an enabled type in the server zone."""
    requested_key = requested.strip().casefold()
    candidates = [
        row for row in rows
        if row.get("zone") == zone_id
        and row.get("status") == "enabled"
        and not row.get("multiattach", False)
    ]
    exact = next((row for row in candidates if _same(row, requested)), None)
    if exact:
        return exact.get("id")
    disk_key = requested_key if requested_key in {"ssd", "hdd"} else None
    match = next(
        (row for row in candidates if str(row.get("disk_type", "")).casefold() == disk_key),
        None,
    )
    return match.get("id") if match else None


async def _list(db, user, token, project, path, approval=None, params=None):
    data, _ = await cloud_v1.call(
        db, user, token, "GET", path, project,
        params={"page": 1, "page_size": 1000, **(params or {})}, approval=approval,
    )
    return _items(data)


async def _resolve(db, user, token, project, path, name, approval=None):
    row = next((x for x in await _list(db, user, token, project, path, approval) if _same(x, name)), None)
    return row.get("id") if row else None


async def _resolve_or_create(db, user, token, project, path, name, body, approval=None):
    value = await _resolve(db, user, token, project, path, name, approval)
    if value:
        return value
    if body is None:
        raise ValueError(f"Cloud resource {name!r} was not found")
    data, _ = await cloud_v1.call(db, user, token, "POST", path, project, body=body, approval=approval)
    return data.get("id") or data.get("uuid")


def _cidr(value):
    """Return a canonical CIDR when an upstream field contains one."""
    if not value:
        return None
    match = re.search(r"(?:\d{1,3}\.){3}\d{1,3}/\d{1,2}", str(value))
    if not match:
        return None
    try:
        return str(ip_network(match.group(0), strict=False))
    except ValueError:
        return None


async def _hydrate_private_network(db, user, token, project, server, subnet_id, approval=None):
    """Resolve the selected subnet/VPC once for cloud-init network variables."""
    subnet = next(
        (item for item in await _list(db, user, token, project, "/legacy/api/infra/subnets/", approval)
        if item.get("id") == subnet_id),
        None,
    )
    if not subnet:
        return
    server.subnet_cidr = _cidr(subnet.get("cidr"))
    vpc = subnet.get("vpc") if isinstance(subnet.get("vpc"), dict) else {}
    vpc_id = vpc.get("id") or subnet.get("vpc_id")
    vpc_cidr = _cidr(vpc.get("cidr")) or _cidr(vpc.get("display_name"))
    if vpc_id and not vpc_cidr:
        vpc_row = next(
            (item for item in await _list(db, user, token, project, "/legacy/api/infra/vpcs/", approval)
            if item.get("id") == vpc_id),
            None,
        )
        if vpc_row:
            vpc_cidr = _cidr(vpc_row.get("cidr")) or _cidr(vpc_row.get("display_name"))
    # Some Cloud API responses expose only the subnet CIDR. Keep the variable
    # useful rather than leaving it blank, while preferring an exact VPC CIDR.
    server.vpc_cidr = vpc_cidr or server.subnet_cidr


async def _create_server(db, user, token, project, manifest, server, approval, correlation):
    zone = server.zone_id or await _resolve(
        db, user, token, project, "/legacy/api/organization/zones/", server.zone, approval
    )
    if not zone:
        raise ValueError(f"Zone {server.zone!r} was not found")
    region_id = server.region_id
    if not region_id:
        regions = await _list(db, user, token, project, "/legacy/api/infra/server-regions/", approval)
        region_row = next(
            (x for x in regions if x.get("region_name") == manifest.region or _same(x, manifest.region)),
            None,
        )
        region_id = (region_row or {}).get("region") or manifest.region
    monitor_private_ip_id = None
    monitor_subnet_id = None
    if server.monitor_ip:
        monitor_subnet_id = server.teleport_monitor_subnet_id
        if not monitor_subnet_id:
            raise ValueError("Teleport monitor subnet is required when monitor IP is selected")
        monitor_rows = await _list(
            db, user, token, project,
            "/legacy/api/infra/private-ips/",
            approval,
            params={"subnet_id": monitor_subnet_id, "available": "true"},
        )
        monitor_row = next(
            (item for item in monitor_rows if item.get("ip_address") == server.monitor_ip),
            None,
        )
        if not monitor_row or not monitor_row.get("id"):
            raise ValueError(
                f"Available monitor IP {server.monitor_ip!r} was not found in subnet {monitor_subnet_id}"
            )
        attached = monitor_row.get("server")
        if attached:
            raise ValueError(f"Monitor IP {server.monitor_ip} is already attached to another server")
        monitor_private_ip_id = monitor_row["id"]
    if server.private_network_mode == "eni" or server.private_ip_mode == "existing":
        private_ip = {"type": "eni-key", "eni": server.eni_id}
        subnet = server.subnet_id
    else:
        subnet = server.subnet_id or await _resolve_or_create(
            db, user, token, project, "/legacy/api/infra/subnets/", server.subnet_name,
            None, approval,
        )
        private_ip = {"type": "subnet-key", "subnet": subnet}
    await _hydrate_private_network(db, user, token, project, server, subnet, approval)
    keypair = server.key_pair_id or await _resolve_or_create(
        db, user, token, project, "/legacy/api/infra/keypairs/", server.keypair,
        None, approval,
    )
    groups = list(server.security_group_ids)
    if not groups:
        for name in server.security_groups:
            groups.append(await _resolve_or_create(
                db, user, token, project, "/legacy/api/infra/security-groups/", name,
                None, approval,
            ))
    if server.volumes:
        volumes = [volume.model_dump(exclude={"volume_type_name", "mount_point"}) for volume in server.volumes]
    elif server.instance_family == "gpu":
        # GPU instances can boot from the selected image without an explicit
        # volume payload. Keep the normal fallback unchanged for Basic.
        volumes = []
    else:
        volume_types = await _list(
            db, user, token, project, "/legacy/api/infra/volume-type/", approval
        )
        volume_type = _volume_type(volume_types, server.disk_type, zone)
        if not volume_type:
            raise ValueError(f"Volume type {server.disk_type!r} was not found in zone")
        volumes = [{"volume_type": volume_type, "size": server.boot_disk_gb, "mount_as": "root"}]
        for disk in server.data_disks:
            disk_type = _volume_type(volume_types, disk.disk_type, zone)
            if not disk_type:
                raise ValueError(f"Volume type {disk.disk_type!r} was not found in zone")
            volumes.append({"volume_type": disk_type, "size": disk.size_gb, "mount_as": "data"})
    specs = {"server_type": server.instance_family, "kind": server.specs_kind}
    if server.specs_kind == "custom":
        specs.update({"ram": server.ram, "vcpus": server.vcpus})
    else:
        specs["flavor_name"] = server.flavor_name
    private_ips = [private_ip]
    # A selected primary private IP may also be used as the Teleport monitor IP.
    # Viettel Cloud accepts that as one interface only; sending the same ENI twice
    # produces a duplicate-IP request.  Keep the multi-IP payload for Teleport,
    # but de-duplicate the identical resource before it reaches Cloud API.
    monitor_uses_primary_ip = bool(
        monitor_private_ip_id
        and private_ip.get("type") == "eni-key"
        and str(private_ip.get("eni")) == str(monitor_private_ip_id)
    )
    if monitor_private_ip_id and not monitor_uses_primary_ip:
        primary_subnet_id = server.subnet_id
        if primary_subnet_id and monitor_subnet_id == primary_subnet_id:
            raise ValueError("Primary private subnet and Teleport monitor subnet must be different")
        private_ips.append({"type": "eni-key", "eni": monitor_private_ip_id})
    body = {
        "zone": zone, "name": server.name, "server_type": "on_demand",
        "specs": specs,
        "boot": {"public_image_name": server.image_name}, "key_pair": keypair,
        "enable_ipv4": server.enable_ipv4,
        "bandwidth": server.bandwidth,
        # Viettel Cloud requires the feature flag for both allocation modes.
        # Existing mode additionally supplies the selected ``elastic_ip`` id.
        "enable_elastic_ip": server.elastic_ip_mode != "none"
        or server.assign_public_ip,
        "volumes": volumes, "security_groups": groups,
    }
    # Preserve the existing create-server contract for normal deployments.
    # Only Teleport deployments use the multi-interface private_ips payload.
    if monitor_private_ip_id:
        body["private_ips"] = private_ips
    else:
        body["private_ip"] = private_ip
    if server.elastic_ip_mode == "existing" and server.elastic_ip_id:
        body["elastic_ip"] = server.elastic_ip_id
    if server.placement_group_id:
        body["placement_group"] = server.placement_group_id
    user_data = None
    if server.cloud_init_enabled:
        user_data = render_cloud_init_variables(server.cloud_init_content or "", server)
    if user_data:
        # Viettel's legacy server API accepts cloud-init as a raw JSON string.
        # The HTTP client serializes this object once, escaping newlines and
        # quotes as required by JSON; do not Base64 or JSON-encode it again.
        body["user_data"] = user_data
    response_data, _ = await cloud_v1.create_resource(
        db, user, token, project, "servers", body, approval
    )
    data = response_data[0] if isinstance(response_data, list) and response_data else response_data
    if not isinstance(data, dict):
        raise TypeError("Cloud API created the server but returned an unsupported response")
    return data


async def run_deployment(
    deployment_id: str,
    token: str,
    approval: str | None,
    manifest_data: dict | None = None,
):
    async with SessionFactory() as db:
        deployment = await db.scalar(
            select(ProvisioningDeployment).where(ProvisioningDeployment.id == deployment_id)
        )
        user = await db.get(User, deployment.user_id) if deployment else None
        if not deployment or not user:
            return
        manifest = DeploymentCreate.model_validate(manifest_data or deployment.manifest_json)
        if deployment.status == "queued":
            deployment.status = "running"
        deployment.started_at = db_now()
        await db.commit()

        async def wait_for_control() -> bool:
            while True:
                await db.refresh(deployment)
                if deployment.status in {"stopping", "stopped"}:
                    return False
                if deployment.status != "paused":
                    return True
                await asyncio.sleep(1)

        async def create_attempt(server, log: ProvisioningServerLog):
            log.status, log.started_at = "creating", db_now()
            await db.commit()
            try:
                if server.cloud_init_enabled:
                    # Preserve pre-create validation without persisting the rendered body.
                    render_cloud_init_variables(server.cloud_init_content or "", server)
                result = await _create_server(
                    db, user, token, deployment.project_id, manifest, server, approval,
                    deployment.correlation_id,
                )
                log.server_id = result.get("id") or result.get("uuid")
                state = str(result.get("power_state") or result.get("status") or "").lower()
                log.result_json = {
                    "id": log.server_id, "name": result.get("name", server.name),
                    "cloud_state": state or "accepted",
                    "stable": state not in TRANSIENT_CLOUD_STATES,
                    "cloud_response": compact_history(result),
                }
                return True, ""
            except Exception as exc:  # noqa: BLE001
                log.status = "failed"
                log.error_code = "cloud_api_error" if isinstance(exc, HTTPException) else "provisioning_error"
                log.error_message = str(exc)[:2000]
                log.result_json = {
                    "stable": True, "error_type": type(exc).__name__,
                    "cloud_response": compact_history(exc.detail) if isinstance(exc, HTTPException) else None,
                }
                return False, log.error_message
            finally:
                await db.commit()

        async def wait_for_running(log: ProvisioningServerLog) -> tuple[bool, str]:
            if not log.server_id:
                return False, "Cloud API did not return a server ID"
            deadline = asyncio.get_running_loop().time() + manifest.wait_for_running_seconds
            last_state = "accepted"
            while asyncio.get_running_loop().time() < deadline:
                if not await wait_for_control():
                    return False, "Deployment stopped by user"
                try:
                    detail, _ = await cloud_v1.call(
                        db, user, token, "GET",
                        f"/legacy/api/infra/servers/{log.server_id}/",
                        deployment.project_id, approval=approval,
                    )
                    last_state = str(detail.get("power_state") or detail.get("status") or "unknown").lower()
                    log.result_json = {
                        **(log.result_json or {}), "cloud_state": last_state,
                        "stable": last_state not in TRANSIENT_CLOUD_STATES,
                    }
                    await db.commit()
                    if last_state in {"running", "active"}:
                        return True, ""
                    if last_state in {"error", "failed"}:
                        return False, f"Server entered {last_state} state"
                except Exception as exc:  # transient detail failures are retried until deadline
                    last_state = f"check failed: {type(exc).__name__}"
                await asyncio.sleep(RUNNING_STATE_POLL_SECONDS)
            return False, f"Server did not reach running within {manifest.wait_for_running_seconds}s (last state: {last_state})"

        guarded = manifest.execution_mode == "guarded_sequential"
        stopped = False
        for index, server in enumerate(manifest.servers):
            if not await wait_for_control():
                stopped = True
                break
            if index and manifest.delay_between_create_ms:
                await asyncio.sleep(manifest.delay_between_create_ms / 1000)
            log = next(x for x in deployment.servers if x.server_name == server.name)
            api_created, error = await create_attempt(server, log)
            created = api_created
            if api_created and guarded:
                log.status = "waiting_for_running"
                await db.commit()
                created, error = await wait_for_running(log)
            if created:
                log.status, log.completed_at = "succeeded", db_now()
                deployment.succeeded_items += 1
                await db.commit()
                continue

            if deployment.status in {"stopping", "stopped"} or error == "Deployment stopped by user":
                log.status, log.completed_at = "stopped", db_now()
                await db.commit()
                stopped = True
                break

            log.status, log.completed_at = "failed", db_now()
            log.error_code = log.error_code or "not_running"
            log.error_message = error[:2000]
            deployment.failed_items += 1
            if deployment.error is None:
                deployment.error = f"{server.name}: {log.error_message}"
            await db.commit()

            if not guarded:
                continue
            if deployment.failed_items > manifest.failure_limit:
                deployment.status = "stopped"
                deployment.error = f"Stopped after exceeding failure limit ({manifest.failure_limit})"
                stopped = True
                break
            # A create-request failure is an attempt failure only. It must not
            # create an extra server because the Cloud API never accepted one.
            if not api_created:
                continue
            # Keep replacing this logical server until one reaches running, or
            # one of the explicit guardrails says to stop the deployment.
            while True:
                compensation_count = sum(
                    1 for row in deployment.servers if "-recovery-" in row.server_name
                )
                if compensation_count >= manifest.compensation_limit:
                    deployment.status = "stopped"
                    deployment.error = f"Stopped after reaching compensation limit ({manifest.compensation_limit})"
                    stopped = True
                    break
                replacement = server.model_copy(
                    update={"name": f"{server.name[:145]}-recovery-{compensation_count + 1}"}
                )
                replacement_log = ProvisioningServerLog(
                    server_name=replacement.name,
                    status="pending",
                    request_json=compact_history({**replacement.model_dump(mode="json"), "compensates": log.id}),
                )
                deployment.servers.append(replacement_log)
                deployment.total_items += 1
                await db.commit()
                replacement_api_created, error = await create_attempt(replacement, replacement_log)
                created = replacement_api_created
                if replacement_api_created:
                    replacement_log.status = "waiting_for_running"
                    await db.commit()
                    created, error = await wait_for_running(replacement_log)
                if created:
                    replacement_log.status, replacement_log.completed_at = "succeeded", db_now()
                    deployment.succeeded_items += 1
                    await db.commit()
                    break
                if deployment.status in {"stopping", "stopped"} or error == "Deployment stopped by user":
                    replacement_log.status, replacement_log.completed_at = "stopped", db_now()
                    stopped = True
                    await db.commit()
                    break
                replacement_log.status, replacement_log.completed_at = "failed", db_now()
                replacement_log.error_code = replacement_log.error_code or "not_running"
                replacement_log.error_message = error[:2000]
                deployment.failed_items += 1
                await db.commit()
                if deployment.failed_items > manifest.failure_limit:
                    deployment.status = "stopped"
                    deployment.error = f"Stopped after exceeding failure limit ({manifest.failure_limit})"
                    stopped = True
                    break
                # Do not compensate a request the Cloud API rejected. Move on
                # to the next original server unless the global failure limit
                # above has been exceeded.
                if not replacement_api_created:
                    break
            if stopped:
                break

        if stopped:
            deployment.status = "stopped"
            for row in deployment.servers:
                if row.status == "pending":
                    row.status, row.completed_at = "stopped", db_now()
        elif deployment.status not in {"stopping", "stopped"}:
            deployment.status = "succeeded" if not deployment.failed_items else ("failed" if not deployment.succeeded_items else "partial")
        deployment.completed_at = db_now()
        await db.commit()
        await write_audit(
            db, user, "provisioning.deployment.complete", deployment.status,
            project_id=deployment.project_id, target_type="provisioning_deployment",
            target_id=deployment.id, correlation_id=deployment.correlation_id,
            metadata={"total": deployment.total_items, "succeeded": deployment.succeeded_items, "failed": deployment.failed_items},
        )
