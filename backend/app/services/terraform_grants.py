import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from app.core.config import get_settings


@dataclass(frozen=True)
class TerraformGrant:
    user_id: str
    project_id: str
    cloud_token: str
    mutations_allowed: bool
    expires_at: datetime


class TerraformGrantStore:
    """In-memory execution grants for the initial single-backend deployment."""

    def __init__(self) -> None:
        self._items: dict[str, TerraformGrant] = {}

    def create(
        self,
        user_id: str,
        project_id: str,
        cloud_token: str,
        *,
        mutations_allowed: bool,
    ) -> str:
        self._purge()
        ticket = secrets.token_urlsafe(48)
        self._items[ticket] = TerraformGrant(
            user_id=user_id,
            project_id=project_id,
            cloud_token=cloud_token,
            mutations_allowed=mutations_allowed,
            expires_at=datetime.now(UTC)
            + timedelta(seconds=get_settings().TERRAFORM_EXECUTION_TTL_SECONDS),
        )
        return ticket

    def get(self, ticket: str) -> TerraformGrant | None:
        self._purge()
        return self._items.get(ticket)

    def revoke(self, ticket: str) -> None:
        self._items.pop(ticket, None)

    def _purge(self) -> None:
        now = datetime.now(UTC)
        for key in [key for key, value in self._items.items() if value.expires_at <= now]:
            self._items.pop(key, None)


terraform_grants = TerraformGrantStore()
