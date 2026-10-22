from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.deps import Admin, CliCommandUser, Csrf, Db
from app.models.entities import CliCommand
from app.schemas.common import CliCommandIn, CliCommandPatch
from app.services.audit import write_audit

router = APIRouter(prefix="/cli-commands", tags=["CLI commands"])


def command_out(item: CliCommand) -> dict:
    return {
        "id": item.id,
        "name": item.name,
        "category": item.category,
        "description": item.description,
        "command": item.command,
        "shared_variables": item.shared_variables or {},
        "is_favorite": item.is_favorite,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


@router.get("")
async def list_commands(user: CliCommandUser, db: Db):
    rows = (
        await db.scalars(
            select(CliCommand)
            .order_by(CliCommand.is_favorite.desc(), CliCommand.category, CliCommand.name)
        )
    ).all()
    return [command_out(item) for item in rows]


@router.post("", status_code=201)
async def create_command(payload: CliCommandIn, user: Admin, _csrf: Csrf, db: Db):
    item = CliCommand(created_by=user.id, **payload.model_dump())
    db.add(item)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A CLI command with this name already exists") from None
    await db.refresh(item)
    await write_audit(db, user, "cli_command.create", "success", target_type="cli_command", target_id=item.id)
    return command_out(item)


@router.patch("/{command_id}")
async def update_command(command_id: str, payload: CliCommandPatch, user: Admin, _csrf: Csrf, db: Db):
    item = await db.get(CliCommand, command_id)
    if not item:
        raise HTTPException(404, "CLI command not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(item, key, value)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(409, "A CLI command with this name already exists") from None
    await db.refresh(item)
    await write_audit(db, user, "cli_command.update", "success", target_type="cli_command", target_id=item.id)
    return command_out(item)


@router.delete("/{command_id}", status_code=204)
async def delete_command(command_id: str, user: Admin, _csrf: Csrf, db: Db):
    item = await db.get(CliCommand, command_id)
    if not item:
        raise HTTPException(404, "CLI command not found")
    await db.delete(item)
    await db.commit()
    await write_audit(db, user, "cli_command.delete", "success", target_type="cli_command", target_id=command_id)
    return Response(status_code=204)
