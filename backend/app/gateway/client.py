import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from curl_cffi.requests import AsyncSession as CurlAsyncSession
from curl_cffi.requests.exceptions import (
    ConnectionError as CurlConnectionError,
)
from curl_cffi.requests.exceptions import (
    Timeout as CurlTimeout,
)
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.time import db_now
from app.core.permissions import cloud_request_denial
from app.core.security import redact, redact_url
from app.gateway.debug import cloud_debug
from app.models import AuditLog, CloudApiLog, User

settings = get_settings()

CLOUD_AUDIT_ACTIONS = {
    "/legacy/api/tenant/organization/": (
        "cloud.organization.list",
        "cloud_organization",
    ),
    "/legacy/api/tenant/projects/": ("cloud.project.list", "cloud_project"),
    "/legacy/api/tenant/users/current-user/": (
        "cloud.user.current.view",
        "cloud_user",
    ),
}
CLOUD_MUTATION_AUDIT_ACTIONS = {
    ("POST", "/legacy/api/infra/elastic-ips/"): ("cloud.elastic_ip.create", "elastic_ip"),
}


def cloud_headers(
    authorization: str, correlation_id: str, project_id: str | None
) -> dict[str, str]:
    authorization = authorization.strip()
    # The Viettel Cloud API expects the full ``Authorization: Token <value>``
    # contract. Accept a raw console token as input as well, while preserving
    # an explicit Token/Bearer/other HTTP authorization scheme.
    if " " not in authorization:
        authorization = f"Token {authorization}"
    headers = {
        # The value entered by the user is the complete Authorization value,
        # for example "Token abc", "Bearer abc" or another supported scheme.
        "Authorization": authorization,
        "Content-Type": "application/json",
        # Match the known-good curl request instead of advertising an
        # inconsistent Postman user agent from an httpx transport.
        "Accept": "*/*",
        # The Cloudrity edge sometimes advertises compressed content while
        # returning an uncompressed body, which makes libcurl fail with
        # CURLE_BAD_CONTENT_ENCODING (-3). Match plain curl without
        # ``--compressed`` and request an identity response explicitly.
        "Accept-Encoding": "identity",
        "User-Agent": "curl/8.10.1",
        # Viettel Console sets this non-session locale cookie on its own API calls.
        # Keep every gateway request aligned with the working Postman/curl contract.
        "Cookie": "NEXT_LOCALE=vi",
    }
    if project_id:
        headers["project-id"] = project_id
    return headers


def curl_preview(
    method: str,
    url: str,
    headers: dict[str, str],
    body: Any,
    *,
    reveal_authorization: bool = False,
) -> str:
    safe_headers = {
        key: (
            "[REDACTED]"
            if key.lower()
            in {
                "authorization",
                "cookie",
                "set-cookie",
                "proxy-authorization",
                "x-cloud-token",
            }
            else value
        )
        for key, value in headers.items()
    }
    if reveal_authorization:
        for key, value in headers.items():
            if key.lower() == "authorization":
                safe_headers[key] = value
    parts = ["curl", "--location", json.dumps(redact_url(url)), "-X", method]
    for key, value in safe_headers.items():
        parts.extend(["--header", json.dumps(f"{key}: {value}")])
    if body is not None:
        parts.extend(
            [
                "--data",
                json.dumps(
                    json.dumps(redact(body), ensure_ascii=False, default=str)
                ),
            ]
        )
    return " ".join(parts)


