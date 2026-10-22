from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ENV_FILE = Path(__file__).resolve().parents[2] / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE, case_sensitive=True, extra="ignore"
    )
    APP_ENV: Literal["development", "test", "production"] = "development"
    DEBUG: bool = False
    DEBUG_LOG_AUTHORIZATION: bool = False
    DATABASE_URL: str = "sqlite+aiosqlite:///../data/cloudtool-runtime.db"
    TELEMETRY_DATABASE_URL: str = "sqlite+aiosqlite:///../data/cloudtool-telemetry.db"
    APP_TIMEZONE: str = "Asia/Bangkok"
    CORS_ORIGINS: list[str] = ["http://localhost:5173"]
    TRUSTED_HOSTS: list[str] = ["localhost", "127.0.0.1"]
    PAGE_SIZE_DEFAULT: int = Field(20, ge=1, le=200)
    PAGE_SIZE_MAX: int = Field(100, ge=1, le=1000)
    # Cloud API list calls are always fetched in bounded pages, then merged by
    # the gateway adapter so callers receive complete result sets.
    CLOUD_API_LIST_PAGE_SIZE: int = Field(100, ge=1, le=100)
    CLOUD_API_BASE_URL: str = "https://console.viettelcloud.vn"
    # Optional internal route: server creation by default, or all legacy APIs
    # when CLOUD_API_USE_SERVER_BASE_URL is enabled.
    CLOUD_API_SERVER_BASE_URL: str | None = None
    # Temporary migration: route every legacy API through the internal gateway.
    CLOUD_API_USE_SERVER_BASE_URL: bool = False
    CLOUD_API_SERVER_PREFIX: str = "/legacy/api"
    CLOUD_API_ALLOWED_HOSTS: list[str] = ["console.viettelcloud.vn", "vnc.viettelcloud.vn"]
    CLOUD_CONCURRENCY_LIMIT: int = Field(5, ge=1, le=25)
    CLOUD_API_TIMEOUT_SECONDS: float = 30
    CLOUD_API_CONNECT_TIMEOUT_SECONDS: float = 10
    VPC_INTERNET_ACCESS_TIMEOUT_SECONDS: float = 300
    # Dolphin is a separate internal resource-management integration. Its key
    # is never exposed through CloudTool APIs or audit metadata.
    DOLPHIN_BASE_URL: str = "http://10.60.159.7:8057"
    DOLPHIN_INGEST_PATH: str = "/api/noc/resource-ingest"
    DOLPHIN_API_KEY: str | None = None
    DOLPHIN_SOURCE: str = "cloudtool"
    DOLPHIN_TIMEOUT_SECONDS: float = Field(120, ge=10, le=600)
    CLOUD_API_RETRY_COUNT: int = Field(2, ge=0, le=5)
    TOKEN_MAX_IDLE_SECONDS: int = 1800
    DEBUG_CLOUD_APPROVAL_MODE: bool = False
    UPLOAD_MAX_BYTES: int = 5_242_880
    EXPORT_MAX_ROWS: int = 50_000
    LOG_RETENTION_DAYS: int = 90
    SESSION_TTL_SECONDS: int = 28_800
    SESSION_COOKIE_NAME: str = "cloudtool_session"
    CSRF_COOKIE_NAME: str = "cloudtool_csrf"
    PASSWORD_PROFILE_ENCRYPTION_KEY: str | None = None
    # Local tsh is optional. Its profile/certificates are isolated by the
    # Teleport router per CloudTool user and endpoint.
    TELEPORT_TSH_COMMAND: str = "tsh"
    TELEPORT_TSH_TIMEOUT_SECONDS: int = Field(90, ge=10, le=300)
    TELEPORT_TSH_HOME: str | None = None
    # Used for saved Cloud Authorizations. Falls back to the existing profile
    # key for backward-compatible deployments, but a dedicated key is preferred.
    CLOUD_AUTHORIZATION_ENCRYPTION_KEY: str | None = None
    BOOTSTRAP_ADMIN_EMAIL: str | None = None
    BOOTSTRAP_ADMIN_PASSWORD: str | None = None
    TERRAFORM_SERVICE_URL: str | None = None
    TERRAFORM_GATEWAY_URL: str = "http://127.0.0.1:8000"
    TERRAFORM_SERVICE_TOKEN: str | None = None
    AGENT_SERVICE_BACKEND_KEY: str | None = None
    TERRAFORM_EXECUTION_TTL_SECONDS: int = Field(3600, ge=300, le=86400)
    PROVISIONING_TELEPORT_VERSIONS: dict[str, str] = {
        "central": "13.4.14",
        "north": "16.4.11",
    }
    PROVISIONING_TELEPORT_TOKENS: dict[str, str] = {}
    PROVISIONING_MONITOR_NIC_PREFIX: int = Field(24, ge=1, le=32)

    @field_validator(
        "DEBUG",
        "DEBUG_LOG_AUTHORIZATION",
        "DEBUG_CLOUD_APPROVAL_MODE",
        mode="before",
    )
    @classmethod
    def parse_debug_flags(cls, value):
        if isinstance(value, str):
            lowered = value.lower()
            if lowered in {"release", "off", "no", "0", "false"}:
                return False
            if lowered in {"debug", "on", "yes", "1", "true"}:
                return True
        return value

    @model_validator(mode="after")
    def safety(self) -> "Settings":
        # Docker services use the internal DNS name ``backend`` when the
        # agent service validates the signed-in CloudTool session.  Keep this
        # private hostname trusted even when an operator supplies a restrictive
        # public-host allow-list through the deployment environment.
        if "backend" not in self.TRUSTED_HOSTS:
            self.TRUSTED_HOSTS.append("backend")
        self.CLOUD_API_BASE_URL = self.CLOUD_API_BASE_URL.rstrip("/")
        if self.CLOUD_API_USE_SERVER_BASE_URL and not self.CLOUD_API_SERVER_BASE_URL:
            raise ValueError("CLOUD_API_SERVER_BASE_URL is required for internal API routing")
        self.DOLPHIN_BASE_URL = self.DOLPHIN_BASE_URL.rstrip("/")
        self.DOLPHIN_INGEST_PATH = "/" + self.DOLPHIN_INGEST_PATH.strip("/")
        if self.CLOUD_API_SERVER_BASE_URL:
            self.CLOUD_API_SERVER_BASE_URL = self.CLOUD_API_SERVER_BASE_URL.rstrip("/")
            self.CLOUD_API_SERVER_PREFIX = "/" + self.CLOUD_API_SERVER_PREFIX.strip("/") if self.CLOUD_API_SERVER_PREFIX.strip("/") else ""
        if self.PAGE_SIZE_DEFAULT > self.PAGE_SIZE_MAX:
            raise ValueError("Invalid page limits")
        unsafe = (
            self.DEBUG
            or self.DEBUG_LOG_AUTHORIZATION
            or self.DEBUG_CLOUD_APPROVAL_MODE
            or not self.PASSWORD_PROFILE_ENCRYPTION_KEY
        )
        if self.APP_ENV == "production" and (
            unsafe or not self.CLOUD_API_BASE_URL.startswith("https://")
        ):
            raise ValueError("Unsafe production configuration")
        if self.TERRAFORM_SERVICE_URL:
            if not self.TERRAFORM_SERVICE_TOKEN or len(self.TERRAFORM_SERVICE_TOKEN) < 32:
                raise ValueError("Terraform integration requires a strong service token")
            if self.APP_ENV == "production" and not all(
                value.startswith("https://")
                for value in (self.TERRAFORM_SERVICE_URL, self.TERRAFORM_GATEWAY_URL)
            ):
                raise ValueError("Terraform integration requires HTTPS in production")
        return self

    @property
    def secure_cookie(self) -> bool:
        return self.APP_ENV == "production"

    def ensure_data_directory(self) -> None:
        for database_url in (self.DATABASE_URL, self.TELEMETRY_DATABASE_URL):
            if database_url.startswith("sqlite"):
                raw = database_url.split("///", 1)[1]
                (Path(__file__).resolve().parents[2] / raw).resolve().parent.mkdir(
                    parents=True, exist_ok=True
                )


@lru_cache
def get_settings() -> Settings:
    return Settings()
