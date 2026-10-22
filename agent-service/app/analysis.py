from __future__ import annotations

from typing import Any, Awaitable, Callable

from app.codex_app_server import CodexAppServerError, CodexSessionUnavailableError, answer as codex_answer
from app.runtime_settings import get_codex_settings


def fallback(question: str, evidence: dict[str, Any]) -> str:
    return (
        "Evidence-only mode is active. No cloud action was performed.\n\n"
        f"Question: {question}\n"
        f"Evidence sources: {', '.join(evidence.keys()) or 'none'}."
    )


async def answer(
    question: str,
    evidence: dict[str, Any],
    attachments: list[dict[str, str]] | None = None,
    runtime: dict[str, Any] | None = None,
    session_id: str | None = None,
    request_id: str | None = None,
    mcp_context: dict[str, str] | None = None,
    dynamic_tool_handler: Callable[[str, Any], Awaitable[dict[str, Any]]] | None = None,
    execution_reporter: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> tuple[str, str | None, str, str | None]:
    runtime = runtime or get_codex_settings()
    if runtime["provider"] != "codex_app_server":
        return fallback(question, evidence), None, "evidence-only", session_id
    try:
        text, model, codex_session_id = await codex_answer(
            question=question,
            evidence=evidence,
            config=runtime,
            attachments=attachments,
            session_id=session_id,
            request_id=request_id,
            mcp_context=mcp_context,
            dynamic_tool_handler=dynamic_tool_handler,
            execution_reporter=execution_reporter,
        )
        return text, model, "codex-app-server", codex_session_id
    except CodexSessionUnavailableError:
        raise
    except CodexAppServerError as exc:
        return f"Codex app-server is unavailable: {exc}. No cloud action was performed.", None, "degraded", session_id
