from app.models import Role, User

FEATURES = {
    "servers",
    "private_ips",
    "security_groups",
    "audit_logs",
    "password_profiles",
    "user_management",
}


def default_permissions(role: Role) -> list[str]:
    if role is Role.admin:
        return sorted(FEATURES)
    if role is Role.operator:
        return sorted(FEATURES - {"user_management"})
    return sorted({"servers", "private_ips", "audit_logs"})


def has_permission(user: User, permission: str) -> bool:
    return user.role is Role.admin or permission in (user.permissions or [])


def cloud_path_permission(path: str) -> str | None:
    if "attach-privateip" in path or "attach-private-ips" in path:
        return "servers"
    if path.startswith("/legacy/api/infra/servers"):
        return "servers"
    if path.startswith(
        ("/legacy/api/infra/security-groups", "/legacy/api/infra/security-group-rules")
    ):
        return "security_groups"
    if path.startswith(
        ("/legacy/api/infra/private-ips", "/legacy/api/infra/subnets", "/legacy/api/infra/vpc-peerings", "/legacy/api/infra/vpcs")
    ):
        return "private_ips"
    return None


def cloud_request_denial(user: User, method: str, path: str) -> str | None:
    permission = cloud_path_permission(path)
    if permission and not has_permission(user, permission):
        return f"Missing feature permission: {permission}"
    if method.upper() not in {"GET", "HEAD", "OPTIONS"} and user.cloud_api_access != "full":
        return "Cloud API access is read-only for this account"
    return None
