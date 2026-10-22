import asyncio
import json
import os
import traceback
from datetime import datetime, timedelta, timezone
from contextlib import asynccontextmanager
from collections.abc import Awaitable, Callable
from pathlib import Path
from time import perf_counter
from uuid import uuid4
from typing import Annotated

from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request, Response, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse

import secrets

from app.analysis import answer
from app.codex_app_server import CodexAppServerError, CodexSessionUnavailableError, cancel as cancel_codex_request, list_history_threads, read_history_thread
from app.codex_cli import status as codex_status
from app.audit import delete_execution_logs_before, get_api_action_log, get_execution_log, list_api_action_logs, list_execution_logs, record_api_action, write_audit, write_execution_log
from app.codex_cli import prompt_preview
from app.codex_terminal import issue_ticket, run_terminal, take_ticket, terminal_bridge_available
from app.config import get_settings
from app.gateway import CloudToolGateway
from app.vm_lookups import VmLookup, VmLookupBatch, lookup, lookup_many
from app.user_questions import QuestionAnswers, UserQuestionBroker
from app.project_actions import PROJECT_TOOLS, project_action, upstream_action_error
from app.security import redact
from app.history import append_exchange, delete_conversation, get_conversation, list_conversations, rename_conversation
from app.model_catalog import CodexModelCatalogError, codex_model_catalog, configured_model_fallback, validate_model_selection
from app.project_workspace import _SIMPLE_CSV_FILES, _SIMPLE_JSON_FILES, created_workspace_artifacts, delete_managed_workspace_path, managed_workspace_download, managed_workspace_tree, prepare_project_workspace, read_managed_workspace_text, read_workspace_file, rename_managed_workspace_file, resolve_workspace_artifact, store_workspace_attachments, workspace_artifact_snapshot, workspace_files, write_managed_workspace_text, write_project_context_snapshot, write_security_group_rule_template, write_server_creation_template, write_simple_project_data
from app.vm_actions import extract_vm_action, remove_vm_action_block
from app.api_actions import security_group_rule_batch_action
from app.pending_actions import PendingActionBroker
from app.prompt_suggestions import create_suggestion, delete_suggestion, list_suggestions, update_suggestion
from app.skills import create_skill, delete_skill, list_skills, resolve_skills, update_skill
from app.runtime_settings import get_codex_settings, save_codex_settings
from app.schemas import AgentSkillIn, AgentSkillPatch, CodexRuntimeResponse, CodexSettingsResponse, CodexSettingsUpdate, ChatRequest, ChatResponse, Conversation, ConversationTitleUpdate, Evidence, ExternalChatRequest, PromptSuggestionIn, PromptSuggestionPatch, VmAction

settings = get_settings()
gateway = CloudToolGateway()
_conversation_locks: dict[str, asyncio.Lock] = {}
pending_actions = PendingActionBroker()
user_questions = UserQuestionBroker()


def conversation_lock(conversation_id: str) -> asyncio.Lock:
    """Serialize messages for one persisted Codex thread.

    The global CLI semaphore protects the local executable.  This extra lock,
    borrowed from the template's session manager pattern, prevents two browser
    requests from reading the same old thread ID and racing to append history.
    """
    return _conversation_locks.setdefault(conversation_id, asyncio.Lock())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield


app = FastAPI(title="CloudTool Read-only AI Agent", version="0.1.0", lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.TRUSTED_HOSTS)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    # Browser-side conversation management uses PATCH and DELETE.  Keep this
    # explicit rather than allowing arbitrary methods.
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Agent-API-Key", "X-CSRF-Token", "X-Cloud-Token", "X-Project-Id"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    request_id = request.headers.get("X-Request-Id") or str(uuid4())
    response = await call_next(request)
    response.headers.update({
        "X-Request-Id": request_id,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
    })
    return response


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException):
    return JSONResponse({"error": {"code": "request_error", "message": str(exc.detail)}}, status_code=exc.status_code)


@app.get("/health/live", include_in_schema=False)
async def live():
    return {"status": "ok", "mode": "read-only"}


@app.get("/api/v1/vm-creation/options")
async def vm_creation_options(request: Request, query: Annotated[VmLookup, Query()]):
    caller = await gateway.caller(request)
    import httpx
    async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
        return await lookup(client, gateway, caller, query)


@app.post("/api/v1/vm-creation/options/batch")
async def vm_creation_options_batch(request: Request, payload: VmLookupBatch):
    caller = await gateway.caller(request)
    return await lookup_many(gateway, caller, payload.requests)


async def admin_caller(request: Request):
    caller = await gateway.caller(request)
    if caller.role != "admin":
        raise HTTPException(403, "Only CloudTool administrators can change Codex CLI settings")
    return caller


def external_api_caller(request: Request) -> str:
    """Authenticate a non-browser API client without accepting cloud secrets."""
    configured_key = settings.AGENT_EXTERNAL_API_KEY
    supplied_key = request.headers.get("X-Agent-API-Key", "")
    if not supplied_key:
        authorization = request.headers.get("Authorization", "")
        scheme, _, token = authorization.partition(" ")
        supplied_key = token if scheme.lower() == "bearer" else ""
    if not configured_key:
        raise HTTPException(503, "External chat API is disabled; configure AGENT_EXTERNAL_API_KEY")
    if not supplied_key or not secrets.compare_digest(supplied_key, configured_key):
        raise HTTPException(401, "Invalid external API key")
    return supplied_key


@app.get("/api/v1/settings/codex", response_model=CodexSettingsResponse)
async def get_codex_config(request: Request):
    caller = await admin_caller(request)
    values = get_codex_settings()
    return {**values, **(await codex_status(values)), "csrf_token": caller.csrf_token}


@app.put("/api/v1/settings/codex", response_model=CodexSettingsResponse)
async def update_codex_config(payload: CodexSettingsUpdate, request: Request):
    caller = await admin_caller(request)
    values = save_codex_settings(payload.model_dump())
    write_audit(
        actor_email=caller.email,
        project_id=caller.project_id,
        action="agent.codex_settings.update",
        result="success",
        metadata={
            "provider": values["provider"],
            "model_configured": bool(values["model"]),
            "timeout_seconds": values["timeout_seconds"],
        },
    )
    return {**values, **(await codex_status(values)), "csrf_token": caller.csrf_token}


@app.post("/api/v1/settings/codex/test", response_model=CodexSettingsResponse)
async def test_codex_config(request: Request):
    caller = await admin_caller(request)
    values = get_codex_settings()
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.codex_settings.test", result="success", metadata={})
    return {**values, **(await codex_status(values)), "csrf_token": caller.csrf_token}


