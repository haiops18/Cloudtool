from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.gateway.client import gateway
from app.core.config import get_settings
from app.models import User


class ViettelCloudV1:
    async def _collect_list_pages(
        self,
        request_page,
        *,
        page: int,
        size: int,
    ):
        """Fetch every page of a Cloud API list without changing callers.

        The upstream occasionally omits ``next`` even when ``count`` shows
        more rows.  Continue while either signal says there are rows left, but
        stop safely if an upstream page is empty or repeats cannot make
        progress.
        """
        upstream_size = min(max(1, size), get_settings().CLOUD_API_LIST_PAGE_SIZE)
        # Always start at the upstream first page: the merged object promises
        # a complete list, independent of the caller's presentation page.
        current_page = 1
        data, status = await request_page(current_page, upstream_size)
        if not isinstance(data, dict) or not isinstance(data.get("results"), list):
            return data, status

        results = list(data["results"])
        try:
            total = max(0, int(data.get("count", len(results))))
        except (TypeError, ValueError):
            total = len(results)
        # A count-based limit covers APIs which return next=null prematurely.
        max_requests = max(2, (total + upstream_size - 1) // upstream_size) + 1
        requests = 1
        has_next = bool(data.get("next"))
        while (has_next or len(results) < total) and requests < max_requests:
            current_page += 1
            next_data, status = await request_page(current_page, upstream_size)
            if not isinstance(next_data, dict) or not isinstance(next_data.get("results"), list):
                break
            page_rows = next_data["results"]
            if not page_rows:
                break
            results.extend(page_rows)
            has_next = bool(next_data.get("next"))
            try:
                total = max(total, int(next_data.get("count", total)))
            except (TypeError, ValueError):
                pass
            requests += 1

        merged = dict(data)
        merged["results"] = results
        merged["count"] = total
        merged["next"] = None
        return merged, status

    async def call(
        self,
        db: AsyncSession,
        user: User,
        token: str,
        method: str,
        path: str,
        project: str | None,
        *,
        params: dict | None = None,
        body: Any = None,
        approval: str | None = None,
        timeout_seconds: float | None = None,
    ):
        # Enforce the upstream page cap for every GET list call, including
        # specialised router calls which do not go through list_resource.
        if method.upper() == "GET" and params and "page_size" in params:
            params = dict(params)
            try:
                params["page_size"] = min(
                    max(1, int(params["page_size"])),
                    get_settings().CLOUD_API_LIST_PAGE_SIZE,
                )
            except (TypeError, ValueError):
                params["page_size"] = get_settings().CLOUD_API_LIST_PAGE_SIZE
        return await gateway.request(
            db,
            user,
            token,
            method,
            path,
            project_id=project,
            params=params,
            body=body,
            approval_id=approval,
            request_timeout=timeout_seconds,
        )

    async def organizations(self, db, user, token, page, size, approval=None):
        return await self._collect_list_pages(
            lambda current_page, upstream_size: self.call(
                db, user, token, "GET", "/legacy/api/tenant/organization/", None,
                params={"page": current_page, "page_size": upstream_size}, approval=approval,
            ),
            page=page, size=size,
        )

    async def projects(
        self, db, user, token, page, size, organization=None, q=None, approval=None
    ):
        params = {}
        params.update({"organization": organization} if organization else {"direct_access": "true"})
        if q:
            params["q"] = q
        return await self._collect_list_pages(
            lambda current_page, upstream_size: self.call(
                db, user, token, "GET", "/legacy/api/tenant/projects/", None,
                params={**params, "page": current_page, "page_size": upstream_size}, approval=approval,
            ),
            page=page, size=size,
        )

    async def current_user(self, db, user, token, project, approval=None):
        return await self.call(
            db,
            user,
            token,
            "GET",
            "/legacy/api/tenant/users/current-user/",
            project,
            approval=approval,
        )

    async def list_resource(
        self, db, user, token, project, resource, page, size, params=None, approval=None, timeout_seconds=None
    ):
        query = dict(params or {})
        if resource == "private-ips":
            # The default remains available-only for every caller. The
            # private-IP inventory screen alone can send this internal marker
            # to request all addresses; the gateway client removes it before
            # forwarding upstream.
            if query.get("_include_all_private_ips") != "true":
                query["available"] = "true"
        return await self._collect_list_pages(
            lambda current_page, upstream_size: self.call(
                db, user, token, "GET", f"/legacy/api/infra/{resource}/", project,
                params={**query, "page": current_page, "page_size": upstream_size}, approval=approval,
                **({"timeout_seconds": timeout_seconds} if timeout_seconds is not None else {}),
            ),
            page=page, size=size,
        )

    async def create_resource(
        self, db, user, token, project, resource, body, approval=None
    ):
        """Create an infra resource through the same audited Cloud gateway."""
        return await self.call(
            db,
            user,
            token,
            "POST",
            f"/legacy/api/infra/{resource}/",
            project,
            body=body,
            approval=approval,
        )


    async def create_elastic_ip(self, db, user, token, project, region, approval=None):
        """Allocate an Elastic IP using the documented legacy Cloud contract."""
        return await self.create_resource(
            db, user, token, project, "elastic-ips",
            {"region": region, "enable_ipv6": False}, approval,
        )


cloud_v1 = ViettelCloudV1()
