from types import SimpleNamespace

from app.core.permissions import cloud_request_denial, default_permissions
from app.models import Role


def user(role=Role.operator, permissions=None, access="read"):
    return SimpleNamespace(
        role=role,
        permissions=permissions or [],
        cloud_api_access=access,
    )


def test_read_only_user_can_get_but_cannot_mutate_cloud_resources():
    account = user(permissions=["servers"], access="read")
    path = "/legacy/api/infra/servers/server-1/"

    assert cloud_request_denial(account, "GET", path) is None
    assert "read-only" in cloud_request_denial(account, "PATCH", path)


def test_feature_permission_is_enforced_before_cloud_call():
    account = user(permissions=["private_ips"], access="full")

    assert "servers" in cloud_request_denial(
        account, "GET", "/legacy/api/infra/servers/"
    )
    assert (
        cloud_request_denial(
            account, "POST", "/legacy/api/infra/private-ips/"
        )
        is None
    )


def test_admin_defaults_include_user_management_and_full_feature_set():
    assert "user_management" in default_permissions(Role.admin)
    assert "user_management" not in default_permissions(Role.operator)
