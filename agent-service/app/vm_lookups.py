"""Allow-listed, project-scoped reads used to plan VM deployments."""
from __future__ import annotations

import asyncio
from typing import Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.gateway import Caller, CloudToolGateway, settings
from app.security import redact

Resource = Literal["regions", "zones", "flavors", "images", "volume_types", "vpcs",
                   "subnets", "security_groups", "keypairs", "elastic_ips", "enis",
                   "private_ips", "placement_groups", "cloud_init_templates",
                   "cloud_init_template", "deployment_schema", "deployment_status"]
PATHS = {
    "regions": "/cloud/server-regions", "zones": "/cloud/zones",
    "flavors": "/cloud/server-flavors", "images": "/cloud/server-images",
    "volume_types": "/cloud/server-volume-types", "vpcs": "/cloud/server-vpcs",
    "subnets": "/cloud/subnets", "security_groups": "/cloud/server-security-groups",
    "keypairs": "/cloud/server-keypairs", "elastic_ips": "/cloud/server-elastic-ips",
    "enis": "/cloud/server-enis", "private_ips": "/cloud/private-ips",
    "placement_groups": "/cloud/server-placement-groups",
    "cloud_init_templates": "/cloud/cloud-init-templates",
    "deployment_schema": "/provisioning/deployment-schema",
}


class VmLookup(BaseModel):
    model_config = ConfigDict(extra="forbid")
    resource: Resource
    zone: str | None = Field(default=None, min_length=1, max_length=160)
    region_id: str | None = Field(default=None, min_length=1, max_length=160)
    subnet_id: str | None = Field(default=None, min_length=1, max_length=160)
    template_id: str | None = Field(default=None, min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._-]+$")
    deployment_id: str | None = Field(default=None, min_length=1, max_length=160, pattern=r"^[A-Za-z0-9._-]+$")
    family: Literal["basic", "gpu"] | None = None
    q: str | None = Field(default=None, max_length=200)
    ip_address: str | None = Field(default=None, max_length=64)
    page: int = Field(default=1, ge=1, le=1000)
    page_size: int = Field(default=50, ge=1, le=100)

    @model_validator(mode="after")
    def validate_filters(self):
        required = {"flavors": "zone", "volume_types": "zone", "vpcs": "region_id",
                    "security_groups": "region_id", "placement_groups": "region_id",
                    "private_ips": "subnet_id", "cloud_init_template": "template_id", "deployment_status": "deployment_id"}
        field = required.get(self.resource)
        if field and not (getattr(self, field) or "").strip():
            raise ValueError(f"{self.resource} requires {field} from a previous lookup")
        allowed = {"zone": {"flavors", "volume_types"},
                   "region_id": {"vpcs", "security_groups", "placement_groups"},
                   "subnet_id": {"private_ips"}, "family": {"flavors"},
                   "ip_address": {"private_ips"}, "template_id": {"cloud_init_template"}, "deployment_id": {"deployment_status"}}
        for key, resources in allowed.items():
            if getattr(self, key) is not None and self.resource not in resources:
                raise ValueError(f"{key} is not supported for {self.resource}")
        if self.q and self.resource in {"subnets", "private_ips"}:
            raise ValueError(f"q is not supported for {self.resource}; paginate or use ip_address")
        if self.resource in {"cloud_init_template", "deployment_schema", "deployment_status"} and (
            self.q or self.page != 1 or self.page_size != 50
        ):
            raise ValueError("Detail/schema requests do not support search or pagination")
        return self


class VmLookupBatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requests: list[VmLookup] = Field(min_length=1, max_length=16)


async def lookup(client: httpx.AsyncClient, gateway: CloudToolGateway, caller: Caller, request: VmLookup) -> dict:
    resource = request.resource
    if resource in {"cloud_init_template", "deployment_schema", "deployment_status"}:
        if resource == "deployment_status":
            data = await gateway._get(client, caller, f"/provisioning/deployments/{request.deployment_id}")
            compact = {key: data.get(key) for key in ("id", "status", "total_items", "succeeded_items", "failed_items", "error")}
            compact["servers"] = [{key: row.get(key) for key in ("server_name", "server_id", "status", "error_code", "error_message")}
                                  for row in data.get("servers", [])[:200]]
            return {"project_id": caller.project_id, "resource": resource, "data": redact(compact)}
        path = (f"/cloud/cloud-init-templates/{request.template_id}/planning-options"
                if resource == "cloud_init_template" else PATHS[resource])
        data = await gateway._get(client, caller, path)
        return {"project_id": caller.project_id, "resource": resource, "data": data}
    local_page = resource in {"zones", "cloud_init_templates"}
    params = {} if local_page else {"page": request.page, "page_size": request.page_size}
    for key in ("zone", "region_id", "subnet_id", "family", "ip_address"):
        if (value := getattr(request, key)) is not None:
            params[key] = value
    if resource == "flavors":
        params.setdefault("family", "basic")
    if resource == "private_ips":
        params["available"] = "true"
    if request.q and not local_page:
        params["q"] = request.q
    data = await gateway._get(client, caller, PATHS[resource], params or None)
    rows = gateway._items(data)
    if resource == "cloud_init_templates":
        # Templates are shared by the existing backend. Expose selection metadata,
        # never bulk bootstrap scripts or credentials in a catalog response.
        rows = [{k: row[k] for k in ("id", "name", "description", "os_family", "is_active") if k in row}
                for row in rows if row.get("is_active") is not False]
    if local_page:
        if request.q:
            needle = request.q.casefold()
            rows = [row for row in rows if any(needle in str(row.get(k, "")).casefold()
                    for k in ("id", "name", "display_name", "description"))]
        total = len(rows)
        start = (request.page - 1) * request.page_size
        items = rows[start:start + request.page_size]
        has_more = start + len(items) < total
    else:
        items = rows[:request.page_size]
        total = data.get("total", data.get("count")) if isinstance(data, dict) else None
        has_more = bool(data.get("next")) if isinstance(data, dict) else False
        if isinstance(total, int):
            has_more = has_more or request.page * request.page_size < total
        elif len(rows) >= request.page_size:
            has_more = True  # Unknown total: another page may exist.
    if resource == "keypairs":
        items = [{k: row[k] for k in ("id", "name", "display_name", "fingerprint", "region", "created_at") if k in row} for row in items]
    result = {"project_id": caller.project_id, "resource": resource,
              "filters": request.model_dump(exclude_none=True), "items": redact(items),
              "total": total, "page": request.page, "page_size": request.page_size,
              "has_more": has_more, "next_page": request.page + 1 if has_more else None}
    return result


async def lookup_many(gateway: CloudToolGateway, caller: Caller, requests: list[VmLookup]) -> dict:
    semaphore = asyncio.Semaphore(4)
    async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
        async def run(index, request):
            async with semaphore:
                try:
                    return {"index": index, "ok": True, "result": await lookup(client, gateway, caller, request)}
                except (HTTPException, httpx.RequestError) as exc:
                    status = exc.status_code if isinstance(exc, HTTPException) else 502
                    # No exception body/URL: upstream transports may carry credentials.
                    return {"index": index, "ok": False, "resource": request.resource,
                            "error": {"status": status, "message": "Project configuration lookup failed"}}
        return {"project_id": caller.project_id, "results": await asyncio.gather(
            *(run(index, request) for index, request in enumerate(requests)))}
