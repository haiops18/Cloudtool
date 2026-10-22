from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

from app.core.security import validate_server_password


class LoginIn(BaseModel):
    identifier: str | None = Field(None, min_length=1, max_length=320)
    # Retained for callers of the former email-only contract.
    email: str | None = None
    password: str = Field(min_length=8, max_length=256)

    @model_validator(mode="after")
    def require_identifier(self) -> "LoginIn":
        if not (self.identifier or self.email):
            raise ValueError("Username or email is required")
        return self


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    username: str
    full_name: str
    role: str
    is_active: bool
    permissions: list[str] = Field(default_factory=list)
    cloud_api_access: Literal["read", "full"] = "read"
    csrf_token: str | None = None


class UserIn(BaseModel):
    username: str = Field(min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    email: EmailStr
    full_name: str = Field(min_length=1, max_length=200)
    password: str = Field(min_length=8, max_length=256)
    role: Literal["admin", "operator", "viewer"] = "viewer"
    permissions: list[str] | None = None
    cloud_api_access: Literal["read", "full"] = "read"

    @field_validator("permissions")
    @classmethod
    def valid_permissions(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        from app.core.permissions import FEATURES

        if unknown := set(value) - FEATURES:
            raise ValueError(f"Unknown permissions: {', '.join(sorted(unknown))}")
        return sorted(set(value))


class UserPatch(BaseModel):
    username: str | None = Field(None, min_length=1, max_length=120, pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
    email: EmailStr | None = None
    full_name: str | None = Field(None, min_length=1, max_length=200)
    role: Literal["admin", "operator", "viewer"] | None = None
    is_active: bool | None = None
    permissions: list[str] | None = None
    cloud_api_access: Literal["read", "full"] | None = None
    password: str | None = Field(None, min_length=8, max_length=256)

    @field_validator("permissions")
    @classmethod
    def valid_permissions(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        from app.core.permissions import FEATURES

        if unknown := set(value) - FEATURES:
            raise ValueError(f"Unknown permissions: {', '.join(sorted(unknown))}")
        return sorted(set(value))


class PasswordProfileIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    username: str = Field(min_length=1, max_length=120)
    password: str

    @field_validator("password")
    @classmethod
    def password_policy(cls, value: str) -> str:
        return validate_server_password(value)


class CliCommandIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    category: str = Field(default="General", min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    command: str = Field(min_length=1, max_length=20000)
    is_favorite: bool = False
    shared_variables: dict[str, str] = Field(default_factory=dict)

    @field_validator("shared_variables")
    @classmethod
    def validate_shared_variables(cls, value: dict[str, str]) -> dict[str, str]:
        if len(value) > 100:
            raise ValueError("A command can contain at most 100 shared variables")
        for key, item in value.items():
            if not key or len(key) > 80 or not key.replace("_", "a").isalnum() or not key[0].isalpha():
                raise ValueError("Shared variable names must use letters, numbers and underscores, starting with a letter")
            if len(item) > 4000:
                raise ValueError("Shared variable values must not exceed 4000 characters")
        return value


class CliCommandPatch(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=120)
    category: str | None = Field(None, min_length=1, max_length=80)
    description: str | None = Field(None, max_length=500)
    command: str | None = Field(None, min_length=1, max_length=20000)
    is_favorite: bool | None = None
    shared_variables: dict[str, str] | None = None

    @field_validator("shared_variables")
    @classmethod
    def validate_shared_variables(cls, value: dict[str, str] | None) -> dict[str, str] | None:
        return CliCommandIn.validate_shared_variables(value) if value is not None else None


class BulkIds(BaseModel):
    server_ids: list[str] = Field(min_length=1, max_length=500)


class ServerPowerBatch(BulkIds):
    """One explicitly selected bulk power operation for project servers."""

    action: Literal["start", "stop"]

    @field_validator("server_ids")
    @classmethod
    def unique_server_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Duplicate server IDs are not allowed")
        return value


class ServerDeleteItem(BaseModel):
    server_id: str = Field(min_length=1, max_length=100)
    volumes: list[str] = Field(default_factory=list, max_length=100)
    eips: list[str] = Field(default_factory=list, max_length=100)
    private_ips: list[str] = Field(default_factory=list, max_length=100)


class ServerDeleteBatch(BaseModel):
    items: list[ServerDeleteItem] = Field(min_length=1, max_length=500)

    @field_validator("items")
    @classmethod
    def unique_server_ids(cls, value: list[ServerDeleteItem]) -> list[ServerDeleteItem]:
        server_ids = [item.server_id for item in value]
        if len(server_ids) != len(set(server_ids)):
            raise ValueError("Duplicate server IDs are not allowed")
        return value


class RenameItem(BaseModel):
    server_id: str
    current_name: str | None = None
    new_name: str = Field(min_length=1, max_length=255)


class RenameBatch(BaseModel):
    items: list[RenameItem] = Field(min_length=1, max_length=500)


class ResizeServerSpecs(BaseModel):
    server_type: Literal['basic', 'gpu']
    kind: Literal['custom'] = 'custom'
    ram: float = Field(gt=0, allow_inf_nan=False)
    vcpus: int = Field(gt=0, strict=True)


class ResizeServerItem(BaseModel):
    server_id: str = Field(min_length=1, max_length=100)
    specs: ResizeServerSpecs
    live_resize: bool
    # Optional display context, never forwarded upstream.
    flavor: str | None = Field(default=None, max_length=100)
    flavor_name: str | None = Field(default=None, max_length=255)


class ResizeBatch(BaseModel):
    items: list[ResizeServerItem] = Field(min_length=1, max_length=500)

    @field_validator("items")
    @classmethod
    def unique_server_ids(cls, value: list[ResizeServerItem]) -> list[ResizeServerItem]:
        server_ids = [item.server_id for item in value]
        if len(server_ids) != len(set(server_ids)):
            raise ValueError("Duplicate server IDs are not allowed")
        return value


class VolumeAttachmentVolume(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    volume_type: str = Field(min_length=1, max_length=100)
    size: int = Field(ge=1, le=16384)
    description: str = Field(default="", max_length=500)


class VolumeAttachmentCreate(BaseModel):
    server_id: str = Field(min_length=1, max_length=100)
    volumes: list[VolumeAttachmentVolume] = Field(min_length=1, max_length=20)


class VolumeAttachmentStatus(BaseModel):
    volume_ids: list[str] = Field(min_length=1, max_length=20)


class VolumeAttachmentAttach(BaseModel):
    server_id: str = Field(min_length=1, max_length=100)
    volume_ids: list[str] = Field(min_length=1, max_length=20)


class VolumeAttachmentDetach(BaseModel):
    server_id: str = Field(min_length=1, max_length=100)
    volume_ids: list[str] = Field(min_length=1, max_length=20)


class ServerPasswordItem(BaseModel):
    server_id: str
    password: str

    @field_validator("password")
    @classmethod
    def password_policy(cls, value: str) -> str:
        return validate_server_password(value)


class PasswordBatch(BaseModel):
    server_ids: list[str] = Field(default_factory=list, max_length=500)
    profile_id: str | None = None
    password: str | None = None
    password_items: list[ServerPasswordItem] | None = Field(None, min_length=1, max_length=500)

    @field_validator("password")
    @classmethod
    def password_policy(cls, value: str | None) -> str | None:
        return validate_server_password(value) if value is not None else None

    @model_validator(mode="after")
    def exactly_one_password_source(self):
        sources = sum(bool(value) for value in (self.profile_id, self.password, self.password_items))
        if sources != 1:
            raise ValueError("Provide exactly one password source")
        if self.password_items:
            ids = [item.server_id for item in self.password_items]
            if len(ids) != len(set(ids)):
                raise ValueError("Duplicate server IDs are not allowed")
        elif not self.server_ids:
            raise ValueError("At least one server ID is required")
        return self


class IpRangeIn(BaseModel):
    subnet_id: str
    start_ip: str
    end_ip: str | None = None
    count: int | None = Field(None, ge=1, le=1000)
    compensate: bool = False


class OrderedPrivateIpItem(BaseModel):
    server_draft_id: str = Field(min_length=1, max_length=100)
    server_name: str = Field(min_length=1, max_length=160)
    subnet_id: str = Field(min_length=1, max_length=100)


class OrderedPrivateIpCreate(BaseModel):
    items: list[OrderedPrivateIpItem] = Field(min_length=1, max_length=200)
    max_retries: int | None = Field(default=None, ge=0, le=200)
    reuse_available: bool = True

    @field_validator("items")
    @classmethod
    def unique_server_drafts(cls, value: list[OrderedPrivateIpItem]):
        identifiers = [item.server_draft_id for item in value]
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("Each server draft may be allocated only once")
        return value


class PrivateIpDeleteBatch(BaseModel):
    subnet_id: str = Field(min_length=1)
    ip_ids: list[str] = Field(min_length=1, max_length=500)

    @field_validator("ip_ids")
    @classmethod
    def unique_ids(cls, value: list[str]) -> list[str]:
        normalized = [item.strip() for item in value if item.strip()]
        if not normalized:
            raise ValueError("At least one private IP ID is required")
        if len(normalized) != len(set(normalized)):
            raise ValueError("Duplicate private IP IDs are not allowed")
        return normalized


class AttachItem(BaseModel):
    server_id: str
    ip_id: str


class AttachBatch(BaseModel):
    items: list[AttachItem] = Field(min_length=1, max_length=500)


class DetachPrivateIpItem(BaseModel):
    server_id: str = Field(min_length=1)
    ip_id: str = Field(min_length=1)


class DetachPrivateIpBatch(BaseModel):
    items: list[DetachPrivateIpItem] = Field(min_length=1, max_length=500)


class AttachElasticIpItem(BaseModel):
    server_id: str = Field(min_length=1)
    ip_id: str = Field(min_length=1)


class AttachElasticIpBatch(BaseModel):
    items: list[AttachElasticIpItem] = Field(min_length=1, max_length=500)


class DetachElasticIpItem(BaseModel):
    server_id: str = Field(min_length=1)
    ip_id: str = Field(min_length=1)


class DetachElasticIpBatch(BaseModel):
    items: list[DetachElasticIpItem] = Field(min_length=1, max_length=500)


class DolphinInventorySync(BaseModel):
    server_ids: list[str] = Field(default_factory=list, max_length=10_000)
    # `items` is the user-reviewed preview. The backend still verifies every
    # external_id against the current project's saved inventory records.
    items: list[dict] = Field(default_factory=list, max_length=10_000)
    system_name: str = Field(default="", max_length=255)
    action: Literal["allocate", "revoke", "lookup"] = "allocate"

    @field_validator("server_ids")
    @classmethod
    def unique_server_ids(cls, value: list[str]) -> list[str]:
        ids = [item.strip() for item in value if item.strip()]
        return list(dict.fromkeys(ids))

    @model_validator(mode="after")
    def has_items(self):
        if not self.server_ids and not self.items:
            raise ValueError("At least one server inventory record is required")
        return self


class SecurityGroupRuleIn(BaseModel):
    description: str = Field(default="", max_length=255)
    direction: Literal["ingress", "egress"]
    protocol: str = Field(min_length=1, max_length=32)
    port_range_min: int | None = Field(None, ge=1, le=65535)
    port_range_max: int | None = Field(None, ge=1, le=65535)
    remote_ip_prefix: str = Field(min_length=1, max_length=64)
    delete_at: datetime | None = None

    @model_validator(mode="after")
    def validate_rule(self):
        import ipaddress

        try:
            ipaddress.ip_network(self.remote_ip_prefix, strict=False)
        except ValueError as exc:
            raise ValueError("remote_ip_prefix must be a valid IPv4 or IPv6 CIDR") from exc
        if (self.port_range_min is None) != (self.port_range_max is None):
            raise ValueError("Both port range values must be provided together")
        if self.port_range_min and self.port_range_max and self.port_range_min > self.port_range_max:
            raise ValueError("port_range_min cannot be greater than port_range_max")
        return self


class SecurityGroupRuleBatch(BaseModel):
    items: list[SecurityGroupRuleIn] = Field(min_length=1, max_length=500)


class SecurityGroupRuleImportItem(SecurityGroupRuleIn):
    client_id: str = Field(min_length=1, max_length=120)
    security_group_id: str = Field(min_length=1, max_length=120)


class SecurityGroupRuleImportBatch(BaseModel):
    items: list[SecurityGroupRuleImportItem] = Field(min_length=1, max_length=1000)


class SecurityGroupRuleDeleteBatch(BaseModel):
    verify_exists: bool = False
    rule_ids: list[str] = Field(min_length=1, max_length=500)


class SecurityGroupRuleDescriptionUpdate(BaseModel):
    description: str = Field(default="", max_length=255)
    delete_at: datetime | None = None


class Page(BaseModel):
    items: list[Any]
    total: int
    page: int
    page_size: int


class ServerSecurityGroupsUpdate(BaseModel):
    security_groups: list[str] = Field(max_length=500)
    expected_security_groups: list[str] = Field(max_length=500)
