from datetime import timedelta
import re

from fastapi import APIRouter, HTTPException, Query
import json

from sqlalchemy import Float, String, and_, cast, delete, func, or_, select

from app.api.deps import Admin, AuditUser, Csrf, Db
from app.models import AuditLog, CloudApiLog
from app.services.audit import write_audit
from app.core.time import db_now

router = APIRouter(prefix="/logs", tags=["logs"])


def serialize(row):
    return {column.name: getattr(row, column.name) for column in row.__table__.columns}


def _contains(column, value: str):
    return func.lower(cast(column, String)).contains(value.lower())


def _searchable_columns(model):
    if model is AuditLog:
        return {
            "project_id": [model.project_id],
            "actor_email": [model.actor_email],
            "action": [model.action],
            "target": [model.target_type, model.target_id],
            "result": [model.result],
            "status": [model.result],
            "correlation_id": [model.correlation_id],
            "metadata_preview": [model.metadata_json],
        }
    return {
        "project_id": [model.project_id],
        "method": [model.method],
        "endpoint": [model.endpoint],
        "http_status": [model.http_status],
        "status": [model.status],
        "latency_ms": [model.latency_ms],
        "error_code": [model.error_code],
        "correlation_id": [model.correlation_id],
        "response_preview": [model.response_meta],
    }


_NUMERIC_TOKEN = r"[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?"


def _parse_numeric(value: str) -> float:
    return float(value.replace(",", ""))


def _numeric_comparison(columns, expression: str):
    """Build a safe SQLAlchemy numeric predicate; never interpolate user SQL."""
    source = expression.strip()
    single = re.fullmatch(
        rf"(?:(?:[a-z_][\w ]*)\s+)?(>=|>|<=|<|=)\s*({_NUMERIC_TOKEN})",
        source,
        re.IGNORECASE,
    )
    if single:
        operator, raw_value = single.groups()
        value = _parse_numeric(raw_value)
        predicates = {
            ">": lambda column: cast(column, Float) > value,
            ">=": lambda column: cast(column, Float) >= value,
            "<": lambda column: cast(column, Float) < value,
            "<=": lambda column: cast(column, Float) <= value,
            "=": lambda column: cast(column, Float) == value,
        }
        predicate = predicates.get(operator or "=")
        return or_(*[predicate(column) for column in columns])

    between = re.fullmatch(
        rf"({_NUMERIC_TOKEN})\s*(<=|<)\s*(?:[a-z_][\w ]*|value)\s*(<=|<)\s*({_NUMERIC_TOKEN})",
        source,
        re.IGNORECASE,
    )
    if not between:
        return None
    lower_raw, lower_operator, upper_operator, upper_raw = between.groups()
    lower, upper = _parse_numeric(lower_raw), _parse_numeric(upper_raw)
    if lower > upper:
        return None
    return or_(*[
        (cast(column, Float) > lower if lower_operator == "<" else cast(column, Float) >= lower)
        & (cast(column, Float) < upper if upper_operator == "<" else cast(column, Float) <= upper)
        for column in columns
    ])


def _text_comparison(columns, expression: str):
    """Case-insensitive exact/contains comparison without raw SQL."""
    match = re.fullmatch(
        r"(?:(?:[a-z_][\w ]*)\s+)?(!~|!=|>=|>|<=|<|~|=)\s*(.+)",
        expression.strip(),
        re.IGNORECASE,
    )
    if not match or not match.group(2).strip():
        return None
    operator, value = match.group(1), match.group(2).strip().lower()
    normalized = [func.lower(cast(column, String)) for column in columns]
    if operator == "=":
        return or_(*[column == value for column in normalized])
    if operator == "!=":
        return and_(*[column != value for column in normalized])
    if operator == "~":
        return or_(*[column.contains(value) for column in normalized])
    if operator == "!~":
        return and_(*[~column.contains(value) for column in normalized])
    predicates = {
        ">": lambda column: column > value,
        ">=": lambda column: column >= value,
        "<": lambda column: column < value,
        "<=": lambda column: column <= value,
    }
    predicate = predicates[operator]
    return or_(*[predicate(column) for column in normalized])


def _numeric_searchable_columns(model):
    if model is CloudApiLog:
        return {
            "http_status": [model.http_status],
            "latency_ms": [model.latency_ms],
        }
    return {}