@app.post("/api/v1/terminal/ticket")
async def create_codex_terminal_ticket(request: Request):
    """Create a single-use, short-lived credential for the privileged CLI bridge."""
    if not settings.CODEX_TERMINAL_ENABLED:
        raise HTTPException(503, "Interactive Codex terminal is disabled")
    if not terminal_bridge_available():
        raise HTTPException(503, "Interactive Codex terminal requires pywinpty in the agent-service Python environment")
    caller = await admin_caller(request)
    runtime = get_codex_settings()
    ticket = issue_ticket(
        actor_email=caller.email,
        project_id=caller.project_id,
        command=str(runtime["command"]),
        workdir=str(runtime["workdir"]),
    )
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.codex_terminal.ticket", result="success", metadata={})
    return {"ticket": ticket, "expires_in_seconds": 60}


@app.websocket("/api/v1/terminal/ws")
async def codex_terminal_socket(websocket: WebSocket, ticket: str = ""):
    if not settings.CODEX_TERMINAL_ENABLED:
        await websocket.close(code=1008, reason="Interactive terminal is disabled")
        return
    terminal_ticket = take_ticket(ticket)
    if terminal_ticket is None:
        await websocket.close(code=1008, reason="Invalid or expired terminal ticket")
        return
    await run_terminal(websocket, terminal_ticket, settings.CORS_ORIGINS)


@app.get("/api/v1/runtime", response_model=CodexRuntimeResponse)
async def codex_runtime(request: Request):
    """Expose safe runtime choices for the authenticated chat UI.

    The active agent is intentionally read-only. Therefore no approval bypass
    is exposed: there is no write-capable operation to approve or auto-allow.
    """
    await gateway.caller(request)
    values = get_codex_settings()
    try:
        models = await codex_model_catalog(values)
    except CodexModelCatalogError:
        models = configured_model_fallback(values)
    return {
        "models": models,
        "configured_model": values["model"] or None,
        "configured_reasoning_effort": values["reasoning_effort"],
        "policy": "pending_approval",
        "policy_detail": "Codex can query read-only CloudTool data and invoke approved local action APIs that wait for browser approval.",
    }


_SIMPLE_CSV_SOURCES = set(_SIMPLE_CSV_FILES)
_SIMPLE_JSON_SOURCES = set(_SIMPLE_JSON_FILES)
_SIMPLE_PROJECT_DATA_SOURCES = _SIMPLE_CSV_SOURCES | _SIMPLE_JSON_SOURCES
_SNAPSHOT_SOURCES = {"inventory", "subnets", "security_groups", "security_group_rules", "private_ips", "elastic_ips", "audit_events", "cloud_api_history", "security_group_rule_template", "server_creation_template", "project_data_simple", *_SIMPLE_PROJECT_DATA_SOURCES}
_DEFAULT_SNAPSHOT_SOURCES = {"inventory", "subnets", "security_groups", "security_group_rules", "elastic_ips"}


def _remove_optional_workspace_file(path: Path, warnings: list[str]) -> None:
    """Best-effort cleanup for files a user may have open in Excel on Windows."""
    try:
        path.unlink(missing_ok=True)
    except PermissionError:
        # A locked optional workbook must never make the whole project refresh
        # fail. Leave it in place and make the condition observable instead.
        warnings.append(f"Kept open file: {path.name}")


@app.post("/api/v1/project-context/refresh")
async def refresh_project_context(request: Request):
    """Create a redacted, file-based project snapshot for Codex's cwd."""
    caller = await gateway.caller(request)
    try:
        workspace = prepare_project_workspace(caller.project_id)
    except PermissionError as exc:
        raise HTTPException(409, "Close the workspace file currently open in another application, then refresh again") from exc
    # ``collect`` uses only the service's allow-listed read APIs and redacts
    # data before it reaches this durable workspace.
    body = await request.json() if request.headers.get("content-length") not in {None, "0"} else {}
    requested = body.get("sources") if isinstance(body, dict) else None
    if requested is None:
        selected = _DEFAULT_SNAPSHOT_SOURCES
    elif isinstance(requested, list) and all(isinstance(item, str) for item in requested):
        selected = set(requested) & _SNAPSHOT_SOURCES
    else:
        raise HTTPException(422, "sources must be a list of supported snapshot sections")
    if not selected:
        raise HTTPException(422, "Select at least one snapshot section")
    # Accept the former all-in-one source from saved browser state/API clients,
    # while new clients select the individual CSVs they actually need.
    if "project_data_simple" in selected:
        selected = (selected - {"project_data_simple"}) | _SIMPLE_PROJECT_DATA_SOURCES
    # A workspace refresh is incremental: isolate each selected item so one
    # unavailable Cloud API resource or locked file never prevents the rest
    # of the user's selected workspace data from being refreshed.
    context_sources = selected - {"security_group_rule_template", "server_creation_template", *_SIMPLE_PROJECT_DATA_SOURCES}
    files: list[str] = []
    warnings: list[str] = []
    evidence: list[dict] = []
    results: list[dict] = []
    refreshed_at = datetime.now(timezone.utc).isoformat()

    for source in sorted(context_sources):
        try:
            context, source_evidence = await gateway.collect(caller, "", {source}, snapshot=True)
            snapshot = write_project_context_snapshot(workspace, caller.project_id, context)
            source_warnings = [
                "CloudTool data was unavailable; the generated file may be incomplete."
                for item in source_evidence
                if item.get("source") == source and item.get("note") == "Access unavailable"
            ]
            warnings.extend(source_warnings)
            source_files = [path for path in snapshot.files if path != "project-data/manifest.json"]
            files.extend(source_files)
            evidence.extend(source_evidence)
            results.append({
                "source": source,
                "status": "warning" if source_warnings else "success",
                "detail": " ".join(source_warnings) or "Refreshed successfully.",
                "files": source_files,
            })
            refreshed_at = snapshot.refreshed_at
        except HTTPException as exc:
            results.append({"source": source, "status": "error", "detail": str(exc.detail), "files": []})
        except Exception:
            results.append({"source": source, "status": "error", "detail": "Unable to refresh this workspace item.", "files": []})

    template_path = Path(workspace.path) / "excel-template" / "security-group-multi-rules-template.xlsx"
    if "security_group_rule_template" in selected:
        try:
            template_file = write_security_group_rule_template(
                workspace, caller.project_id, await gateway.security_groups_for_template(caller)
            )
            files.append(template_file)
            evidence.append({"source": "security_group_rule_template", "count": 1, "note": "Project-wide Security Group rule Excel template"})
            results.append({"source": "security_group_rule_template", "status": "success", "detail": "Refreshed successfully.", "files": [template_file]})
        except PermissionError:
            results.append({"source": "security_group_rule_template", "status": "error", "detail": "Close security-group-multi-rules-template.xlsx before refreshing it.", "files": []})
        except HTTPException as exc:
            results.append({"source": "security_group_rule_template", "status": "error", "detail": str(exc.detail), "files": []})
        except Exception:
            results.append({"source": "security_group_rule_template", "status": "error", "detail": "Unable to refresh this workspace item.", "files": []})
    else:
        _remove_optional_workspace_file(template_path, warnings)
    server_template_path = Path(workspace.path) / "excel-template" / "server-creation-template.xlsx"
    if "server_creation_template" in selected:
        try:
            template_file = write_server_creation_template(workspace, caller.project_id, await gateway.server_creation_template_lookups(caller))
            files.append(template_file)
            evidence.append({"source": "server_creation_template", "count": 1, "note": "Terraform-compatible server creation Excel template"})
            results.append({"source": "server_creation_template", "status": "success", "detail": "Refreshed successfully.", "files": [template_file]})
        except PermissionError:
            results.append({"source": "server_creation_template", "status": "error", "detail": "Close server-creation-template.xlsx before refreshing it.", "files": []})
        except HTTPException as exc:
            results.append({"source": "server_creation_template", "status": "error", "detail": str(exc.detail), "files": []})
        except Exception:
            results.append({"source": "server_creation_template", "status": "error", "detail": "Unable to refresh this workspace item.", "files": []})
    else:
        _remove_optional_workspace_file(server_template_path, warnings)
    selected_simple_sources = selected & _SIMPLE_PROJECT_DATA_SOURCES
    if selected_simple_sources:
        try:
            simple_data = await gateway.simple_project_data(caller)
            # Secondary resources (per-security-group rules and per-subnet
            # private IPs) are intentionally best-effort.  They must not make
            # an otherwise valid workspace refresh fail.
            simple_warnings = [str(item) for item in simple_data.pop("_warnings", []) if item]
            warnings.extend(simple_warnings)
            for source in sorted(selected_simple_sources):
                try:
                    source_files = write_simple_project_data(workspace, simple_data, {source})
                    files.extend(source_files)
                    results.append({
                        "source": source,
                        "status": "warning" if simple_warnings else "success",
                        "detail": " ".join(simple_warnings) or "Refreshed successfully.",
                        "files": source_files,
                    })
                except PermissionError:
                    results.append({"source": source, "status": "error", "detail": "Close the open CSV file before refreshing it.", "files": []})
                except Exception:
                    results.append({"source": source, "status": "error", "detail": "Unable to refresh this workspace item.", "files": []})
        except HTTPException as exc:
            for source in sorted(selected_simple_sources):
                results.append({"source": source, "status": "error", "detail": str(exc.detail), "files": []})
        except Exception as exc:
            # Do not let a shared CSV data load block context/template rows.
            for source in sorted(selected_simple_sources):
                results.append({"source": source, "status": "error", "detail": "Unable to prepare compact project CSV data.", "files": []})
        else:
            evidence.append({"source": "project_data_simple", "count": len(selected_simple_sources), "note": "Selected compact CSV/JSON project data"})
    write_audit(
        actor_email=caller.email, project_id=caller.project_id,
        action="agent.project_context.refresh", result="success",
        metadata={"files": files, "sources": evidence, "selected": sorted(selected), "warnings": warnings},
    )
    return {
        "workspace": workspace.path,
        "files": files,
        "refreshed_at": refreshed_at,
        "warnings": warnings,
        "results": results,
        "csrf_token": caller.csrf_token,
    }


