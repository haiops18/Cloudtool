"""Schemas for the four narrowly scoped project mutation tools."""
from ipaddress import IPv4Address

from pydantic import BaseModel, ConfigDict, Field


def upstream_action_error(detail):
    """Prefer the upstream detail through the backend's HTTP error envelope."""
    def find(value):
        if not isinstance(value, dict):
            return None
        if value.get("upstream_detail") is not None:
            return value["upstream_detail"]
        for key in ("error", "detail"):
            found = find(value.get(key))
            if found is not None:
                return found
        return None
    found = find(detail)
    return detail if found is None else found


class PrivateIpCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    subnet_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    ip_address: IPv4Address | None = None


class ElasticIpCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    zone_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")


class IpAttach(BaseModel):
    model_config = ConfigDict(extra="forbid")
    server_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")
    ip_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._-]+$")


PROJECT_TOOLS = {
    "create_private_ip": ("private_ip.create", PrivateIpCreate, "Create a private IP in the exact subnet. Omit ip_address for a new unused IPv4 address; never guess a requested address."),
    "create_elastic_ip": ("elastic_ip.create", ElasticIpCreate, "Allocate an Elastic IP in the region of the exact zone ID."),
    "attach_private_ip": ("private_ip.attach", IpAttach, "Attach an available private IP to an existing VM using exact IDs from live results."),
    "attach_elastic_ip": ("elastic_ip.attach", IpAttach, "Attach an available Elastic IP to an existing VM using exact IDs from live results."),
}


def project_action(tool: str, arguments: dict) -> dict:
    action_type, model, _description = PROJECT_TOOLS[tool]
    parameters = model.model_validate(arguments).model_dump(mode="json", exclude_none=True)
    return {"type": action_type, "parameters": parameters,
            "summary": f"{action_type}: " + ", ".join(f"{key}={value}" for key, value in parameters.items())}


def project_tool_definitions():
    return [{"type": "function", "name": name,
             "description": description + " Uses the same browser permission/approval gateway as SG rules and returns the actual result. Read api-docs/project-create-actions.md; wait for each result before dependent writes. Never blindly retry mutations.",
             "inputSchema": model.model_json_schema()}
            for name, (_, model, description) in PROJECT_TOOLS.items()]
