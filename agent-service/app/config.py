from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # app/config.py -> agent-service/.env (not the workspace-root .env)
        env_file=Path(__file__).resolve().parents[1] / ".env",
        case_sensitive=True,
        extra="ignore",
    )

    APP_ENV: Literal["development", "test", "production"] = "development"
    HOST: str = "127.0.0.1"
    PORT: int = 8004
    CLOUDTOOL_BACKEND_URL: str = "http://127.0.0.1:8003/api/v1"
    CORS_ORIGINS: list[str] = ["http://localhost:5173", "http://localhost:5000"]
    TRUSTED_HOSTS: list[str] = ["localhost", "127.0.0.1"]
    REQUEST_TIMEOUT_SECONDS: float = Field(30, ge=3, le=90)
    MAX_MESSAGE_CHARS: int = Field(4000, ge=200, le=12000)
    MAX_CONTEXT_BYTES: int = Field(180_000, ge=20_000, le=500_000)
    AGENT_OPENAI_API_KEY: str | None = None
    AGENT_OPENAI_MODEL: str = "gpt-5.4"
    # The service executes conversations through the locally authenticated Codex CLI.
    # Do not expose an OpenAI API option until that execution path is implemented.
    # Keep the removed value parseable so deployments with an old environment
    # file can migrate it in runtime_settings instead of failing to boot.
    AGENT_LLM_PROVIDER: Literal["codex_app_server", "codex_cli", "evidence_only"] = "codex_app_server"
    CODEX_COMMAND: str = "codex"
    CODEX_MODEL: str | None = None
    CODEX_REASONING_EFFORT: Literal["low", "medium", "high", "xhigh", "max", "ultra"] = "medium"
    CODEX_WORKDIR: str = str(Path(__file__).resolve().parents[2])
    # Browser chats override CODEX_WORKDIR with a stable, isolated directory
    # for the authenticated CloudTool project.
    CODEX_PROJECT_WORKSPACE_ROOT: str = str(Path(__file__).resolve().parents[1] / "data" / "codex-projects")
    # Only selected source directories below this root are supplied to Codex.
    # Keeping the repository root itself out of the allow-list protects .env
    # files and other operational data.
    CODEX_SOURCE_ROOT: str = str(Path(__file__).resolve().parents[2])
    CODEX_TIMEOUT_SECONDS: int = Field(120, ge=30, le=600)
    CODEX_TERMINAL_ENABLED: bool = False
    CODEX_SYSTEM_PROMPT: str = """You are CloudTool's read-only diagnostic assistant.
Answer in Vietnamese. Use CloudTool MCP only for current project facts; retrieve the smallest useful data.
Never execute shell commands, access local files, browse the web, request credentials, or perform write actions yourself.
Tool guide: search_servers(query) finds servers; use search_servers() with an empty query for the exact server count; get_server_details(id) gets one server; get_inventory() gets inventory; list_subnets() gets networking; list_security_groups() gets network policy; get_audit_events() gets audit history; get_cloud_api_history() gets Cloud API history. Search first, then request details only when needed.
All MCP tools are read-only. For VM troubleshooting, you may propose a smallest-safe CLI command in a bash code block, but never execute it or include passwords; the UI requires separate user approval. If data is insufficient, say so. Give observed facts, likely causes, and safe next checks."""
    # External clients must explicitly opt in by setting this value.  Keeping it
    # empty means that the public chat endpoint is disabled.
    AGENT_EXTERNAL_API_KEY: str | None = None
    AGENT_SERVICE_BACKEND_KEY: str | None = None
    PENDING_ACTION_TIMEOUT_SECONDS: int = Field(180, ge=60, le=900)

    @property
    def backend_url(self) -> str:
        return self.CLOUDTOOL_BACKEND_URL.rstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
