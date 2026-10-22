import base64
import asyncio
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shlex
import select as io_select
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from urllib.parse import urlparse

import httpx
from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.api.deps import CliCommandUser, Csrf, Db, Operator, UserDep
from app.core.config import get_settings
from app.core.time import db_now
from app.models import TeleportLink
from app.services.teleport_script import is_interactive_password_script, render_script_delays, run_timed_terminal, script_steps

router = APIRouter(prefix="/teleport-links", tags=["Teleport"])
_sessions: dict[tuple[str, str], tuple[str, float]] = {}
_tsh_terminal_tickets: dict[str, "TshTerminalTicket"] = {}

def cipher():
    key = get_settings().PASSWORD_PROFILE_ENCRYPTION_KEY
    if not key: raise HTTPException(503, "Encryption is not configured")
    return Fernet(key.encode())


def session_ttl_seconds(session: dict) -> int:
    """Use Teleport's advertised expiry, with a safe fallback for older APIs."""
    value = session.get("expires_in")
    try:
        if value is not None:
            return max(60, int(float(value)) - 30)
    except (TypeError, ValueError):
        pass
    # Some clusters return a JWT but omit expires_in.  Read its unverified exp
    # claim only to decide when to ask the user to authenticate again.
    token = session.get("token")
    if isinstance(token, str) and token.count(".") >= 2:
        try:
            segment = token.split(".")[1] + "==="
            expires_at = int(json.loads(base64.urlsafe_b64decode(segment)).get("exp", 0))
            if expires_at:
                return max(60, expires_at - int(time.time()) - 30)
        except (ValueError, TypeError, json.JSONDecodeError):
            pass
    # Legacy Teleport Web API versions do not expose expiry. Their web session
    # is normally long-lived; an authorization failure below remains the source
    # of truth and clears this persisted token immediately.
    return 8 * 60 * 60

class LinkIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    url: str = Field(min_length=8, max_length=500)
    verify_tls: bool = True
    tsh_path: str = Field(default="", max_length=1000)

class CheckIn(BaseModel):
    username: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=500)
    otp: str = Field(default="", max_length=12)
    server_ips: dict[str, list[str]]


class TshLoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=1, max_length=500)
    otp: str = Field(min_length=6, max_length=12, pattern=r"^\d+$")