@app.get("/api/v1/project-context/files")
async def list_project_workspace_files(request: Request, query: str = ""):
    caller = await gateway.caller(request)
    return {"files": workspace_files(prepare_project_workspace(caller.project_id), query)}


@app.get("/api/v1/project-context/path")
async def project_workspace_path(request: Request):
    """Return only the authenticated project's absolute local workspace path."""
    caller = await gateway.caller(request)
    return {"path": prepare_project_workspace(caller.project_id).path}


@app.get("/api/v1/project-context/manage/tree")
async def workspace_management_tree(request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    return {"items": managed_workspace_tree(prepare_project_workspace(caller.project_id))}


@app.get("/api/v1/project-context/manage/file")
async def workspace_management_file(request: Request, path: str):
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        return read_managed_workspace_text(prepare_project_workspace(caller.project_id), path)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.get("/api/v1/project-context/manage/download")
async def download_workspace_management_path(
    path: str, request: Request, background_tasks: BackgroundTasks
):
    """Download one workspace file or package every file in a folder as ZIP."""
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        target, temporary = managed_workspace_download(
            prepare_project_workspace(caller.project_id), path
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    if temporary:
        background_tasks.add_task(target.unlink, missing_ok=True)
        return FileResponse(
            target, media_type="application/zip", filename=f"{Path(path).name or 'workspace'}.zip",
            background=background_tasks,
        )
    return FileResponse(
        target,
        media_type="application/octet-stream",
        filename=target.name,
    )


@app.put("/api/v1/project-context/manage/file")
async def update_workspace_management_file(payload: dict, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    if not isinstance(payload.get("path"), str) or not isinstance(payload.get("content"), str):
        raise HTTPException(422, "path and content are required")
    try:
        write_managed_workspace_text(prepare_project_workspace(caller.project_id), payload["path"], payload["content"])
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "saved"}


@app.delete("/api/v1/project-context/manage/path")
async def remove_workspace_management_path(path: str, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        delete_managed_workspace_path(prepare_project_workspace(caller.project_id), path)
    except (ValueError, OSError) as exc:
        raise HTTPException(422, "Folder must be empty and protected paths cannot be deleted") from exc
    return {"status": "deleted"}


@app.post("/api/v1/project-context/manage/file/rename")
async def rename_workspace_management_file(payload: dict, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    path = payload.get("path")
    new_name = payload.get("new_name")
    if not isinstance(path, str) or not isinstance(new_name, str):
        raise HTTPException(422, "path and new_name are required")
    try:
        renamed_path = rename_managed_workspace_file(
            prepare_project_workspace(caller.project_id), path, new_name
        )
    except (ValueError, OSError) as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"status": "renamed", "path": renamed_path}


@app.get("/api/v1/prompt-suggestions")
async def prompt_suggestions(request: Request):
    """List the signed-in user's reusable prompts from Agent Service storage."""
    caller = await gateway.caller(request, require_cloud_token=False)
    return list_suggestions(actor_email=caller.email)


@app.post("/api/v1/prompt-suggestions", status_code=201)
async def create_prompt_suggestion(payload: PromptSuggestionIn, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    item = create_suggestion(actor_email=caller.email, title=payload.title, prompt=payload.prompt)
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.prompt_suggestion.create", result="success", metadata={"suggestion_id": item["id"]})
    return item


@app.patch("/api/v1/prompt-suggestions/{suggestion_id}")
async def update_prompt_suggestion(suggestion_id: str, payload: PromptSuggestionPatch, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    item = update_suggestion(actor_email=caller.email, suggestion_id=suggestion_id, title=payload.title, prompt=payload.prompt)
    if not item:
        raise HTTPException(404, "Prompt suggestion not found")
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.prompt_suggestion.update", result="success", metadata={"suggestion_id": item["id"]})
    return item


@app.delete("/api/v1/prompt-suggestions/{suggestion_id}", status_code=204)
async def remove_prompt_suggestion(suggestion_id: str, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    if not delete_suggestion(actor_email=caller.email, suggestion_id=suggestion_id):
        raise HTTPException(404, "Prompt suggestion not found")
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.prompt_suggestion.delete", result="success", metadata={"suggestion_id": suggestion_id})
    return None


@app.get("/api/v1/skills")
async def agent_skills(request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    return list_skills(actor_email=caller.email)


@app.post("/api/v1/skills", status_code=201)
async def create_agent_skill(payload: AgentSkillIn, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    item = create_skill(actor_email=caller.email, title=payload.title, description=payload.description, instructions=payload.instructions)
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.skill.create", result="success", metadata={"skill_id": item["id"]})
    return item


@app.patch("/api/v1/skills/{skill_id}")
async def update_agent_skill(skill_id: str, payload: AgentSkillPatch, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    item = update_skill(actor_email=caller.email, skill_id=skill_id, title=payload.title, description=payload.description, instructions=payload.instructions)
    if not item: raise HTTPException(404, "Agent skill not found")
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.skill.update", result="success", metadata={"skill_id": skill_id})
    return item


@app.delete("/api/v1/skills/{skill_id}", status_code=204)
async def remove_agent_skill(skill_id: str, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    if not delete_skill(actor_email=caller.email, skill_id=skill_id): raise HTTPException(404, "Agent skill not found")
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.skill.delete", result="success", metadata={"skill_id": skill_id})
    return None


@app.get("/api/v1/project-context/file")
async def project_workspace_file(request: Request, path: str):
    caller = await gateway.caller(request)
    try:
        return read_workspace_file(prepare_project_workspace(caller.project_id), path)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@app.get("/api/v1/project-context/download")
async def download_workspace_artifact(request: Request, path: str):
    """Download a generated artifact without exposing an arbitrary host path."""
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        target = resolve_workspace_artifact(prepare_project_workspace(caller.project_id), path)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return FileResponse(target, media_type="application/octet-stream", filename=target.name)


@app.post("/api/v1/internal/gateway/security-group-rule", include_in_schema=False)
async def codex_local_security_group_rule(payload: dict, request: Request):
    """Loopback-only pending gateway; Codex never supplies cloud credentials."""
    host = request.client.host if request.client else ""
    if host not in {"127.0.0.1", "::1"}:
        raise HTTPException(403, "Local gateway accepts loopback callers only")
    supplied = request.headers.get("X-Agent-Local-Key", "")
    capability = await pending_actions.get(str(payload.get("action_id") or ""))
    if not capability or not supplied or not secrets.compare_digest(supplied, capability.capability):
        raise HTTPException(401, "Invalid local gateway capability")
    raw_action = payload.get("action") if isinstance(payload.get("action"), dict) else {}
    action = security_group_rule_batch_action(
        raw_action.get("security_group_id"),
        raw_action.get("rules") if isinstance(raw_action.get("rules"), list) else [raw_action.get("rule")],
        raw_action.get("summary"),
    )
    if not action or payload.get("conversation_id") != capability.conversation_id or payload.get("project_id") != capability.project_id:
        raise HTTPException(422, "Invalid allow-listed action payload")
    # One capability can create several sequential, independently approved
    # actions during this Codex turn. Each gets a distinct pending future.
    item = await pending_actions.requested(capability, action)
    pending_actions.event(item, "awaiting_approval")
    return await pending_actions.wait(item)

@app.get("/api/v1/conversations/{conversation_id}/pending-actions")
async def list_pending_actions(conversation_id: str, request: Request):
    caller = await gateway.caller(request)
    return {"items": await pending_actions.list(conversation_id, caller.project_id, caller.email)}


@app.get("/api/v1/conversations/{conversation_id}/questions")
async def list_user_questions(conversation_id: str, request: Request):
    caller = await gateway.caller(request)
    return {"items": user_questions.list(conversation_id, caller.project_id, caller.email)}


@app.post("/api/v1/questions/{question_id}/answer")
async def answer_user_question(question_id: str, payload: QuestionAnswers, request: Request):
    caller = await gateway.caller(request)
    user_questions.answer(question_id, caller.project_id, caller.email, payload)
    return {"status": "answered"}

@app.get("/api/v1/conversations/{conversation_id}/pending-actions/stream")
async def pending_actions_stream(conversation_id: str, request: Request):
    caller = await gateway.caller(request)
    async def events():
        # Cover the short race between Codex creating an action and the
        # browser establishing its single SSE subscription.
        for item in await pending_actions.list(conversation_id, caller.project_id, caller.email):
            if item.get("action") and item.get("status") == "awaiting_approval":
                yield sse("pending_action", item)
        async for item in pending_actions.subscribe(conversation_id, caller.project_id, caller.email):
            yield sse("pending_action", item)
    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})

@app.post("/api/v1/pending-actions/{action_id}/decision")
async def decide_pending_action(action_id: str, payload: dict, request: Request):
    caller = await gateway.caller(request)
    if payload.get("decision") not in {"approve", "reject"}:
        raise HTTPException(422, "decision must be approve or reject")
    item = await pending_actions.claim(action_id, caller.project_id, caller.email)
    if payload.get("decision") == "reject":
        result = {"status": "rejected", "reason": "User denied this action"}
        pending_actions.event(item, "rejected"); pending_actions.resolve(item, result)
        record_api_action(action_id=item.id, actor_email=item.actor_email, project_id=item.project_id, conversation_id=item.conversation_id, action=item.action, status=item.status, audit=item.audit, expires_at=item.expires_at.isoformat(), result=result)
        return {"status": "rejected"}
    if payload.get("decision") != "approve": raise HTTPException(422, "decision must be approve or reject")
    try:
        pending_actions.event(item, "approved"); pending_actions.event(item, "executing")
        import httpx
        headers = {"X-Agent-Service-Key": settings.AGENT_SERVICE_BACKEND_KEY or "", "X-Project-Id": caller.project_id, "X-Cloud-Token": caller.cloud_token, "cookie": caller.cookie}
        if item.action.get("type") == "security_group_rule.create":
            endpoint = "/cloud/security-groups/internal/agent/security-group-rule"
            completion_status = "completed"
            response_status = "success"
        elif item.action.get("type") == "vm_deployment.create":
            endpoint = "/provisioning/internal/agent/deployments"
            body = item.action["deployment"]
            completion_status = "queued"
            response_status = "queued"
        elif item.action.get("type") in {"private_ip.create", "elastic_ip.create", "private_ip.attach", "elastic_ip.attach"}:
            resource, operation = item.action["type"].split(".")
            endpoint = f"/cloud/ip-allocations/internal/agent/{resource.replace('_', '-')}/{operation}"
            body = dict(item.action["parameters"])
            if operation == "create":
                body["request_id"] = item.id
            completion_status = "completed"
            response_status = "success"
        else:
            raise HTTPException(422, "Unsupported pending action")
        async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
            if item.action.get("type") == "security_group_rule.create":
                results: list[dict] = []
                for rule in item.action.get("rules") or [item.action.get("rule")]:
                    response = await client.post(f"{settings.backend_url}{endpoint}", headers=headers, json={"security_group_id": item.action["security_group_id"], "rule": rule})
                    result = response.json() if response.content else {}
                    if not response.is_success:
                        raise HTTPException(response.status_code, result)
                    results.append(result)
                result = results[0] if len(results) == 1 else {"rules": results, "count": len(results)}
            else:
                response = await client.post(f"{settings.backend_url}{endpoint}", headers=headers, json=body)
                result = response.json() if response.content else {}
                if not response.is_success: raise HTTPException(response.status_code, result)
        if isinstance(result, dict) and result.get("status") == "accepted" and response_status == "success":
            completion_status = response_status = "accepted"
        resolved = {"status": response_status, "result": result}
        pending_actions.event(item, completion_status); pending_actions.resolve(item, resolved)
        record_api_action(action_id=item.id, actor_email=item.actor_email, project_id=item.project_id, conversation_id=item.conversation_id, action=item.action, status=item.status, audit=item.audit, expires_at=item.expires_at.isoformat(), result=resolved)
    except (Exception, asyncio.CancelledError) as exc:
        detail = exc.detail if isinstance(exc, HTTPException) else "CloudTool request failed or timed out; inspect inventory/deployments before retrying this action."
        detail = upstream_action_error(detail)
        resolved = {"status": "failed", "reason": redact(detail)}
        try:
            pending_actions.event(item, "failed")
        finally:
            pending_actions.resolve(item, resolved)
        record_api_action(action_id=item.id, actor_email=item.actor_email, project_id=item.project_id, conversation_id=item.conversation_id, action=item.action, status=item.status, audit=item.audit, expires_at=item.expires_at.isoformat(), result=resolved)
    return {**resolved, "status": item.status}


@app.get("/api/v1/pending-action-history")
async def pending_action_history(request: Request):
    caller = await gateway.caller(request)
    items = list_api_action_logs(project_id=caller.project_id, actor_email=caller.email)
    # Resolve the current display names once for the whole history page. The
    # persisted action retains only its immutable ID so renamed groups remain
    # correctly identifiable without N+1 browser lookups.
    groups = await gateway.security_groups_for_template(caller)
    names = {str(group.get("id")): str(group.get("name") or group.get("display_name") or group.get("displayName") or group.get("title") or "").strip() for group in groups}
    for item in items:
        action = item.get("action") or {}
        group_id = str(action.get("security_group_id") or "")
        if group_id and names.get(group_id):
            action["security_group_name"] = names[group_id]
    return {"items": items}


@app.get("/api/v1/security-groups/{security_group_id}/display-name")
async def security_group_display_name(security_group_id: str, request: Request):
    caller = await gateway.caller(request)
    return {"name": await gateway.security_group_name(caller, security_group_id)}


@app.post("/api/v1/pending-action-history/{action_id}/replay")
async def replay_pending_action(action_id: str, payload: dict, request: Request):
    caller = await gateway.caller(request)
    history = get_api_action_log(project_id=caller.project_id, actor_email=caller.email, action_id=action_id)
    conversation_id = str(payload.get("conversation_id") or "").strip()
    if not history or not conversation_id:
        raise HTTPException(404, "Action history or conversation was not found")
    item = await pending_actions.create(conversation_id, caller.project_id, caller.email, history["action"], int(get_codex_settings().get("approval_timeout_seconds", 180)))
    pending_actions.event(item, "awaiting_approval")
    # A manual replay has no Codex HTTP call waiting on the future, but the
    # broker must still own timeout and cleanup just like a native tool call.
    asyncio.create_task(pending_actions.wait(item))
    return item.public()


@app.post("/api/v1/csrf/refresh")
async def refresh_cloudtool_csrf(request: Request):
    """Return the CSRF token minted while validating this browser session.

    The CloudTool ``/auth/me`` endpoint rotates CSRF tokens.  Agent endpoints
    validate through it, so a write-capable browser flow must explicitly obtain
    the freshly minted value immediately before calling the Cloud API.
    """
    caller = await gateway.caller(request)
    return {"csrf_token": caller.csrf_token}


@app.get("/api/v1/logs")
async def execution_logs(request: Request, limit: int = 25, offset: int = 0):
    """Return redacted internal-agent execution logs for project administrators."""
    caller = await admin_caller(request)
    items, total = list_execution_logs(project_id=caller.project_id, limit=limit, offset=offset)
    return {"items": items, "total": total}


@app.get("/api/v1/logs/{log_id}")
async def execution_log_detail(log_id: str, request: Request):
    caller = await admin_caller(request)
    item = get_execution_log(project_id=caller.project_id, log_id=log_id)
    if not item:
        raise HTTPException(404, "Execution log not found")
    return item


@app.delete("/api/v1/logs")
async def purge_execution_logs(request: Request, before: datetime):
    caller = await admin_caller(request)
    # Execution logs are stored with the CloudTool GMT+7 ISO offset.  Keep the
    # same normalized representation so SQLite's lexical timestamp comparison
    # remains chronological.
    cutoff = before.astimezone(timezone(timedelta(hours=7))).isoformat()
    deleted = delete_execution_logs_before(project_id=caller.project_id, before=cutoff)
    write_audit(actor_email=caller.email, project_id=caller.project_id, action="agent.execution_logs.purge", result="success", metadata={"before": cutoff, "deleted": deleted})
    return {"deleted": deleted, "before": cutoff}


@app.get("/api/v1/conversations", response_model=list[Conversation])
async def conversations(request: Request, response: Response, limit: int = 15, offset: int = 0):
    caller = await gateway.caller(request, require_cloud_token=False)
    limit = max(1, min(limit, 15)); offset = max(0, offset)
    items = list_conversations(project_id=caller.project_id, actor_email=caller.email, limit=limit + 1, offset=offset)
    response.headers["X-Has-More"] = "true" if len(items) > limit else "false"
    return items[:limit]

@app.get("/api/v1/conversations/{conversation_id}", response_model=Conversation)
async def conversation_detail(conversation_id: str, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    item = get_conversation(project_id=caller.project_id, actor_email=caller.email, conversation_id=conversation_id)
    if not item: raise HTTPException(404, "Conversation not found")
    return item


def _codex_history_runtime(project_id: str) -> dict:
    """Build the same isolated cwd used when this project's Codex turns run."""
    workspace = prepare_project_workspace(project_id, initialize_files=False)
    runtime = get_codex_settings()
    runtime["workdir"] = workspace.path
    runtime["runtime_workspace_roots"] = [workspace.path, *workspace.source_roots]
    return runtime


@app.get("/api/v1/codex-history/threads")
async def codex_history_threads(request: Request):
    """List Codex-owned conversations directly from its local rollout store."""
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        return {"threads": await list_history_threads(_codex_history_runtime(caller.project_id))}
    except CodexAppServerError as exc:
        raise HTTPException(503, f"Unable to load Codex chat history: {exc}") from exc
    except (OSError, RuntimeError, ValueError, asyncio.TimeoutError) as exc:
        detail = str(exc).strip() or type(exc).__name__
        raise HTTPException(503, f"Unable to prepare Codex chat history: {detail}") from exc


@app.get("/api/v1/codex-history/threads/{thread_id}")
async def codex_history_thread(thread_id: str, request: Request):
    """Return one full Codex transcript without consulting Agent Service DB."""
    caller = await gateway.caller(request, require_cloud_token=False)
    try:
        return await read_history_thread(thread_id, _codex_history_runtime(caller.project_id))
    except CodexAppServerError as exc:
        # Do not distinguish a missing thread from one outside the current
        # workspace; both must remain private.
        raise HTTPException(404, "Codex chat history was not found in this project") from exc
    except (OSError, RuntimeError, ValueError, asyncio.TimeoutError) as exc:
        detail = str(exc).strip() or type(exc).__name__
        raise HTTPException(503, f"Unable to prepare Codex chat history: {detail}") from exc


@app.patch("/api/v1/conversations/{conversation_id}")
async def rename_chat_conversation(conversation_id: str, payload: ConversationTitleUpdate, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    title = payload.title.strip()
    if not title:
        raise HTTPException(422, "Conversation title is required")
    if not rename_conversation(project_id=caller.project_id, actor_email=caller.email, conversation_id=conversation_id, title=title):
        raise HTTPException(404, "Conversation not found")
    return {"id": conversation_id, "title": title}


@app.delete("/api/v1/conversations/{conversation_id}", status_code=204)
async def remove_chat_conversation(conversation_id: str, request: Request):
    caller = await gateway.caller(request, require_cloud_token=False)
    if not delete_conversation(project_id=caller.project_id, actor_email=caller.email, conversation_id=conversation_id):
        raise HTTPException(404, "Conversation not found")
    return None


@app.post("/api/v1/requests/{request_id}/cancel")
async def cancel_chat_request(request_id: str, request: Request):
    caller = await gateway.caller(request)
    cancelled = await cancel_codex_request(request_id)
    user_questions.cancel_request(request_id, caller.project_id, caller.email)
    if not cancelled:
        raise HTTPException(409, "Codex request is no longer running")
    return {"request_id": request_id, "cancelled": True}


ActivityReporter = Callable[[str, dict], Awaitable[None]]


@app.post("/api/v1/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, request: Request, report_activity: ActivityReporter | None = None):
    started_at = perf_counter()
    activity_records: list[dict] = []
    async def report(event_type: str, data: dict) -> None:
        activity_records.append({"event": event_type, **data})
        if report_activity:
            await report_activity(event_type, {"request_id": payload.request_id, **data})

    if len(payload.message.strip()) > settings.MAX_MESSAGE_CHARS:
        raise HTTPException(422, "Message is too long")
    caller = await gateway.caller(request)
    conversation_id = payload.conversation_id or str(uuid4())
    try:
      async with conversation_lock(conversation_id):
        await report("policy", {"policy": "workspace_artifact_only", "detail": "Codex may create user-requested files only in the project outputs folder."})
        await report("mcp_ready", {"detail": "CloudTool read-only retrieval tools are available to Codex on demand."})
        # Do not pre-load project inventory into the prompt. Codex receives the
        # minimal request context and retrieves only the data it needs through
        # the per-request MCP server.
        # No project JSON is preloaded into every turn. Project identity is
        # already in the configurable workspace instruction and live facts
        # remain available through MCP on demand.
        context: dict = {}
        evidence: list[dict] = []
        mcp_context = {
            "CLOUDTOOL_MCP_EMAIL": caller.email,
            "CLOUDTOOL_MCP_PROJECT_ID": caller.project_id,
            "CLOUDTOOL_MCP_TOKEN": caller.cloud_token,
            "CLOUDTOOL_MCP_COOKIE": caller.cookie,
            # Codex may run from a configured workspace outside agent-service.
            # Make the private MCP module importable without changing that
            # workspace or writing a global Codex configuration.
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]) + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else ""),
        }
        runtime = get_codex_settings()
        if payload.model is not None:
            runtime["model"] = payload.model
        if payload.reasoning_effort is not None:
            runtime["reasoning_effort"] = payload.reasoning_effort
        try:
            # The signed-in local Codex instance is the sole source of truth
            # for models and supported reasoning levels.
            await validate_model_selection(runtime)
        except CodexModelCatalogError as exc:
            raise HTTPException(422, str(exc)) from exc
        # A project keeps its own Codex cwd, so threads see a stable project
        # directory while source reading stays limited to the explicit roots.
        workspace = prepare_project_workspace(caller.project_id)
        runtime["workdir"] = workspace.path
        # CWD alone is not a read grant in the Codex app-server sandbox. Add
        # the project workspace so pasted images and uploaded files are truly
        # readable by Codex, alongside the approved source roots.
        runtime["runtime_workspace_roots"] = [workspace.path, *workspace.source_roots]
        workspace_prompt = str(runtime.get("workspace_prompt") or "").replace("{project_id}", caller.project_id)
        project_chat_prompt = str(runtime.get("project_chat_prompt") or "")
        runtime["system_prompt"] = f"{runtime.get('system_prompt') or ''}\n\n{workspace_prompt}\n\n{project_chat_prompt}".strip()
        runtime["system_prompt"] += (
            "\n\nFor VM configuration discovery, first read api-docs/vm-creation-lookups.md. "
            "Use get_vm_creation_options or batch_vm_creation_options for live project facts. "
            "Batch independent reads and make further calls in this same turn for dependent "
            "zone/region/subnet choices or pagination. Ask only for genuine user decisions or "
            "missing requirements, not permission to perform each read. These APIs only read configuration."
            " When multiple valid choices remain and the user has not specified which one, use "
            "request_user_input (or ask_user_question) to ask 1-3 grouped clarification questions. "
            "Include real names/IDs and useful differences in choices. Wait for the user's explicit "
            "answer; no preselected/default option is consent. Empty answers mean unanswered or "
            "cancelled: do not create a VM or guess missing values. Questions are not write approval."
            " For project writes read api-docs/project-create-actions.md. Only create_private_ip, "
            "create_elastic_ip, create_vm_deployment, attach_private_ip and attach_elastic_ip "
            "are enabled in addition to SG rules. Use native action tools and wait for each "
            "permission decision/result before dependent writes; never use MCP/shell/HTTP for writes."
        )
        runtime["system_prompt"] += (
            "\n\nGenerated deliverables: you may create or update files only under `outputs/` "
            "when the user explicitly asks for a file. Never modify `uploads/`, `project-data/`, "
            "`project-data-simple/`, `excel-template/`, `api-docs/`, source roots, or any other path. "
            "Use a concise descriptive filename, do not overwrite an input/template, and state the exact "
            "`outputs/...` path after successful creation."
        )
        try:
            selected_skills = resolve_skills(actor_email=caller.email, skill_ids=payload.skill_ids)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        if selected_skills:
            runtime["system_prompt"] += "\n\nSelected agent skills for this conversation:\n" + "\n\n".join(
                f"## {skill['title']}\n{skill['instructions']}" for skill in selected_skills
            )
        pending = await pending_actions.create(conversation_id, caller.project_id, caller.email, {})
        async def call_pending_action_api(tool: str, arguments: object) -> dict:
            """Native app-server API bridge; Codex receives neither credentials nor a shell."""
            if not isinstance(arguments, dict):
                raise ValueError("Unsupported CloudTool action API call")
            if tool == "ask_user_question":
                return await user_questions.ask(
                    conversation_id=conversation_id, project_id=caller.project_id,
                    actor_email=caller.email, request_id=payload.request_id, payload=arguments,
                )
            if tool == "create_security_group_rule":
                action = security_group_rule_batch_action(
                    arguments.get("security_group_id"),
                    arguments.get("rules") if isinstance(arguments.get("rules"), list) else [arguments.get("rule")],
                )
            elif tool in PROJECT_TOOLS:
                action = project_action(tool, arguments)
            elif tool == "create_vm_deployment" and isinstance(arguments.get("deployment"), dict):
                import httpx
                async with httpx.AsyncClient(timeout=settings.REQUEST_TIMEOUT_SECONDS) as client:
                    validation = await client.post(
                        f"{settings.backend_url}/provisioning/internal/agent/deployments/validate",
                        headers={**gateway._headers(caller), "X-Agent-Service-Key": settings.AGENT_SERVICE_BACKEND_KEY or ""},
                        json=arguments["deployment"],
                    )
                if not validation.is_success:
                    detail = redact(upstream_action_error(validation.json() if validation.content else "VM configuration validation failed"))
                    raise ValueError(json.dumps(detail, ensure_ascii=False))
                deployment = validation.json()["deployment"]
                action = {"type": "vm_deployment.create", "deployment": deployment, "summary": f"Queue VM deployment {str(deployment.get('name') or 'Server deployment')[:160]}"}
            else:
                action = None
            if not action:
                raise ValueError("Invalid CloudTool action API payload")
            item = await pending_actions.requested(pending, action, int(runtime["approval_timeout_seconds"]))
            pending_actions.event(item, "awaiting_approval")
            return await pending_actions.wait(item)
        try:
            workspace_attachments = store_workspace_attachments(workspace, [attachment.model_dump() for attachment in payload.attachments])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        artifacts_before = workspace_artifact_snapshot(workspace)
        question_for_codex = payload.message.strip()
        is_agent_event = payload.agent_event is not None
        if is_agent_event:
            question_for_codex = f"[GATEWAY_RESULT]\n{json.dumps(payload.agent_event, ensure_ascii=False)}\n[/GATEWAY_RESULT]"
        if workspace_attachments:
            references = "\n".join(f"@{item['path']}" for item in workspace_attachments)
            question_for_codex = f"{question_for_codex}\n[ATTACHED_WORKSPACE_FILES]\n{references}\n[/ATTACHED_WORKSPACE_FILES]"
        logged_prompt = prompt_preview(
            question_for_codex, None, None,
            runtime.get("system_prompt"), mcp_available=True,
        )
        await report("codex_started", {"model": runtime.get("model") or "CLI default", "reasoning_effort": runtime["reasoning_effort"], "detail": "Codex is preparing a read-only answer.", "workspace": workspace.path})
        previous = next((item for item in list_conversations(project_id=caller.project_id, actor_email=caller.email) if item["id"] == conversation_id), None)
        selected_model = str(runtime.get("model") or "")
        selected_reasoning_effort = str(runtime["reasoning_effort"])
        # Preserve the exact Codex thread for the whole CloudTool
        # conversation.  The app-server accepts model/effort overrides on
        # ``turn/start``; codex_app_server forwards the current UI selection
        # there, so a setting change does not lose thread context.
        previous_session_id = str(previous.get("codex_session_id") or "") if previous else ""
        session_id = previous_session_id or None
        if previous_session_id and (
            previous.get("codex_model") != selected_model
            or previous.get("codex_reasoning_effort") != selected_reasoning_effort
        ):
            await report("codex_settings_updated", {
                "model": runtime.get("model") or "CLI default",
                "reasoning_effort": selected_reasoning_effort,
                "detail": "Model or reasoning changed; applying the selected configuration to this Codex conversation.",
            })
        try:
            async def report_execution(data: dict) -> None:
                if report_activity:
                    await report_activity("codex_event", {"request_id": payload.request_id, **data})

            answer_text, model_used, mode, codex_session_id = await answer(
                question_for_codex, context, None, runtime, session_id,
                payload.request_id, mcp_context, call_pending_action_api,
                **({"execution_reporter": report_execution} if report_activity else {}),
            )
        except CodexSessionUnavailableError as exc:
            await report("session_unavailable", {"detail": "Codex confirmed that the saved thread no longer exists. Your saved chat remains unchanged.", "conversation_id": conversation_id})
            raise HTTPException(409, {"code": "codex_session_unavailable", "message": str(exc)}) from exc
        if not pending.action:
            await pending_actions.discard(pending.id)
        artifacts = created_workspace_artifacts(workspace, artifacts_before)
        vm_action = extract_vm_action(answer_text)
        # The structured action is delivered separately to the browser.  Do
        # not show an implementation-only JSON fence in the conversation.
        answer_text = remove_vm_action_block(answer_text) if vm_action else answer_text
        conversation_id = append_exchange(
                project_id=caller.project_id, actor_email=caller.email,
                conversation_id=conversation_id, question=payload.message.strip() or "File analysis",
                answer=answer_text, evidence=evidence, attachments=workspace_attachments, codex_session_id=codex_session_id,
                artifacts=artifacts,
                codex_model=selected_model, codex_reasoning_effort=selected_reasoning_effort,
                skill_ids=[skill["id"] for skill in selected_skills],
            )
        await report("saving_conversation", {"detail": "Saving the answer and evidence to conversation history."})
        write_execution_log(
            actor_email=caller.email, project_id=caller.project_id, conversation_id=conversation_id,
            request_id=payload.request_id, status="success" if mode == "codex-app-server" else mode,
            model=model_used, reasoning_effort=runtime["reasoning_effort"], mode=mode,
            user_input=payload.message.strip(), prompt_text=logged_prompt, context=context,
            answer_text=answer_text, activity=activity_records,
            metadata={"evidence": evidence, "attachment_count": len(payload.attachments), "artifact_count": len(artifacts), "vm_action_proposed": bool(vm_action), "codex_workspace": workspace.path, "chat_model": model_used or "CLI default", "reasoning_effort": selected_reasoning_effort},
            duration_ms=int((perf_counter() - started_at) * 1000),
        )
        write_audit(
            actor_email=caller.email, project_id=caller.project_id,
            action="agent.chat.read_only", result="success",
            metadata={"conversation_id": conversation_id, "sources": evidence, "mode": mode, "attachment_count": len(payload.attachments)},
        )
        return ChatResponse(
            request_id=payload.request_id, conversation_id=conversation_id, answer=answer_text,
            evidence=[Evidence(**item) for item in evidence], attachments=workspace_attachments, artifacts=artifacts, model_used=model_used, mode=mode,
            csrf_token=caller.csrf_token, vm_action=VmAction(**vm_action) if vm_action else None,
        )
    except HTTPException:
        raise
    except Exception as exc:
        write_audit(
            actor_email=caller.email, project_id=caller.project_id,
            action="agent.chat.read_only", result="failed",
            # Keep the UI response generic, but retain a bounded redacted
            # diagnostic so a degraded turn never becomes an opaque failure.
            metadata={
                "conversation_id": conversation_id,
                "error": f"{type(exc).__name__}: {str(exc)[:500]}",
                # Keep a bounded server-side traceback for diagnosing degraded
                # turns. It is written only to Agent Service's local audit DB
                # and is never returned to the browser.
                "traceback": traceback.format_exc(limit=12)[-4000:],
            },
        )
        return ChatResponse(
            request_id=payload.request_id,
            conversation_id=conversation_id,
            answer="Khong the thu thap day du bang chung cua project. Khong co thay doi nao duoc thuc hien.",
            evidence=[], mode="degraded", csrf_token=caller.csrf_token,
        )


def sse(event_type: str, data: dict) -> str:
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/v1/chat/stream")
async def chat_stream(payload: ChatRequest, request: Request) -> StreamingResponse:
    """Stream lifecycle and actual Codex app-server execution notifications."""
    await gateway.caller(request)

    async def events():
        queue: asyncio.Queue[tuple[str, dict]] = asyncio.Queue()

        async def report(event_type: str, data: dict) -> None:
            await queue.put((event_type, data))

        async def run() -> None:
            try:
                response = await chat(payload, request, report)
                await queue.put(("completed", response.model_dump()))
            except HTTPException as exc:
                await queue.put(("error", {"request_id": payload.request_id, "status": exc.status_code, "message": str(exc.detail)}))
            except Exception:
                await queue.put(("error", {"request_id": payload.request_id, "status": 500, "message": "Chat stream failed"}))

        task = asyncio.create_task(run())
        yield sse("started", {"request_id": payload.request_id})
        try:
            while True:
                event_type, data = await queue.get()
                yield sse(event_type, data)
                if event_type in {"completed", "error"}:
                    break
        finally:
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.post("/api/v1/external/chat", response_model=ChatResponse)
async def external_chat(payload: ExternalChatRequest, request: Request):
    """Run a safe local-Codex chat for an API-key-authenticated client.

    It intentionally has no CloudTool gateway access.  Cloud data remains
    available only through the browser/session-protected ``/chat`` endpoint.
    """
    external_api_caller(request)
    conversation_id = payload.conversation_id or str(uuid4())
    actor_email = f"api:{payload.client_id}"
    project_id = "external"
    try:
      async with conversation_lock(f"{actor_email}:{conversation_id}"):
        runtime = get_codex_settings()
        if payload.model is not None:
            runtime["model"] = payload.model
        if payload.reasoning_effort is not None:
            runtime["reasoning_effort"] = payload.reasoning_effort
        previous = next((item for item in list_conversations(project_id=project_id, actor_email=actor_email) if item["id"] == conversation_id), None)
        selected_model = str(runtime.get("model") or "")
        selected_reasoning_effort = str(runtime["reasoning_effort"])
        session_id = previous.get("codex_session_id") if previous and previous.get("codex_model") == selected_model and previous.get("codex_reasoning_effort") == selected_reasoning_effort else None
        answer_text, model_used, mode, codex_session_id = await answer(
            payload.message.strip(),
            {"external_api": {"note": "No CloudTool project data was supplied to this request."}},
            [attachment.model_dump() for attachment in payload.attachments],
            runtime,
            session_id,
            payload.request_id,
        )
        conversation_id = append_exchange(
            project_id=project_id, actor_email=actor_email, conversation_id=conversation_id,
            question=payload.message.strip(), answer=answer_text,
            evidence=[{"source": "external_api", "count": 0, "note": "No CloudTool data"}],
            codex_session_id=codex_session_id,
            codex_model=selected_model, codex_reasoning_effort=selected_reasoning_effort,
        )
        write_audit(actor_email=actor_email, project_id=project_id, action="agent.external_chat.read_only", result="success", metadata={"conversation_id": conversation_id, "mode": mode})
        return ChatResponse(
            request_id=payload.request_id, conversation_id=conversation_id, answer=answer_text,
            evidence=[Evidence(source="external_api", count=0, note="No CloudTool data")],
            model_used=model_used, mode=mode,
        )
    except HTTPException:
        raise
    except Exception:
        write_audit(actor_email=actor_email, project_id=project_id, action="agent.external_chat.read_only", result="failed", metadata={"conversation_id": conversation_id})
        raise HTTPException(502, "External Codex chat failed")
        write_audit(
            actor_email=caller.email, project_id=caller.project_id,
            action="agent.chat.read_only", result="failed",
            metadata={"conversation_id": conversation_id},
        )


@app.post("/api/v1/external/chat/stream")
async def external_chat_stream(payload: ExternalChatRequest, request: Request) -> StreamingResponse:
    external_api_caller(request)

    async def events():
        yield sse("started", {"request_id": payload.request_id})
        try:
            response = await external_chat(payload, request)
            yield sse("completed", response.model_dump())
        except HTTPException as exc:
            yield sse("error", {"request_id": payload.request_id, "status": exc.status_code, "message": str(exc.detail)})
        except Exception:
            yield sse("error", {"request_id": payload.request_id, "status": 500, "message": "Chat stream failed"})

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})


@app.post("/api/v1/external/requests/{request_id}/cancel")
async def cancel_external_chat_request(request_id: str, request: Request):
    external_api_caller(request)
    return {"request_id": request_id, "cancelled": await cancel_codex_request(request_id)}


def _legacy_unreachable_response():
        # A partial Cloud API outage must not turn the whole frontend route
        # into an error page. This is still read-only and the user can retry.
        return ChatResponse(
            conversation_id=conversation_id,
            answer=(
                "Không thể thu thập đầy đủ bằng chứng của project ở lần này. "
                "Không có thay đổi nào được thực hiện. Hãy thử lại sau hoặc "
                "kiểm tra kết nối agent-service tới CloudTool backend."
            ),
            evidence=[],
            mode="degraded",
            csrf_token=caller.csrf_token,
        )