class ApprovalStore:
    def __init__(self) -> None:
        self.items: dict[str, tuple[datetime, str, str]] = {}

    def signature(
        self, method: str, path: str, project: str | None, params: dict | None, body: Any
    ) -> str:
        raw = json.dumps(
            [method, path, project, params or {}, body],
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(raw.encode()).hexdigest()

    def create(self, user_id: str, signature: str) -> str:
        key = str(uuid4())
        self.items[key] = (datetime.now(UTC) + timedelta(minutes=2), user_id, signature)
        return key

    def consume(self, key: str | None, user_id: str, signature: str) -> bool:
        item = self.items.pop(key, None) if key else None
        return bool(item and item[0] > datetime.now(UTC) and item[1:] == (user_id, signature))


approvals = ApprovalStore()


class CloudApiGateway:
    def __init__(self) -> None:
        timeout = httpx.Timeout(
            settings.CLOUD_API_TIMEOUT_SECONDS, connect=settings.CLOUD_API_CONNECT_TIMEOUT_SECONDS
        )
        self.client = httpx.AsyncClient(
            base_url=settings.CLOUD_API_BASE_URL,
            timeout=timeout,
            follow_redirects=True,
            # Do not let machine-level HTTP(S)_PROXY variables silently send
            # Cloud API credentials through a different route than Postman.
            trust_env=False,
        )
        # Cloudrity allows curl/Postman but blocks Python/httpx POST requests.
        # Use libcurl for mutations while retaining httpx responses internally
        # so logging, error mapping and audit behavior remain unchanged.
        self.curl_client = CurlAsyncSession()
        self.semaphore = asyncio.Semaphore(settings.CLOUD_CONCURRENCY_LIMIT)

    async def close(self) -> None:
        await self.client.aclose()
        await self.curl_client.close()

    @staticmethod
    def _target(method: str, path: str) -> tuple[str, str]:
        """Resolve the upstream route without changing other Cloud APIs."""
        prefix = settings.CLOUD_API_SERVER_PREFIX.rstrip("/")
        if (
            settings.CLOUD_API_USE_SERVER_BASE_URL
            and settings.CLOUD_API_SERVER_BASE_URL
            and (not prefix or path == prefix or path.startswith(prefix + "/"))
        ):
            return settings.CLOUD_API_SERVER_BASE_URL, path[len(prefix):] or "/"
        if (
            method.upper() == "POST"
            and path.rstrip("/") == "/legacy/api/infra/servers"
            and settings.CLOUD_API_SERVER_BASE_URL
        ):
            prefix = settings.CLOUD_API_SERVER_PREFIX
            upstream_path = path[len(prefix):] if prefix and path.startswith(prefix) else path
            return settings.CLOUD_API_SERVER_BASE_URL, upstream_path or "/"
        return settings.CLOUD_API_BASE_URL, path

    async def request(
        self,
        db: AsyncSession,
        user: User,
        token: str,
        method: str,
        path: str,
        *,
        project_id: str | None = None,
        params: dict | None = None,
        body: Any = None,
        approval_id: str | None = None,
        correlation_id: str | None = None,
        request_timeout: float | None = None,
    ) -> tuple[Any, int]:
        correlation_id = correlation_id or str(uuid4())
        method = method.upper()
        if not path.startswith("/") or ".." in path or urlsplit(path).netloc:
            raise HTTPException(400, "Invalid upstream path")
        target_base, target_path = self._target(method, path)
        # Private-IP calls are available-only by default. `_include_all...`
        # is an internal, screen-specific marker (never sent upstream) used
        # solely by the Private IP inventory view.
        if method == "GET" and path.rstrip("/") == "/legacy/api/infra/private-ips":
            params = {**(params or {})}
            include_all = params.pop("_include_all_private_ips", None) == "true"
            if include_all:
                params.pop("available", None)
            else:
                params["available"] = "true"
        if denial := cloud_request_denial(user, method, path):
            raise HTTPException(403, denial)
        signature = approvals.signature(method, path, project_id, params, body)
        if settings.DEBUG_CLOUD_APPROVAL_MODE and not approvals.consume(
            approval_id, user.id, signature
        ):
            approval = approvals.create(user.id, signature)
            raise HTTPException(
                428,
                {
                    "code": "cloud_approval_required",
                    "approval_id": approval,
                    "preview": redact(
                        {
                            "method": method,
                            "path": path,
                            "project_id": project_id,
                            "params": params,
                            "body": body,
                        }
                    ),
                },
            )

        log = CloudApiLog(
            created_at=db_now(),
            user_id=user.id,
            project_id=project_id,
            correlation_id=correlation_id,
            method=method,
            # Store the actual upstream URL so the log does not look like the
            # public legacy endpoint when server creation is routed internally.
            endpoint=f"{target_base}{target_path}",
            status="started",
            request_meta=redact({
                "params": params,
                "body": body,
                "upstream_url": f"{target_base}{target_path}",
            }),
        )
        db.add(log)
        audit_log = None
        audit_config = CLOUD_MUTATION_AUDIT_ACTIONS.get((method.upper(), path)) or CLOUD_AUDIT_ACTIONS.get(path)
        if audit_config:
            action, target_type = audit_config
            audit_log = AuditLog(
                created_at=db_now(),
                user_id=user.id,
                actor_email=user.email,
                role=user.role.value,
                action=action,
                result="started",
                project_id=project_id,
                target_type=target_type,
                target_id=(params or {}).get("organization"),
                correlation_id=correlation_id,
                metadata_json=redact(
                    {
                        "method": method,
                        "endpoint": path,
                        "params": params,
                    }
                ),
            )
            db.add(audit_log)
        await db.commit()
        started = time.perf_counter()
        headers = cloud_headers(token, correlation_id, project_id)
        request_preview = self.client.build_request(
            method, f"{target_base}{target_path}", headers=headers, params=params, json=body
        )
        final_url = str(request_preview.url)
        cloud_debug(
            "request",
            correlation_id=correlation_id,
            method=method,
            base_url=target_base,
            path=target_path,
            url=final_url,
            project_id=project_id,
            params=params,
            headers=headers,
            body=body,
            content_length=len(request_preview.content),
            token_length=len(token),
            token_sha256=hashlib.sha256(token.encode()).hexdigest()[:12],
            curl=curl_preview(
                method,
                final_url,
                headers,
                body,
                reveal_authorization=(
                    settings.DEBUG
                    and settings.DEBUG_LOG_AUTHORIZATION
                    and settings.APP_ENV != "production"
                ),
            ),
        )
        try:
            async with self.semaphore:
                response = await self._send(
                    method, path, headers, params, body, request_timeout
                )
            try:
                payload = response.json() if response.content else None
            except ValueError:
                excerpt = " ".join(response.text.split())[:2000]
                payload = {
                    "message": "Upstream returned non-JSON data",
                    "content_type": response.headers.get("content-type"),
                    "server": response.headers.get("server"),
                    "request_id": response.headers.get("x-request-id")
                    or response.headers.get("cf-ray"),
                    "response_excerpt": excerpt,
                }
            debug_response_body = (
                payload
                if payload != {"message": "Upstream returned non-JSON data"}
                else {"raw_text": response.text}
            )
            log.completed_at = db_now()
            log.latency_ms = int((time.perf_counter() - started) * 1000)
            log.http_status = response.status_code
            log.status = (
                "accepted"
                if response.status_code == 202
                else ("completed" if response.is_success else "failed")
            )
            log.response_meta = redact(
                payload if isinstance(payload, dict) else {"type": type(payload).__name__}
            )
            if audit_log:
                audit_log.result = "success" if response.is_success else "failed"
                audit_log.metadata_json = redact(
                    {
                        **audit_log.metadata_json,
                        "http_status": response.status_code,
                        "returned_items": (
                            len(payload.get("results", []))
                            if isinstance(payload, dict)
                            and isinstance(payload.get("results"), list)
                            else None
                        ),
                        "total_items": (
                            payload.get("count") if isinstance(payload, dict) else None
                        ),
                    }
                )
            cloud_debug(
                "response",
                correlation_id=correlation_id,
                method=method,
                path=path,
                status_code=response.status_code,
                reason_phrase=response.reason_phrase,
                latency_ms=log.latency_ms,
                url=str(response.request.url),
                request_headers=dict(response.request.headers),
                redirect_history=[
                    {
                        "status_code": item.status_code,
                        "url": str(item.request.url),
                        "location": item.headers.get("location"),
                    }
                    for item in response.history
                ],
                headers=dict(response.headers),
                body=debug_response_body,
                content_length=len(response.content),
            )
            if not response.is_success:
                log.error_code = self._error_code(response.status_code)
            await db.commit()
            if not response.is_success:
                raise HTTPException(
                    self._local_status(response.status_code),
                    {
                        "code": log.error_code,
                        "message": "Cloud API request failed",
                        "upstream_status": response.status_code,
                        "upstream_detail": (
                            redact(payload.get("detail"))
                            or redact(payload.get("response_excerpt"))
                            or redact(payload.get("message"))
                            if isinstance(payload, dict)
                            else None
                        ),
                        "correlation_id": correlation_id,
                    },
                )
            return payload, response.status_code
        except HTTPException:
            raise
        except (
            httpx.TimeoutException,
            httpx.NetworkError,
            CurlTimeout,
            CurlConnectionError,
        ) as exc:
            log.completed_at = db_now()
            log.latency_ms = int((time.perf_counter() - started) * 1000)
            log.status = "failed"
            log.error_code = (
                "timeout"
                if isinstance(exc, (httpx.TimeoutException, CurlTimeout))
                else "upstream_unavailable"
            )
            if audit_log:
                audit_log.result = "failed"
                audit_log.metadata_json = {
                    **audit_log.metadata_json,
                    "error_code": log.error_code,
                    "error_type": type(exc).__name__,
                }
            cloud_debug(
                "error",
                correlation_id=correlation_id,
                method=method,
                path=path,
                latency_ms=log.latency_ms,
                error_type=type(exc).__name__,
                error_code=log.error_code,
                message=str(exc),
            )
            await db.commit()
            raise HTTPException(
                504 if isinstance(exc, (httpx.TimeoutException, CurlTimeout)) else 503,
                {
                    "code": log.error_code,
                    "message": "Cloud API unavailable",
                    "correlation_id": correlation_id,
                },
            ) from None

    async def _send(
        self,
        method: str,
        path: str,
        headers: dict,
        params: dict | None,
        body: Any,
        request_timeout: float | None = None,
    ) -> httpx.Response:
        attempts = settings.CLOUD_API_RETRY_COUNT + 1 if method == "GET" else 1
        for attempt in range(attempts):
            delay_seconds = 0.25 * (2**attempt)
            try:
                target_base, target_path = self._target(method, path)
                cloud_debug(
                    "attempt",
                    method=method,
                    path=path,
                    attempt=attempt + 1,
                    total_attempts=attempts,
                )
                if method in {"POST", "PUT", "PATCH", "DELETE"}:
                    curl_response = await self.curl_client.request(
                        method,
                        f"{target_base}{target_path}",
                        headers=headers,
                        params=params,
                        json=body,
                        allow_redirects=True,
                        timeout=request_timeout or settings.CLOUD_API_TIMEOUT_SECONDS,
                    )
                    response = httpx.Response(
                        curl_response.status_code,
                        headers=dict(curl_response.headers),
                        content=curl_response.content,
                        request=httpx.Request(method, curl_response.url),
                    )
                else:
                    request_options = (
                        {"timeout": request_timeout}
                        if request_timeout is not None
                        else {}
                    )
                    response = await self.client.request(
                        method,
                        target_path,
                        headers=headers,
                        params=params,
                        json=body,
                        **request_options,
                    )
                if response.status_code not in {429, 502, 503, 504} or attempt == attempts - 1:
                    return response
                cloud_debug(
                    "retry_response",
                    method=method,
                    url=str(response.request.url),
                    attempt=attempt + 1,
                    status_code=response.status_code,
                    reason_phrase=response.reason_phrase,
                    headers=dict(response.headers),
                    body=response.text,
                    next_retry_delay_ms=int(delay_seconds * 1000),
                )
            except (
                httpx.TimeoutException,
                httpx.NetworkError,
                CurlTimeout,
                CurlConnectionError,
            ) as exc:
                if attempt == attempts - 1:
                    raise
                cloud_debug(
                    "retry_error",
                    method=method,
                    path=path,
                    attempt=attempt + 1,
                    error_type=type(exc).__name__,
                    message=str(exc),
                    next_retry_delay_ms=int(delay_seconds * 1000),
                )
            await asyncio.sleep(delay_seconds)
        raise RuntimeError("Unreachable retry state")

    @staticmethod
    def _error_code(code: int) -> str:
        return {
            401: "authentication",
            403: "authorization",
            404: "not_found",
            409: "conflict",
            422: "validation",
            429: "rate_limit",
        }.get(code, "unexpected_upstream")

    @staticmethod
    def _local_status(code: int) -> int:
        # A valid web session can have expired Cloud credentials. Reserve 401
        # for web authentication so the UI does not sign the user out.
        if code == 401:
            return 403
        return code if code in {400, 401, 403, 404, 409, 422, 429} else 502


gateway = CloudApiGateway()