async def page_rows(
    db, model, page, page_size, status=None, project_id=None, *, method=None,
    action=None, endpoint=None, q=None, search_column=None, search_values=None,
    search_mode=None, search_expression=None,
):
    page, page_size = max(1, page), min(max(1, page_size), 200)
    filters = []
    if status:
        filters.append(model.status == status if model is CloudApiLog else model.result == status)
    if project_id:
        filters.append(model.project_id == project_id)
    if method and model is CloudApiLog:
        filters.append(func.upper(model.method) == method.upper())
    if action and model is AuditLog:
        filters.append(_contains(model.action, action))
    if endpoint and model is CloudApiLog:
        filters.append(_contains(model.endpoint, endpoint))
    columns = _searchable_columns(model)
    if q and q.strip():
        filters.append(or_(*[_contains(column, q.strip()) for values in columns.values() for column in values]))
    if search_column:
        if search_mode == "comparison" and search_expression:
            numeric_columns = _numeric_searchable_columns(model).get(search_column, [])
            comparison = (
                _numeric_comparison(numeric_columns, search_expression)
                if numeric_columns
                else None
            )
            if comparison is None:
                comparison = _text_comparison(columns.get(search_column, []), search_expression)
            if comparison is not None:
                filters.append(comparison)
        elif search_values:
            selected_columns = columns.get(search_column)
            if not selected_columns:
                selected_columns = []
            try:
                values = json.loads(search_values)
            except (TypeError, ValueError):
                values = []
            values = [str(value).strip() for value in values if str(value).strip()]
            if values and selected_columns:
                filters.append(or_(*[_contains(column, value) for column in selected_columns for value in values]))
    total = await db.scalar(select(func.count()).select_from(model).where(*filters)) or 0
    rows = (
        await db.scalars(
            select(model)
            .where(*filters)
            .order_by(model.created_at.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
    ).all()
    return {
        "items": [serialize(x) for x in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }


@router.get("/audit")
async def audit_logs(
    user: AuditUser,
    db: Db,
    page: int = 1,
    page_size: int = 20,
    status: str | None = None,
    project_id: str | None = None,
    action: str | None = None,
    q: str | None = None,
    search_column: str | None = None,
    search_values: str | None = None,
    search_mode: str | None = None,
    search_expression: str | None = None,
):
    return await page_rows(
        db, AuditLog, page, page_size, status, project_id, action=action, q=q,
        search_column=search_column, search_values=search_values,
        search_mode=search_mode, search_expression=search_expression,
    )


@router.get("/cloud-api")
async def cloud_logs(
    user: AuditUser,
    db: Db,
    page: int = 1,
    page_size: int = 20,
    status: str | None = None,
    project_id: str | None = None,
    method: str | None = None,
    endpoint: str | None = None,
    q: str | None = None,
    search_column: str | None = None,
    search_values: str | None = None,
    search_mode: str | None = None,
    search_expression: str | None = None,
):
    return await page_rows(
        db, CloudApiLog, page, page_size, status, project_id, method=method,
        endpoint=endpoint, q=q, search_column=search_column,
        search_values=search_values, search_mode=search_mode,
        search_expression=search_expression,
    )


@router.delete("/{kind}")
async def clear_logs(
    kind: str,
    admin: Admin,
    _csrf: Csrf,
    db: Db,
    older_than_days: int | None = Query(None, ge=1, le=3650),
    all_records: bool = False,
):
    model = AuditLog if kind == "audit" else CloudApiLog if kind == "cloud-api" else None
    if model is None:
        raise HTTPException(404, "Unknown log type")
    if all_records == (older_than_days is not None):
        raise HTTPException(422, "Choose either all records or an older-than period")
    cutoff = db_now() - timedelta(days=older_than_days) if older_than_days else None
    statement = delete(model)
    if cutoff is not None:
        statement = statement.where(model.created_at < cutoff)
    result = await db.execute(statement)
    await db.commit()
    await write_audit(
        db,
        admin,
        f"logs.{kind}.cleanup",
        "success",
        metadata={
            "deleted_count": result.rowcount,
            "all_records": all_records,
            "older_than_days": older_than_days,
            "cutoff": cutoff.isoformat() if cutoff else None,
        },
    )
    return {
        "kind": kind,
        "deleted_count": result.rowcount,
        "all_records": all_records,
        "cutoff": cutoff,
    }
