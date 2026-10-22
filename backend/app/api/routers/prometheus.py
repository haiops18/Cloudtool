import json
import httpx
from cryptography.fernet import Fernet
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from app.api.deps import CliCommandUser, Csrf, Db, Operator
from app.core.config import get_settings
from app.models import PrometheusLink

router = APIRouter(prefix="/prometheus-links", tags=["Prometheus"])

class LinkIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=8, max_length=500)
    auth_type: str = "none"
    bearer_token: str = ""
    username: str = ""
    password: str = ""
    header_name: str = ""
    header_value: str = ""

class CheckIn(BaseModel):
    server_ips: dict[str, list[str]]
    label_selector: str = ""

def _label_matches(metric: dict, search: str) -> bool:
    """Match plain user text against any Prometheus label name or value."""
    needle = search.strip().lower()
    return not needle or any(
        needle in f"{key}={value}".lower() for key, value in metric.items()
    )

def _cipher():
    key = get_settings().PASSWORD_PROFILE_ENCRYPTION_KEY
    if not key: raise HTTPException(503, "Encryption is not configured")
    return Fernet(key.encode())

def _out(row): return {"id": row.id, "name": row.name, "url": row.url, "auth_type": row.auth_type}

@router.get("")
async def list_links(user: CliCommandUser, db: Db):
    rows = (await db.scalars(select(PrometheusLink).where(PrometheusLink.created_by == user.id).order_by(PrometheusLink.name))).all()
    return [_out(row) for row in rows]

@router.post("", status_code=201)
async def create_link(payload: LinkIn, user: Operator, _csrf: Csrf, db: Db):
    secret = _cipher().encrypt(json.dumps(payload.model_dump(exclude={"name","url","auth_type"})).encode()).decode()
    row = PrometheusLink(name=payload.name, url=payload.url.rstrip("/"), auth_type=payload.auth_type, ciphertext=secret, created_by=user.id)
    db.add(row); await db.commit(); await db.refresh(row)
    return _out(row)

@router.patch("/{link_id}")
async def update_link(link_id: str, payload: LinkIn, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(PrometheusLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    row.name, row.url, row.auth_type = payload.name, payload.url.rstrip("/"), payload.auth_type
    row.ciphertext = _cipher().encrypt(json.dumps(payload.model_dump(exclude={"name","url","auth_type"})).encode()).decode()
    await db.commit(); await db.refresh(row)
    return _out(row)

@router.delete("/{link_id}", status_code=204)
async def delete_link(link_id: str, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(PrometheusLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    await db.delete(row); await db.commit()

@router.post("/{link_id}/check")
async def check_link(link_id: str, payload: CheckIn, user: CliCommandUser, db: Db):
    row = await db.get(PrometheusLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    secret = json.loads(_cipher().decrypt((row.ciphertext or "").encode()).decode())
    headers, auth = {}, None
    if row.auth_type == "bearer": headers["Authorization"] = "Bearer " + secret.get("bearer_token","")
    elif row.auth_type == "basic": auth = (secret.get("username",""), secret.get("password",""))
    elif row.auth_type == "header" and secret.get("header_name"): headers[secret["header_name"]] = secret.get("header_value","")
    # Query the canonical availability metric and filter labels locally. This
    # keeps the input simple: users can type a label value, no PromQL required.
    query = "up"
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(row.url + "/api/v1/query", params={"query": query}, headers=headers, auth=auth)
            response.raise_for_status()
    except httpx.HTTPStatusError as error:
        try:
            message = error.response.json().get("error", error.response.text)
        except ValueError:
            message = error.response.text
        raise HTTPException(502, f"Prometheus rejected query `{query}`: {message[:500]}") from error
    except httpx.RequestError as error:
        raise HTTPException(502, f"Could not reach Prometheus: {error}") from error
    samples = [
        sample for sample in response.json().get("data",{}).get("result",[])
        if _label_matches(sample.get("metric", {}), payload.label_selector)
    ]
    results = []
    for server_id, ips in payload.server_ips.items():
        ip_results = []
        for ip in ips:
            matches = [
                sample for sample in samples
                if sample.get("metric", {}).get("instance", "").split(":")[0] == ip
            ]
            # A target is Up if any matching series reports up. This avoids a
            # duplicate series with a stale/down value masking a healthy target.
            is_up = any(sample.get("value", [None, "0"])[1] == "1" for sample in matches)
            ip_results.append({
                "ip": ip,
                "found": bool(matches),
                "down": bool(matches) and not is_up,
                "labels": matches[0].get("metric", {}) if matches else {},
            })
        found = any(item["found"] for item in ip_results)
        results.append({
            "server_id": server_id,
            "found": found,
            "down": found and not any(item["found"] and not item["down"] for item in ip_results),
            "labels": next((item["labels"] for item in ip_results if item["found"]), {}),
            "ip_results": ip_results,
        })
    return results
