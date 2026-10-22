from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from typing import Any

import httpx
from fastapi import HTTPException, Request

from app.config import get_settings
from app.security import redact

settings = get_settings()
TARGET_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f-]{27,36}|(?:\d{1,3}\.){3}\d{1,3}", re.I)


@dataclass(frozen=True)
class Caller:
    email: str
    role: str
    project_id: str
    cloud_token: str
    cookie: str
    csrf_token: str | None


class CloudToolGateway:
    """A hard allow-list. No caller-controlled backend URL or method exists."""

    async def caller(self, request: Request, *, require_cloud_token: bool = True) -> Caller:
        project_id = request.headers.get("X-Project-Id", "").strip()
        cloud_token = request.headers.get("X-Cloud-Token", "").strip()
        cookie = request.headers.get("cookie", "")
        csrf = request.headers.get("X-CSRF-Token", "")
        if not project_id or not cookie or (require_cloud_token and not cloud_token):
            raise HTTPException(400, "Project, Cloud session and CloudTool login are required")
        # POST chat remains read-only, but requiring the existing anti-CSRF
        # header prevents browser forms from invoking the agent endpoint.
        if not csrf:
            raise HTTPException(403, "Missing CSRF token")
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.get(
                f"{settings.backend_url}/auth/me",
                headers={"cookie": cookie},
            )
        if response.status_code != 200:
            raise HTTPException(401, "CloudTool session is invalid or expired")
        user = response.json()
        role = user.get("role")
        role_name = role if isinstance(role, str) else (role or {}).get("name", "")
        permissions = set(user.get("permissions") or [])
        if role_name not in {"admin", "operator"} and "servers" not in permissions:
            raise HTTPException(403, "Your CloudTool role cannot use project analysis")
        return Caller(
            str(user.get("email", "")), str(role_name), project_id, cloud_token,
            cookie, user.get("csrf_token"),
        )

    def _headers(self, caller: Caller) -> dict[str, str]:
        return {
            "cookie": caller.cookie,
            "X-Project-Id": caller.project_id,
            "X-Cloud-Token": caller.cloud_token,
        }

    async def _get(self, client: httpx.AsyncClient, caller: Caller, path: str, params: dict | None = None) -> Any:
        response = await client.get(
            f"{settings.backend_url}{path}", headers=self._headers(caller), params=params
        )
        if response.status_code in {401, 403}:
            raise HTTPException(response.status_code, "CloudTool denied this read-only lookup")
        if not response.is_success:
            # Never leak an unhandled httpx error as an Agent Service 500. The
            # caller gets a clear upstream lookup failure and can retry later.
            status = response.status_code if 400 <= response.status_code < 500 else 502
            raise HTTPException(status, f"CloudTool lookup failed for {path}")
        return response.json()

    async def _best_effort_get(
        self, client: httpx.AsyncClient, caller: Caller, path: str, params: dict | None = None
    ) -> Any | Exception:
        """Read a secondary workspace source without failing its whole snapshot.

        Security groups and subnets can legitimately disappear between their
        list request and a per-resource lookup.  Retry transient upstream
        failures once, then return the error to the caller so it can retain
        the rest of the project data and report a precise warning.
        """
        try:
            return await self._get(client, caller, path, params)
        except (httpx.RequestError, HTTPException) as first_error:
            # A denied or invalid CloudTool session cannot recover with a
            # retry; preserve the error for the normal caller handling.
            if isinstance(first_error, HTTPException) and first_error.status_code < 500:
                return first_error
            await asyncio.sleep(0.25)
            try:
                return await self._get(client, caller, path, params)
            except (httpx.RequestError, HTTPException) as retry_error:
                return retry_error

    async def post_security_group_rule(self, caller: Caller, security_group_id: str, rule: dict[str, Any]) -> Any:
        """One explicitly allow-listed write endpoint; caller approval is enforced by the UI route."""
        headers = {**self._headers(caller), "X-CSRF-Token": caller.csrf_token or ""}
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            response = await client.post(f"{settings.backend_url}/cloud/security-groups/{security_group_id}/rules", headers=headers, json={"items": [rule]})
        if response.status_code in {401, 403}:
            raise HTTPException(response.status_code, "CloudTool denied security-group rule creation")
        response.raise_for_status()
        return response.json()

    async def security_groups_for_template(self, caller: Caller) -> list[dict]:
        """Read the same project Security Group list used by the web template."""
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            return self._items(await self._get(client, caller, "/cloud/security-groups"))

    async def security_group_name(self, caller: Caller, security_group_id: str) -> str | None:
        for group in await self.security_groups_for_template(caller):
            if str(group.get("id")) == security_group_id:
                return str(group.get("name") or group.get("display_name") or group.get("displayName") or group.get("title") or "").strip() or None
        return None

    async def server_creation_template_lookups(self, caller: Caller) -> dict[str, list[str]]:
        """Load the same read-only lookup APIs used by Terraform's Template button."""
        def label(item: dict) -> str:
            return str(item.get("display_name") or item.get("name") or item.get("ip_address") or item.get("id") or "").strip()

        def relation(value: Any) -> str:
            return str(value.get("id") or value.get("region") or "") if isinstance(value, dict) else str(value or "")

        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            zones_data, images_data, keypairs_data, subnets_data, elastic_data, cloud_init_data = await asyncio.gather(
                self._get(client, caller, "/cloud/zones"),
                self._get(client, caller, "/cloud/server-images"),
                self._get(client, caller, "/cloud/server-keypairs"),
                self._get(client, caller, "/cloud/subnets"),
                self._get(client, caller, "/cloud/server-elastic-ips"),
                self._get(client, caller, "/cloud/cloud-init-templates"),
            )
            zones = self._items(zones_data)
            subnets = self._items(subnets_data)
            region_ids = sorted({relation(zone.get("region")) for zone in zones if relation(zone.get("region"))})
            flavor_pages, volume_pages, group_pages, placement_pages, private_pages = await asyncio.gather(
                asyncio.gather(*[self._get(client, caller, "/cloud/server-flavors", {"zone": str(zone.get("id")), "family": family}) for zone in zones if zone.get("id") for family in ("basic", "gpu")]),
                asyncio.gather(*[self._get(client, caller, "/cloud/server-volume-types", {"zone": str(zone.get("id"))}) for zone in zones if zone.get("id")]),
                asyncio.gather(*[self._get(client, caller, "/cloud/server-security-groups", {"region_id": region}) for region in region_ids]),
                asyncio.gather(*[self._get(client, caller, "/cloud/server-placement-groups", {"region_id": region}) for region in region_ids]),
                asyncio.gather(*[self._get(client, caller, "/cloud/private-ips", {"subnet_id": str(subnet.get("id")), "available": "true"}) for subnet in subnets if subnet.get("id")]),
            )
        # The nested endpoints all return ordinary CloudTool item pages.  A
        # flat, de-duplicated value list is precisely what the Excel dropdowns
        # in Terraform consume, without exposing credentials to Codex.
        flatten = lambda pages: [item for page in pages for item in self._items(page)]
        values = lambda rows: list(dict.fromkeys(value for value in (label(row) for row in rows) if value))
        return {
            "zones": values(zones), "images": values(self._items(images_data)), "keypairs": values(self._items(keypairs_data)),
            "subnets": values(subnets), "elastic_ips": values([item for item in self._items(elastic_data) if item.get("server") is None]),
            "cloud_init_templates": values([item for item in self._items(cloud_init_data) if item.get("is_active") is not False]),
            "flavors": values(flatten(flavor_pages)), "volume_types": values(flatten(volume_pages)), "security_groups": values(flatten(group_pages)),
            "placement_groups": values(flatten(placement_pages)), "private_ips": values(flatten(private_pages)),
        }

    async def simple_project_data(self, caller: Caller) -> dict[str, Any]:
        """Fetch the complete, live source set for the compact CSV workspace.

        This is intentionally separate from ``collect``: it must include every
        group rule and VPC, while chat evidence remains targeted and bounded.
        """
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            servers_page, vpcs_page, subnets_page, groups_page, zones_page, images_page, elastic_ips_page = await asyncio.gather(
                self._get(client, caller, "/cloud/servers", {"page_size": 200}),
                # Network management is mounted below /cloud/network.  The
                # server-creation VPC endpoint requires a region and is not a
                # project-wide inventory source, so use this all-VPC route.
                self._get(client, caller, "/cloud/network/vpcs", {"page_size": 200}),
                self._get(client, caller, "/cloud/subnets", {"page_size": 200}),
                self._get(client, caller, "/cloud/security-groups"),
                self._get(client, caller, "/cloud/zones"),
                self._get(client, caller, "/cloud/server-images", {"page_size": 200}),
                self._get(client, caller, "/cloud/elastic-ips", {"page_size": 200}),
            )
            groups = self._items(groups_page)
            subnets = self._items(subnets_page)
            rule_groups = [group for group in groups if group.get("id")]
            private_ip_subnets = [subnet for subnet in subnets if subnet.get("id")]
            rules_pages = await asyncio.gather(
                *[self._best_effort_get(client, caller, f"/cloud/security-groups/{group['id']}/rules") for group in rule_groups],
                return_exceptions=True,
            )
            private_ips_pages = await asyncio.gather(
                *[self._best_effort_get(client, caller, "/cloud/private-ips", {"subnet_id": str(subnet["id"]), "include_all": "true", "page_size": 200}) for subnet in private_ip_subnets],
                return_exceptions=True,
            )
            inventory = await self._live_server_inventory(client, caller, servers_page)
        warnings: list[str] = []
        rule_bundles: list[dict[str, Any]] = []
        for group, page in zip(rule_groups, rules_pages):
            if isinstance(page, Exception):
                name = str(group.get("name") or group.get("display_name") or group.get("id"))
                warnings.append(f"Rules for security group '{name}' were unavailable; its CSV rows were skipped.")
                # Keep the group in the data so its rule count stays explicit
                # (zero fetched), rather than silently dropping it.
                rule_bundles.append({"security_group": group, "rules": [], "unavailable": str(page)})
            else:
                rule_bundles.append({"security_group": group, "rules": self._items(page)})
        for subnet, page in zip(private_ip_subnets, private_ips_pages):
            if isinstance(page, Exception):
                name = str(subnet.get("name") or subnet.get("display_name") or subnet.get("id"))
                warnings.append(f"Private IPs for subnet '{name}' were unavailable; dependent CSV fields may be incomplete.")
        return {
            "servers": inventory,
            "vpcs": self._items(vpcs_page),
            "subnets": self._items(subnets_page),
            "security_groups": groups,
            "zones": self._items(zones_page),
            "images": self._items(images_page),
            "elastic_ips": self._items(elastic_ips_page),
            "private_ips": [item for page in private_ips_pages if not isinstance(page, Exception) for item in self._items(page)],
            "security_group_rules": rule_bundles,
            "_warnings": warnings,
        }

    @staticmethod
    def _items(data: Any) -> list[dict]:
        return data.get("items", data.get("results", [])) if isinstance(data, dict) else (data if isinstance(data, list) else [])

    async def _all_servers(self, client: httpx.AsyncClient, caller: Caller, first_page: Any) -> list[dict]:
        """Read every current server summary before loading its live detail."""
        servers = self._items(first_page)
        total = first_page.get("total") if isinstance(first_page, dict) else None
        try:
            total = int(total) if total is not None else None
        except (TypeError, ValueError):
            total = None
        page = 2
        while page <= 1_000 and (total is None or len(servers) < total):
            payload = await self._get(client, caller, "/cloud/servers", {"page": page, "page_size": 200})
            batch = self._items(payload)
            if not batch:
                break
            servers.extend(batch)
            if len(batch) < 200:
                break
            page += 1
        return servers

    async def _live_server_inventory(self, client: httpx.AsyncClient, caller: Caller, first_page: Any) -> list[dict]:
        """Build inventory from Cloud API server-detail responses, never the DB cache."""
        servers = await self._all_servers(client, caller, first_page)
        server_ids = [str(item["id"]) for item in servers if item.get("id")]
        details: list[dict] = []
        failures: list[str] = []
        # Bound concurrent upstream requests while still making a project refresh
        # practical. A partial inventory is misleading, so surface any failure.
        for start in range(0, len(server_ids), 10):
            batch = await asyncio.gather(
                *[self._get(client, caller, f"/cloud/servers/{server_id}") for server_id in server_ids[start:start + 10]],
                return_exceptions=True,
            )
            for server_id, value in zip(server_ids[start:start + 10], batch):
                if isinstance(value, Exception):
                    failures.append(server_id)
                elif isinstance(value, dict):
                    details.append(value)
                else:
                    failures.append(server_id)
        if failures:
            raise HTTPException(502, f"Could not retrieve live Cloud API details for {len(failures)} server(s)")
        return details

    async def collect(
        self, caller: Caller, question: str, sources: set[str] | None = None, *, snapshot: bool = False
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Load a bounded, project-only evidence pack through CloudTool APIs."""
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            targets = {value.lower() for value in TARGET_RE.findall(question)}
            available_calls = {
                "servers": lambda: self._get(client, caller, "/cloud/servers", {"page_size": 200}),
                "subnets": lambda: self._get(client, caller, "/cloud/subnets", {"page_size": 200}),
                "security_groups": lambda: self._get(client, caller, "/cloud/security-groups"),
                "elastic_ips": lambda: self._get(client, caller, "/cloud/elastic-ips", {"page_size": 200}),
                "audit_events": lambda: self._get(client, caller, "/logs/audit", {"project_id": caller.project_id, "page_size": 50}),
                "cloud_api_history": lambda: self._get(client, caller, "/logs/cloud-api", {"project_id": caller.project_id, "page_size": 50}),
            }
            selected = sources or set(available_calls)
            fetch_sources = (selected - {"inventory"}) | ({"servers"} if {"inventory", "security_group_rules"} & selected else set()) | ({"subnets"} if "private_ips" in selected else set())
            base_calls = {key: call for key, call in available_calls.items() if key in fetch_sources}
            results = await asyncio.gather(*(call() for call in base_calls.values()), return_exceptions=True)
            data: dict[str, Any] = {}
            evidence: list[dict[str, Any]] = []
            for name, value in zip(base_calls, results):
                if isinstance(value, Exception):
                    data[name] = {"unavailable": str(value)}
                    evidence.append({"source": name, "count": 0, "note": "Access unavailable"})
                else:
                    data[name] = value
                    evidence.append({"source": name, "count": len(self._items(value))})

            servers = self._items(data.get("servers"))
            inventory = self._items(data.get("inventory"))
            selected_servers = [
                item for item in servers
                if any(target in str(item).lower() for target in targets)
            ][:5]
            if not selected_servers and len(servers) == 1:
                selected_servers = servers
            needs_details = bool({"server_details", "security_group_rules", "private_ips"} & selected)
            details = await asyncio.gather(
                *[self._get(client, caller, f"/cloud/servers/{item['id']}") for item in selected_servers if item.get("id")],
                return_exceptions=True,
            ) if needs_details else []
            server_details = [item for item in details if not isinstance(item, Exception)]
            if "server_details" in selected:
                data["server_details"] = server_details
            if server_details and "server_details" in selected:
                evidence.append({"source": "server_details", "count": len(server_details)})

            group_ids: set[str] = set()
            for detail in server_details:
                for group in detail.get("security_groups") or []:
                    group_ids.add(str(group.get("id") if isinstance(group, dict) else group))
            rule_calls = [self._get(client, caller, f"/cloud/security-groups/{group_id}/rules") for group_id in list(group_ids)[:20] if group_id]
            rules = await asyncio.gather(*rule_calls, return_exceptions=True)
            if "security_group_rules" in selected:
                data["security_group_rules"] = [item for item in rules if not isinstance(item, Exception)]
            if data.get("security_group_rules"):
                evidence.append({"source": "security_group_rules", "count": sum(len(self._items(x)) for x in data["security_group_rules"])})

            if "inventory" in selected:
                inventory = await self._live_server_inventory(client, caller, data.get("servers"))
                data["inventory"] = inventory
                evidence.append({"source": "inventory", "count": len(inventory), "note": "Live Cloud API server details"})
            subnet_ids: set[str] = {
                str(item.get("id")) for item in self._items(data.get("subnets")) if item.get("id")
            }
            for detail in server_details:
                candidates = detail.get("private_ips") or [detail.get("private_ip")]
                for item in candidates:
                    if isinstance(item, dict) and item.get("subnet"):
                        subnet_ids.add(str(item["subnet"]))
            ip_calls = [
                self._get(client, caller, "/cloud/private-ips", {
                    "subnet_id": subnet_id, "include_all": "true", "page_size": 200,
                })
                for subnet_id in list(subnet_ids)[:50]
            ]
            private_ips = await asyncio.gather(*ip_calls, return_exceptions=True)
            if "private_ips" in selected:
                data["private_ips"] = [item for item in private_ips if not isinstance(item, Exception)]
            if data.get("private_ips"):
                evidence.append({"source": "private_ips", "count": sum(len(self._items(x)) for x in data["private_ips"])})

        safe_data = redact(data)
        # The model gets a bounded evidence pack even for unusually large
        # projects; UI counts still describe every source that was queried.
        if not snapshot and len(json.dumps(safe_data, ensure_ascii=False).encode()) > settings.MAX_CONTEXT_BYTES:
            for key in ("servers", "inventory", "subnets", "security_groups", "audit_events", "cloud_api_history"):
                value = safe_data.get(key)
                if isinstance(value, dict):
                    item_key = "items" if isinstance(value.get("items"), list) else "results"
                    if isinstance(value.get(item_key), list):
                        value[item_key] = value[item_key][:50]
                elif isinstance(value, list):
                    safe_data[key] = value[:50]
        return {key: value for key, value in safe_data.items() if key in selected}, evidence
