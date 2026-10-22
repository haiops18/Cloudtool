"""Validate preallocated network resources for agent deployments only."""
from ipaddress import ip_address, ip_network

from fastapi import HTTPException

from app.gateway import cloud_v1


def relation(value):
    return str(value.get("id") or "") if isinstance(value, dict) else str(value or "")


async def validate_allocated_network(body, context, user, db):
    project, token, approval = context
    selected_private, selected_elastic = set(), set()
    # Validate modes and duplicates before any API calls. Merely supplying an ID
    # in auto mode would otherwise leave that resource unused and allocate another.
    for server in body.servers:
        existing_private = server.private_ip_mode == "existing" or server.private_network_mode == "eni"
        if server.eni_id and not existing_private:
            raise HTTPException(422, f"VM {server.name}: eni_id requires existing private IP mode")
        if server.elastic_ip_id and server.elastic_ip_mode != "existing":
            raise HTTPException(422, f"VM {server.name}: elastic_ip_id requires existing Elastic IP mode")
        for identifier, seen, label in ((server.eni_id, selected_private, "private IP"),
                                         (server.elastic_ip_id, selected_elastic, "Elastic IP")):
            if identifier:
                if identifier in seen:
                    raise HTTPException(422, f"The same {label} cannot be assigned to multiple VMs")
                # IDs become URL segments below; never accept paths or query text.
                if not all(c.isalnum() or c in "._-" for c in identifier):
                    raise HTTPException(422, f"Invalid {label} ID")
                seen.add(identifier)
        if existing_private and not server.subnet_id:
            raise HTTPException(422, f"VM {server.name}: exact subnet_id is required for a selected private IP")
    if not (selected_private or selected_elastic):
        return

    # Per-validation cache contains only resources actually selected by this
    # deployment. It is released when the request finishes, never held globally.
    cache = {}
    async def get(path):
        if path not in cache:
            data, _ = await cloud_v1.call(db, user, token, "GET", path, project, approval=approval)
            cache[path] = data
        return cache[path]

    zones = []
    page = 1
    while True:
        data, _ = await cloud_v1.call(db, user, token, "GET", "/legacy/api/organization/zones/", project,
                                     params={"page": page, "page_size": 200}, approval=approval)
        rows = data.get("results", [])
        zones.extend(rows)
        if not data.get("next") or not rows:
            break
        page += 1
        if page > 1000:
            raise HTTPException(502, "Could not complete zone lookup")

    for server in body.servers:
        if not (server.eni_id or server.elastic_ip_id):
            continue
        matches = [z for z in zones if (relation(z.get("id")) == server.zone_id if server.zone_id else
                   str(z.get("name") or z.get("display_name") or "").casefold() == server.zone.casefold())]
        if len(matches) != 1:
            raise HTTPException(422, f"VM {server.name}: select an exact zone for the allocated IPs")
        zone = matches[0]
        region = zone.get("region")
        region_values = {relation(region)} - {""}
        if isinstance(region, dict):
            region_values.update(str(region.get(k)) for k in ("name", "region_name", "display_name") if region.get(k))
        if not region_values:
            raise HTTPException(422, "Selected zone has no region metadata")
        if server.region_id and server.region_id not in region_values:
            raise HTTPException(422, f"VM {server.name}: region_id does not match its zone")
        server.zone_id = relation(zone.get("id"))
        if not server.region_id:
            server.region_id = relation(region)

        for identifier, resource in ((server.eni_id, "private-ips"), (server.elastic_ip_id, "elastic-ips")):
            if not identifier:
                continue
            row = await get(f"/legacy/api/infra/{resource}/{identifier}/")
            if relation(row.get("id")) != identifier or relation(row.get("project")) != project:
                raise HTTPException(403, "Selected IP does not belong to the current project")
            if row.get("server") is not None or (resource == "private-ips" and row.get("description") not in (None, "")):
                raise HTTPException(409, f"VM {server.name}: selected IP is no longer available")
            if relation(row.get("region")) not in region_values:
                raise HTTPException(422, f"VM {server.name}: selected IP region does not match its zone")
            try:
                address = str(ip_address(row.get("ip_address")))
            except ValueError:
                raise HTTPException(422, "Selected IP has no valid address") from None
            if resource == "private-ips":
                if relation(row.get("subnet")) != server.subnet_id:
                    raise HTTPException(422, f"VM {server.name}: selected private IP belongs to another subnet")
                if not all(c.isalnum() or c in "._-" for c in server.subnet_id):
                    raise HTTPException(422, "Invalid subnet ID")
                subnet = await get(f"/legacy/api/infra/subnets/{server.subnet_id}/")
                if relation(subnet.get("project")) != project:
                    raise HTTPException(403, "Selected subnet does not belong to current project")
                try:
                    network = ip_network(subnet.get("cidr", ""), strict=False)
                    if ip_address(address) not in network:
                        raise ValueError("Address outside subnet")
                except ValueError:
                    raise HTTPException(422, "Selected private IP does not match subnet CIDR") from None
                if server.eni_address and server.eni_address != address:
                    raise HTTPException(422, "Private IP address differs from the selected IP resource")
                server.eni_address = address
                server.private_ip = address
                server.subnet_cidr = str(network)
                server.zone_id = relation(zone.get("id"))
            else:
                if server.elastic_ip_address and server.elastic_ip_address != address:
                    raise HTTPException(422, "Elastic IP address differs from the selected IP resource")
                server.elastic_ip_address = address