class TshSshIn(BaseModel):
    host: str = Field(min_length=1, max_length=253, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    login: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    command: str = Field(min_length=1, max_length=4000)


class TshTerminalIn(BaseModel):
    host: str = Field(min_length=1, max_length=253, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
    login: str = Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class TshSessionRefreshIn(BaseModel):
    pass


class TshDownloadIn(TshTerminalIn):
    remote_path: str = Field(min_length=1, max_length=1024)


@dataclass
class TshTerminalTicket:
    args: list[str]
    home: Path
    binary: str
    expires_at: float

def out(row):
    return {"id": row.id, "name": row.name, "url": row.url, "verify_tls": row.verify_tls, "tsh_path": row.tsh_path or ""}

def base_url(value: str):
    parsed = urlparse(value)
    if parsed.scheme != "https" or not parsed.netloc:
        raise HTTPException(422, "Teleport endpoint must use HTTPS")
    return f"{parsed.scheme}://{parsed.netloc}"


def tsh_home(user_id: str, link_id: str) -> Path:
    settings = get_settings()
    root = (
        Path(settings.TELEPORT_TSH_HOME)
        if settings.TELEPORT_TSH_HOME
        else Path(__file__).resolve().parents[3] / "data" / "teleport-tsh"
    )
    # Do not expose user or endpoint identifiers in the local filesystem.
    key = hashlib.sha256(f"{user_id}:{link_id}".encode()).hexdigest()
    path = root / key
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        # Windows ACLs are inherited; the service account remains the owner.
        pass
    return path


def issue_tsh_terminal_ticket(args: list[str], home: Path, binary: str) -> str:
    now = time.monotonic()
    for value in [key for key, ticket in _tsh_terminal_tickets.items() if ticket.expires_at <= now]:
        _tsh_terminal_tickets.pop(value, None)
    token = secrets.token_urlsafe(32)
    _tsh_terminal_tickets[token] = TshTerminalTicket(args=args, home=home, binary=binary, expires_at=now + 60)
    return token


def take_tsh_terminal_ticket(token: str) -> TshTerminalTicket | None:
    ticket = _tsh_terminal_tickets.pop(token, None)
    return ticket if ticket and ticket.expires_at > time.monotonic() else None


def tsh_binaries() -> list[dict[str, str]]:
    command = get_settings().TELEPORT_TSH_COMMAND
    candidates: set[Path] = set()
    resolved = shutil.which(command) or (command if Path(command).is_file() else None)
    if resolved:
        candidates.add(Path(resolved).resolve())
    search_directories = {Path(entry) for entry in os.environ.get("PATH", "").split(os.pathsep) if entry}
    if resolved:
        search_directories.add(Path(resolved).resolve().parent)
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        # User-scoped installs work without administrator access on Windows.
        search_directories.add(Path(local_app_data) / "CloudTool" / "tsh")
    for directory in search_directories:
        if directory.is_dir():
            candidates.update(path.resolve() for path in directory.glob("tsh*") if path.is_file())
    versions = []
    for path in sorted(candidates, key=lambda item: str(item).lower()):
        try:
            completed = subprocess.run([str(path), "version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=False)
            output = (completed.stdout + completed.stderr).decode(errors="replace")
            match = re.search(r"(?:Teleport )?v?(\d+\.\d+(?:\.\d+)?)", output, re.IGNORECASE)
            if completed.returncode == 0 and match:
                versions.append({"path": str(path), "version": match.group(1)})
        except (OSError, subprocess.TimeoutExpired):
            continue
    return versions


def tsh_binary(link: TeleportLink | None = None) -> str:
    selected = (link.tsh_path if link else "") or ""
    available = tsh_binaries()
    if selected:
        selected_path = str(Path(selected).resolve())
        if any(item["path"] == selected_path for item in available):
            return selected_path
        # Saved links imported from Windows contain paths such as
        # ``C:\\Windows\\tsh.exe``.  They cannot exist in the Linux container;
        # use the image's managed tsh binary instead of making every imported
        # link unusable.
        if ("\\" in selected or (len(selected) > 1 and selected[1] == ":")) and available:
            return available[0]["path"]
        raise HTTPException(422, "The selected tsh version is no longer installed on the backend host")
    resolved = shutil.which(get_settings().TELEPORT_TSH_COMMAND)
    if resolved:
        return str(Path(resolved).resolve())
    if available:
        return available[0]["path"]
    raise HTTPException(503, "tsh is not installed on the backend host. Set TELEPORT_TSH_COMMAND to its executable path.")


async def run_tsh(
    *args: str,
    home: Path,
    input_data: str = "",
    allow_error: bool = False,
    binary: str | None = None,
    max_output_chars: int = 12_000,
) -> tuple[int, str]:
    settings = get_settings()
    environment = os.environ.copy()
    environment["TELEPORT_HOME"] = str(home)
    environment["TELEPORT_ADD_KEYS_TO_AGENT"] = "no"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        # Uvicorn commonly runs a Selector event loop on Windows, which raises
        # NotImplementedError for asyncio subprocess APIs. Run the blocking
        # process in a worker thread instead; this also works on Proactor and
        # Unix event loops without involving a shell.
        completed = await asyncio.to_thread(
            subprocess.run,
            [binary or tsh_binary(), *args],
            input=input_data.encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=environment,
            creationflags=creationflags,
            timeout=settings.TELEPORT_TSH_TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "tsh timed out on the backend host") from None
    except OSError as error:
        raise HTTPException(503, f"Could not start tsh on the backend host: {error}") from error
    output = (completed.stdout + completed.stderr).decode(errors="replace").strip()
    if completed.returncode and not allow_error:
        raise HTTPException(502, f"tsh failed: {output[-4000:] or 'unknown error'}")
    # Commands that return a node inventory need the complete JSON document.
    # Keep the existing bounded output by default for command/terminal errors.
    return completed.returncode or 0, output[-max_output_chars:] if max_output_chars > 0 else output


def redact_tsh_output(output: str, input_data: str) -> str:
    for secret in filter(None, input_data.splitlines()):
        output = output.replace(secret, "[redacted]")
    # ConPTY may emit terminal capability sequences even for a short command.
    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output)


def tsh_login_response(output: str, responses: list[str], sent: int) -> str | None:
    """Return the next credential only after tsh has displayed a login prompt."""
    if sent >= len(responses):
        return None
    # tsh writes prompts without a newline. Inspect only the recent terminal
    # text so an older prompt cannot trigger an additional credential write.
    visible = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output[-1000:]).lower()
    prompt = r"(?:password|passcode|otp|one[- ]time|verification code)[^\r\n]{0,200}(?::|\?)\s*$"
    return responses[sent] if re.search(prompt, visible) else None


def run_tsh_terminal_sync(args: list[str], home: Path, input_data: str, binary: str | None = None) -> tuple[int, str]:
    """Run tsh in a pseudo terminal for its intentionally terminal-only login.

    Linux/macOS use the standard-library PTY. Windows uses pywinpty's ConPTY
    wrapper. Both implementations pass the same isolated environment and
    collect terminal output without a shell.
    """
    settings = get_settings()
    environment = os.environ.copy()
    environment["TELEPORT_HOME"] = str(home)
    environment["TELEPORT_ADD_KEYS_TO_AGENT"] = "no"
    command = [binary or tsh_binary(), *args]
    deadline = time.monotonic() + settings.TELEPORT_TSH_TIMEOUT_SECONDS
    output: list[str] = []
    responses = [value for value in input_data.splitlines() if value]
    sent = 0

    if os.name == "nt":
        try:
            from winpty import PtyProcess
        except ImportError as error:
            raise HTTPException(503, "pywinpty is required for tsh login on Windows. Install the backend dependencies.") from error
        process = PtyProcess.spawn(command, env=environment)
        try:
            while process.isalive():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    process.terminate(force=True)
                    raise TimeoutError
                readable, _, _ = io_select.select([process], [], [], min(remaining, 0.25))
                if readable:
                    try:
                        chunk = process.read(4096)
                        output.append(chunk)
                    except EOFError:
                        break
                    response = tsh_login_response(chunk, responses, sent)
                    if response is not None:
                        # CRLF is required by the Windows console input buffer.
                        # tsh turns echo off; redact_tsh_output is a second guard.
                        process.write(f"{response}\r\n")
                        sent += 1
            while io_select.select([process], [], [], 0)[0]:
                try:
                    output.append(process.read(4096))
                except EOFError:
                    break
            process.wait()
            code = process.exitstatus or 0
        finally:
            process.close(force=True)
    else:
        import pty

        master, slave = pty.openpty()
        process = subprocess.Popen(
            command,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            env=environment,
            close_fds=True,
        )
        os.close(slave)
        try:
            while process.poll() is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    process.kill()
                    raise TimeoutError
                readable, _, _ = io_select.select([master], [], [], min(remaining, 0.25))
                if readable:
                    try:
                        chunk = os.read(master, 4096).decode(errors="replace")
                        output.append(chunk)
                    except OSError:
                        break
                    response = tsh_login_response(chunk, responses, sent)
                    if response is not None:
                        os.write(master, f"{response}\n".encode())
                        sent += 1
            while io_select.select([master], [], [], 0)[0]:
                try:
                    chunk = os.read(master, 4096)
                except OSError:
                    break
                if not chunk:
                    break
                output.append(chunk.decode(errors="replace"))
            code = process.wait()
        finally:
            os.close(master)
    return code, redact_tsh_output("".join(output).strip(), input_data)[-12000:]


async def run_tsh_terminal(*args: str, home: Path, input_data: str, binary: str | None = None) -> tuple[int, str]:
    try:
        return await asyncio.to_thread(run_tsh_terminal_sync, list(args), home, input_data, binary)
    except TimeoutError:
        raise HTTPException(504, "tsh login timed out on the backend host") from None
    except OSError as error:
        raise HTTPException(503, f"Could not start tsh on the backend host: {error}") from error


def tsh_proxy(link: TeleportLink) -> str:
    # tsh expects host[:port], while saved links are canonical HTTPS URLs.
    return urlparse(link.url).netloc


async def tsh_proxy_address(link: TeleportLink) -> str:
    """Return the endpoint explicitly selected by the operator.

    Teleport's ``/webapi/ping`` can advertise a different ``public_addr``.
    Replacing the saved endpoint with that address made an IP-based link
    depend on DNS for the advertised hostname, even when the operator had
    deliberately configured a reachable IP.  Keep the saved host[:port] for
    every tsh operation so login, SSH and SCP all use the same endpoint.
    """
    return tsh_proxy(link)


def tsh_status_value(output: str, label: str) -> str | None:
    match = re.search(rf"^\s*{re.escape(label)}:\s*(.+?)\s*$", output, re.MULTILINE)
    return match.group(1) if match else None


async def tsh_session_info(user_id: str, link: TeleportLink) -> dict | None:
    code, output = await run_tsh(
        "status", "--format=text", home=tsh_home(user_id, link.id), allow_error=True, binary=tsh_binary(link)
    )
    if code:
        return None
    valid_until = tsh_status_value(output, "Valid until")
    valid_for = re.search(r"\[valid for ([^\]]+)\]", valid_until or "")
    return {
        "id": link.id,
        "endpoint_name": link.name,
        "endpoint_url": link.url,
        "username": tsh_status_value(output, "Logged in as") or "Unknown user",
        "cluster": tsh_status_value(output, "Cluster"),
        "valid_until": valid_until.split(" [valid for", 1)[0] if valid_until else None,
        "valid_for": valid_for.group(1) if valid_for else None,
    }

def names(value):
    if isinstance(value, dict):
        for item in value.values():
            yield from names(item)
    elif isinstance(value, list):
        for item in value: yield from names(item)
    elif isinstance(value, str):
        yield value


def teleport_node_name(node: object) -> str | None:
    """Return the resource name accepted by ``tsh ssh`` for a node payload."""
    if not isinstance(node, dict):
        return None
    metadata = node.get("metadata")
    spec = node.get("spec")
    candidates = (
        metadata.get("name") if isinstance(metadata, dict) else None,
        spec.get("hostname") if isinstance(spec, dict) else None,
        node.get("hostname"),
        node.get("name"),
    )
    return next((value for value in candidates if isinstance(value, str) and value), None)


def teleport_node_display_name(node: object) -> str | None:
    """Return a friendly hostname instead of Teleport's opaque resource UID."""
    if not isinstance(node, dict):
        return None
    metadata = node.get("metadata")
    spec = node.get("spec")
    labels = metadata.get("labels") if isinstance(metadata, dict) else None
    candidates = (
        spec.get("hostname") if isinstance(spec, dict) else None,
        node.get("hostname"),
        labels.get("hostname") if isinstance(labels, dict) else None,
        labels.get("host") if isinstance(labels, dict) else None,
        teleport_node_name(node),
    )
    return next((value for value in candidates if isinstance(value, str) and value), None)


def node_contains_ip(node: object, address: str) -> bool:
    """Match an address value exactly, allowing Teleport's ``IP:port`` form."""
    for value in names(node):
        host = value.removesuffix("]").removeprefix("[")
        if host == address or host.startswith(f"{address}:"):
            return True
    return False


def node_label_summary(node: object) -> str:
    if not isinstance(node, dict):
        return ""
    for key, value in node.items():
        if key == "labels" and isinstance(value, dict):
            labels = [f"{name}: {item}" for name, item in value.items() if isinstance(item, str)]
            if labels:
                return " · ".join(labels)
        nested = node_label_summary(value)
        if nested:
            return nested
    return ""


def node_ip_addresses(node: object) -> list[str]:
    found: list[str] = []
    for value in names(node):
        for candidate in re.findall(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])", value):
            try:
                ipaddress.ip_address(candidate)
            except ValueError:
                continue
            if candidate not in found:
                found.append(candidate)
    return found


def tsh_nodes_from_output(output: str) -> list[object]:
    content = output.lstrip()
    try:
        response = json.loads(content)
    except json.JSONDecodeError as error:
        # tsh can prepend connection warnings to stderr before its JSON stdout.
        # Parse the first line that starts a JSON array/object instead of
        # rejecting an otherwise valid inventory.
        response = None
        for match in re.finditer(r"(?m)^[\[{]", content):
            try:
                response = json.loads(content[match.start() :])
                break
            except json.JSONDecodeError:
                continue
        if response is None:
            raise HTTPException(502, "tsh returned an invalid node list") from error
    nodes = response.get("items", response.get("nodes", [])) if isinstance(response, dict) else response
    if not isinstance(nodes, list):
        raise HTTPException(502, "tsh returned an invalid node list")
    return nodes


async def tsh_host_for_request(user_id: str, link: TeleportLink, requested_host: str) -> str:
    """Resolve a VM IP to its Teleport node name when the caller supplied an IP.

    An IP may appear in the Teleport UI as a node address but it is usually not
    the node resource name. ``tsh ssh`` addresses the resource name, so inspect
    the nodes visible to this user's already-authenticated tsh session first.
    """
    try:
        ipaddress.ip_address(requested_host)
        requested_is_ip = True
    except ValueError:
        requested_is_ip = False

    # A successful login saves the cluster's public route in this profile.
    # Do not override it with the originally saved IP: Teleport rejects that
    # mixed route as ``403 invalid session``.
    args: list[str] = ["--insecure"] if not link.verify_tls else []
    home = tsh_home(user_id, link.id)
    # Cloud VMs are commonly registered with their address as the `ip` label,
    # while their Teleport resource name is a hostname or UUID. Ask Teleport to
    # resolve that label first: `--format=names` returns exactly the value tsh
    # ssh accepts and avoids coupling this flow to JSON schema changes.
    if requested_is_ip:
        label_query = f'labels["ip"] == "{requested_host}"'
        code, output = await run_tsh(
            *args,
            "ls",
            "--format=names",
            f"--query={label_query}",
            home=home,
            allow_error=True,
            binary=tsh_binary(link),
        )
        if code == 0:
            names_output = [line.strip() for line in output.splitlines() if line.strip()]
            if names_output:
                return names_output[0]

    # Some clusters expose the address in `addr`, a different label, or a
    # nested resource field. Retain the complete JSON fallback for those.
    args.extend(["ls", "--format=json"])
    code, output = await run_tsh(
        *args,
        home=tsh_home(user_id, link.id),
        allow_error=True,
        binary=tsh_binary(link),
        max_output_chars=20_000_000,
    )
    if code:
        return requested_host
    try:
        response = json.loads(output)
    except json.JSONDecodeError:
        return requested_host
    nodes = response.get("items", response.get("nodes", [])) if isinstance(response, dict) else response
    if not isinstance(nodes, list):
        return requested_host
    for node in nodes:
        if node_contains_ip(node, requested_host) or teleport_node_display_name(node) == requested_host:
            name = teleport_node_name(node)
            if name:
                return name
    return requested_host

@router.get("")
async def list_links(user: CliCommandUser, db: Db):
    rows = (await db.scalars(select(TeleportLink).where(TeleportLink.created_by == user.id).order_by(TeleportLink.name))).all()
    return [out(row) for row in rows]

@router.post("", status_code=201)
async def create_link(payload: LinkIn, user: Operator, _csrf: Csrf, db: Db):
    tsh_path = tsh_binary(TeleportLink(tsh_path=payload.tsh_path)) if payload.tsh_path else ""
    row = TeleportLink(name=payload.name, url=base_url(payload.url), verify_tls=payload.verify_tls, tsh_path=tsh_path, created_by=user.id)
    db.add(row); await db.commit(); await db.refresh(row)
    return out(row)

@router.patch("/{link_id}")
async def update_link(link_id: str, payload: LinkIn, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    tsh_path = tsh_binary(TeleportLink(tsh_path=payload.tsh_path)) if payload.tsh_path else ""
    row.name, row.url, row.verify_tls, row.tsh_path = payload.name, base_url(payload.url), payload.verify_tls, tsh_path
    row.session_ciphertext, row.session_expires_at = None, None
    _sessions.pop((user.id, link_id), None)
    await db.commit(); await db.refresh(row)
    return out(row)


@router.get("/tsh/versions")
async def list_tsh_versions(_user: Operator):
    versions = tsh_binaries()
    if not versions:
        raise HTTPException(503, "No tsh executable was found on the backend host")
    return versions

@router.delete("/{link_id}", status_code=204)
async def delete_link(link_id: str, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    await db.delete(row); await db.commit()


@router.get("/tsh/sessions")
async def list_tsh_sessions(user: UserDep, db: Db):
    rows = (
        await db.scalars(
            select(TeleportLink)
            .where(TeleportLink.created_by == user.id)
            .order_by(TeleportLink.name)
        )
    ).all()
    sessions = await asyncio.gather(*(tsh_session_info(user.id, row) for row in rows))
    return [session for session in sessions if session]

@router.get("/{link_id}/session")
async def session_status(link_id: str, user: CliCommandUser, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    return {"active": bool(row.session_ciphertext and row.session_expires_at and row.session_expires_at > db_now())}


@router.get("/{link_id}/tsh/session")
async def tsh_session_status(link_id: str, user: Operator, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    code, output = await run_tsh("status", home=tsh_home(user.id, link_id), allow_error=True, binary=tsh_binary(row))
    return {"active": code == 0, "detail": output[-1000:] if output else None}


@router.post("/{link_id}/tsh/session/refresh")
async def refresh_tsh_session(link_id: str, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    code, output = await run_tsh("status", home=tsh_home(user.id, link_id), allow_error=True, binary=tsh_binary(row))
    if code:
        raise HTTPException(401, f"tsh session is expired or unavailable: {output[-2000:] or 'sign in again'}")
    return {"active": True, "detail": output[-1000:] if output else "tsh session is active"}


async def tsh_scp_args(link_id: str, host: str, login: str, user_id: str, db: Db) -> tuple[list[str], Path, str]:
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user_id:
        raise HTTPException(404, "Link not found")
    # Use the authenticated profile route rather than forcing the login IP.
    args = ["--insecure"] if not row.verify_tls else []
    args.extend(["scp", f"--login={login}"])
    return args, tsh_home(user_id, link_id), tsh_binary(row)


@router.post("/{link_id}/tsh/files/upload")
async def tsh_upload_file(link_id: str, user: Operator, _csrf: Csrf, db: Db, host: str = Form(...), login: str = Form(...), remote_path: str = Form(...), file: UploadFile = File(...)):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", host) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", login) or not remote_path or "\0" in remote_path:
        raise HTTPException(422, "Invalid transfer target")
    descriptor, path = tempfile.mkstemp(prefix="cloudtool-tsh-upload-")
    os.close(descriptor)
    temp_path = Path(path)
    try:
        # tsh scp uses the local basename when the destination is a directory.
        # Our local file is intentionally random, so explicitly preserve the
        # browser-provided basename for paths such as /tmp/.
        original_name = Path(file.filename or "upload").name
        # Upload accepts a destination directory only. Always append the
        # original browser filename, whether or not the user typed a trailing
        # slash, so there is no need to re-enter the filename in the UI.
        destination = f"{remote_path.rstrip('/')}/{original_name}"
        total = 0
        with temp_path.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                total += len(chunk)
                if total > get_settings().UPLOAD_MAX_BYTES:
                    raise HTTPException(413, "File is larger than the configured upload limit")
                target.write(chunk)
        args, home, binary = await tsh_scp_args(link_id, host, login, user.id, db)
        await run_tsh(*args, str(temp_path), f"{host}:{destination}", home=home, binary=binary)
        return {"detail": "File uploaded", "remote_path": destination}
    finally:
        await file.close()
        temp_path.unlink(missing_ok=True)


@router.post("/{link_id}/tsh/files/download")
async def tsh_download_file(link_id: str, payload: TshDownloadIn, user: Operator, _csrf: Csrf, db: Db):
    if "\0" in payload.remote_path:
        raise HTTPException(422, "Invalid remote path")
    suffix = Path(payload.remote_path).suffix[:20]
    descriptor, path = tempfile.mkstemp(prefix="cloudtool-tsh-download-", suffix=suffix)
    os.close(descriptor)
    temp_path = Path(path)
    try:
        args, home, binary = await tsh_scp_args(link_id, payload.host, payload.login, user.id, db)
        await run_tsh(*args, f"{payload.host}:{payload.remote_path}", str(temp_path), home=home, binary=binary)
        filename = Path(payload.remote_path).name or "teleport-download"
        return FileResponse(temp_path, filename=filename, background=BackgroundTask(temp_path.unlink, missing_ok=True))
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


@router.post("/{link_id}/tsh/login")
async def tsh_login(link_id: str, payload: TshLoginIn, user: Operator, _csrf: Csrf, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    args = [
        f"--proxy={await tsh_proxy_address(row)}",
    ]
    if not row.verify_tls:
        args.append("--insecure")
    # These are flags of the ``login`` subcommand, not top-level tsh flags.
    # Keeping them after ``login`` works across tsh parser versions.
    args.extend([
        "login",
        f"--user={payload.username}",
        "--auth=local",
        "--mfa-mode=otp",
        "--browser=none",
        "--add-keys-to-agent=no",
    ])
    code, output = await run_tsh_terminal(
        *args,
        home=tsh_home(user.id, link_id),
        binary=tsh_binary(row),
        # tsh prompts for password first, then the TOTP token. Values are sent
        # through stdin and never logged or persisted by CloudTool.
        input_data=f"{payload.password}\n{payload.otp}\n",
    )
    if code:
        raise HTTPException(502, f"tsh failed: {output[-4000:] or 'unknown error'}")
    return {"active": True, "detail": output[-2000:] if output else "tsh login succeeded"}


@router.post("/{link_id}/tsh/ssh")
async def tsh_ssh(link_id: str, payload: TshSshIn, user: Operator, _csrf: Csrf, db: Db):
    """Run a complete script per VM, automatically handling delayed passwd input."""
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    resolved_host = await tsh_host_for_request(user.id, row, payload.host)
    # Reuse the route recorded by the successful tsh login.
    args = ["--insecure"] if not row.verify_tls else []
    args.extend([
        "ssh",
        f"--login={payload.login}",
        "--no-relogin",
    ])
    timeout = get_settings().TELEPORT_TSH_TIMEOUT_SECONDS
    if is_interactive_password_script(payload.command):
        steps = script_steps(payload.command, timeout)
        if not steps[0][1] or steps[0][0]:
            raise HTTPException(422, "Interactive input must start with a command before the first sleep token.")
        marker = "__CLOUDTOOL_READY_" + secrets.token_hex(16) + "__"
        remote_script = f"printf '%s\\n' {shlex.quote(marker)}; " + steps[0][1]
        remote_command = "sh -c " + shlex.quote(remote_script)
        try:
            exit_code, output = await asyncio.to_thread(
                run_timed_terminal, [*args, "-t", resolved_host, remote_command],
                binary=tsh_binary(row), home=tsh_home(user.id, link_id),
                marker=marker, inputs=steps[1:], timeout=timeout,
            )
        except TimeoutError:
            raise HTTPException(504, "Interactive Teleport script timed out. Increase delays if the VM prompts slowly.") from None
        except OSError:
            raise HTTPException(503, "Could not start the interactive Teleport terminal.") from None
    else:
        # Preserve script text on stdin; sleep tokens become shell sleep commands.
        remote_command = "sh -s"
        exit_code, output = await run_tsh(
            *args, resolved_host, remote_command,
            input_data=render_script_delays(payload.command, timeout) + "\n",
            allow_error=True, home=tsh_home(user.id, link_id), binary=tsh_binary(row),
        )
    return {"output": output, "exit_code": exit_code,
            "status": "success" if exit_code == 0 else "failed", "resolved_host": resolved_host}


@router.post("/{link_id}/tsh/terminal-ticket")
async def tsh_terminal_ticket(link_id: str, payload: TshTerminalIn, user: Operator, _csrf: Csrf, db: Db):
    """Authorize one short-lived interactive tsh SSH terminal."""
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    resolved_host = await tsh_host_for_request(user.id, row, payload.host)
    # Reuse the route recorded by the successful tsh login.
    args = ["--insecure"] if not row.verify_tls else []
    args.extend(["ssh", f"--login={payload.login}", "--no-relogin", resolved_host])
    return {
        "ticket": issue_tsh_terminal_ticket(args, tsh_home(user.id, link_id), tsh_binary(row)),
        "resolved_host": resolved_host,
        "expires_in_seconds": 60,
    }


@router.get("/{link_id}/tsh/nodes")
async def tsh_nodes(link_id: str, user: Operator, db: Db, ip: str = ""):
    """Find SSH nodes visible to the current user's tsh certificate."""
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id:
        raise HTTPException(404, "Link not found")
    # ``tsh login`` records the public proxy route in TELEPORT_HOME. Forcing
    # the saved IP after login causes Teleport to reject a valid session.
    args = ["--insecure"] if not row.verify_tls else []
    args.extend(["ls", "--format=json"])
    if ip:
        try:
            ipaddress.ip_address(ip)
        except ValueError:
            raise HTTPException(422, "Enter a valid IP address") from None
        args.append(f'--query=labels["ip"] == "{ip}"')
    code, output = await run_tsh(
        *args,
        home=tsh_home(user.id, link_id),
        allow_error=True,
        binary=tsh_binary(row),
        max_output_chars=20_000_000,
    )
    if code:
        raise HTTPException(502, f"tsh failed: {output[-4000:] or 'could not list nodes'}")
    listed_nodes = tsh_nodes_from_output(output)
    if ip and not any(node_contains_ip(node, ip) for node in listed_nodes):
        # Not every cluster stores the VM IP in the `ip` label. Retry without
        # the label predicate and inspect resource addresses as a fallback.
        args.pop()
        code, output = await run_tsh(
            *args,
            home=tsh_home(user.id, link_id),
            allow_error=True,
            binary=tsh_binary(row),
            max_output_chars=20_000_000,
        )
        if code:
            raise HTTPException(502, f"tsh failed: {output[-4000:] or 'could not list nodes'}")
        listed_nodes = tsh_nodes_from_output(output)
    entries = []
    for node in listed_nodes:
        name = teleport_node_display_name(node)
        if not name:
            continue
        labels = node_label_summary(node)
        for address in node_ip_addresses(node):
            entries.append({"name": name, "ip": address, "labels": labels})
    if ip:
        entries = [item for item in entries if item["ip"] == ip]
    return {"nodes": sorted(entries, key=lambda item: (item["ip"], item["name"]))}


def tsh_terminal_origin_allowed(origin: str | None) -> bool:
    return bool(origin and origin.rstrip("/") in {item.rstrip("/") for item in get_settings().CORS_ORIGINS})


@router.websocket("/tsh/terminal/ws")
async def tsh_terminal_socket(websocket: WebSocket, ticket: str = ""):
    """Bridge xterm.js to one user-authorized tsh pseudo-terminal session."""
    terminal_ticket = take_tsh_terminal_ticket(ticket)
    if not terminal_ticket:
        await websocket.close(code=1008, reason="Invalid or expired terminal ticket")
        return
    if not tsh_terminal_origin_allowed(websocket.headers.get("origin")):
        await websocket.close(code=1008, reason="Untrusted browser origin")
        return
    await websocket.accept()
    if os.name != "nt":
        await websocket.send_json({"type": "error", "message": "Interactive tsh terminal is not available on this backend operating system yet."})
        await websocket.close(code=1011, reason="PTY bridge unavailable")
        return
    try:
        from winpty import PtyProcess
        environment = os.environ.copy()
        environment["TELEPORT_HOME"] = str(terminal_ticket.home)
        environment["TELEPORT_ADD_KEYS_TO_AGENT"] = "no"
        process = await asyncio.to_thread(
            PtyProcess.spawn,
            [terminal_ticket.binary, *terminal_ticket.args],
            env=environment,
            dimensions=(30, 120),
        )
    except Exception:
        await websocket.send_json({"type": "error", "message": "Could not start tsh on the backend host."})
        await websocket.close(code=1011, reason="Could not start tsh")
        return

    try:
        await websocket.send_json({"type": "status", "state": "ready", "message": "Connected"})

        async def forward_output() -> None:
            while process.isalive():
                try:
                    output = await asyncio.to_thread(process.read, 4096)
                except EOFError:
                    return
                if output:
                    await websocket.send_json({"type": "output", "data": output})

        async def forward_input() -> None:
            while True:
                message = await websocket.receive_json()
                message_type = message.get("type") if isinstance(message, dict) else None
                if message_type == "input":
                    value = message.get("data")
                    if not isinstance(value, str) or len(value) > 16_384:
                        await websocket.send_json({"type": "error", "message": "Invalid terminal input"})
                    else:
                        await asyncio.to_thread(process.write, value)
                elif message_type == "resize":
                    cols, rows = message.get("cols"), message.get("rows")
                    if isinstance(cols, int) and isinstance(rows, int):
                        # pywinpty uses (rows, cols). Reversing these values
                        # makes remote readline/vim wrap at the wrong column.
                        await asyncio.to_thread(process.setwinsize, max(8, min(rows, 120)), max(20, min(cols, 300)))
                elif message_type == "close":
                    return

        output_task = asyncio.create_task(forward_output())
        input_task = asyncio.create_task(forward_input())
        done, pending = await asyncio.wait({output_task, input_task}, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        if process.isalive():
            await asyncio.to_thread(process.terminate)
        await websocket.close()

@router.post("/{link_id}/check")
async def check(link_id: str, payload: CheckIn, user: CliCommandUser, db: Db):
    row = await db.get(TeleportLink, link_id)
    if not row or row.created_by != user.id: raise HTTPException(404, "Link not found")
    if not await tsh_session_info(user.id, row):
        raise HTTPException(
            401,
            "Teleport tsh session is not active. Sign in once from the shared Teleport session page.",
        )

    # A large Servers selection must not call `tsh ls` once per VM. Apart from
    # rate-limiting the proxy, concurrent tsh processes mutate/read the same
    # TELEPORT_HOME and can invalidate an otherwise healthy session. Fetch the
    # visible node inventory exactly once, then match every requested IP in
    # memory. The result order remains the order sent by the data table.
    args = ["--insecure"] if not row.verify_tls else []
    args.extend(["ls", "--format=json"])
    code, output = await run_tsh(
        *args,
        home=tsh_home(user.id, link_id),
        allow_error=True,
        binary=tsh_binary(row),
        max_output_chars=20_000_000,
    )
    if code:
        detail = output[-2000:] or "could not list nodes"
        if "invalid session" in detail.lower():
            raise HTTPException(401, "Teleport tsh session is no longer valid. Sign in again.")
        raise HTTPException(502, f"tsh failed while reading Teleport nodes: {detail}")

    node_by_ip: dict[str, object] = {}
    for node in tsh_nodes_from_output(output):
        for address in node_ip_addresses(node):
            node_by_ip.setdefault(address, node)

    results = []
    for server_id, ips in payload.server_ips.items():
        checked_ip = next((address for address in ips if address in node_by_ip), ips[0] if ips else "")
        node = node_by_ip.get(checked_ip)
        results.append(
            {
                "server_id": server_id,
                "checked_ip": checked_ip,
                "found": node is not None,
                "teleport_name": teleport_node_display_name(node) if node else "",
                "teleport_labels": node_label_summary(node) if node else "",
            }
        )
    return results

    base = base_url(row.url)
    session_key = (user.id, link_id)
    cached = _sessions.get(session_key)
    bearer = cached[0] if cached and cached[1] > time.monotonic() else ""
    if not bearer and row.session_ciphertext and row.session_expires_at and row.session_expires_at > db_now():
        try: bearer = cipher().decrypt(row.session_ciphertext.encode()).decode()
        except (InvalidToken, UnicodeDecodeError):
            row.session_ciphertext, row.session_expires_at = None, None
            await db.commit()
    try:
        # Teleport development clusters commonly use an internal/self-signed
        # certificate. The link is user-scoped and this checker deliberately
        # supports those endpoints, so TLS verification must not block login.
        async with httpx.AsyncClient(timeout=25, verify=False, follow_redirects=False) as client:
            if not bearer:
                if not (payload.username and payload.password and payload.otp):
                    raise HTTPException(401, "Teleport session expired. Enter username, password, and Google Authenticator code again")
                login_page = await client.get(base + "/web/login")
                csrf = re.search(r'name="grv_csrf_token" content="([^"]+)', login_page.text)
                headers = {"X-CSRF-Token": csrf.group(1)} if csrf else {}
                login = await client.post(base + "/webapi/sessions/web", json={"user": payload.username, "pass": payload.password, "second_factor_token": payload.otp}, headers=headers)
                if login.is_error:
                    raise HTTPException(401, "Teleport rejected the username, password, or Google Authenticator code")
                session = login.json()
                bearer = session.get("token", "") if isinstance(session, dict) else ""
                if not bearer: raise HTTPException(502, "Teleport did not return a session token")
                ttl_seconds = session_ttl_seconds(session)
                _sessions[session_key] = (bearer, time.monotonic() + ttl_seconds)
                row.session_ciphertext = cipher().encrypt(bearer.encode()).decode()
                row.session_expires_at = db_now() + timedelta(seconds=ttl_seconds)
                await db.commit()
            # Recent Teleport Web API versions authorize resource requests with
            # the short-lived bearer token returned by session creation. Keep
            # the cookie jar too, for older clusters that authenticate by cookie.
            auth_headers = {"Authorization": f"Bearer {bearer}"} if bearer else {}
            sites_response = await client.get(base + "/webapi/sites", headers=auth_headers)
            if sites_response.status_code in {401, 403}:
                _sessions.pop(session_key, None)
                row.session_ciphertext, row.session_expires_at = None, None
                await db.commit()
                raise HTTPException(401, "Teleport session expired or is no longer authorized. Sign in again from Teleport endpoints & session")
            if sites_response.is_error:
                raise HTTPException(403, f"Teleport session was created but listing clusters was denied ({sites_response.status_code})")
            sites = sites_response.json()
            # Teleport versions return either a direct array of ui.Cluster
            # records or wrap the same array under `clusters` / `items`.
            site_items = (
                sites.get("clusters", sites.get("items", []))
                if isinstance(sites, dict)
                else sites
            )
            first = site_items[0] if isinstance(site_items, list) and site_items else {}
            site = first.get("name") or first.get("site_name") or first.get("metadata", {}).get("name")
            if not site: raise HTTPException(502, "Teleport returned no accessible cluster")
            # Nodes are paginated by Teleport. Fetch pages, rather than relying
            # on the UI's first page, so IP matching stays accurate at scale.
            nodes = []
            start_key = None
            for _ in range(100):
                params = {"limit": 1000}
                if start_key: params["startKey"] = start_key
                node_response = await client.get(
                    f"{base}/webapi/sites/{site}/nodes", params=params, headers=auth_headers
                )
                if node_response.status_code in {401, 403}:
                    _sessions.pop(session_key, None)
                    row.session_ciphertext, row.session_expires_at = None, None
                    await db.commit()
                    raise HTTPException(401, "Teleport session expired or cannot read nodes. Sign in again with an account allowed to access nodes")
                if node_response.is_error:
                    raise HTTPException(403, f"Teleport denied access to nodes in cluster {site!r} ({node_response.status_code}); ask for a role with node read/access permission")
                page = node_response.json()
                page_items = page.get("items", page) if isinstance(page, dict) else page
                if not isinstance(page_items, list): break
                nodes.extend(page_items)
                start_key = page.get("startKey") if isinstance(page, dict) else None
                if not start_key: break
    except httpx.RequestError as error:
        raise HTTPException(502, f"Could not reach Teleport: {error}") from error
    results = []
    for server_id, ips in payload.server_ips.items():
        matched_node = None
        matched_ip = None
        for address in ips:
            matched_node = next(
                (node for node in nodes if node_contains_ip(node, address)), None
            )
            if matched_node:
                matched_ip = address
                break
        results.append(
            {
                "server_id": server_id,
                "checked_ip": matched_ip or (ips[0] if ips else ""),
                "found": matched_node is not None,
                "teleport_name": teleport_node_display_name(matched_node)
                if matched_node
                else "",
                "teleport_labels": node_label_summary(matched_node)
                if matched_node
                else "",
            }
        )
    return results
