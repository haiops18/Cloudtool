import pytest
from pydantic import ValidationError

from app.schemas.common import PasswordBatch


def test_password_batch_accepts_custom_password():
    payload = PasswordBatch(server_ids=["server-1"], password="StrongPass1!")
    assert payload.password == "StrongPass1!"
    assert payload.profile_id is None


def test_password_batch_accepts_profile():
    payload = PasswordBatch(server_ids=["server-1"], profile_id="profile-1")
    assert payload.profile_id == "profile-1"
    assert payload.password is None


@pytest.mark.parametrize(
    "values",
    [
        {},
        {"profile_id": "profile-1", "password": "StrongPass1!"},
        {"password": "weak"},
    ],
)
def test_password_batch_rejects_invalid_sources(values):
    with pytest.raises(ValidationError):
        PasswordBatch(server_ids=["server-1"], **values)


@pytest.mark.asyncio
async def test_password_results_keep_structured_upstream_detail():
    from unittest.mock import AsyncMock, patch
    from fastapi import HTTPException
    from app.api.routers.cloud import change_password
    detail = {"message": "Gateway wrapper", "upstream_detail": {"message": "Password change is not supported"}}
    with patch("app.api.routers.cloud.cloud_v1.call", new=AsyncMock(side_effect=HTTPException(400, detail))), patch("app.api.routers.cloud.write_audit", new=AsyncMock()):
        result = await change_password(PasswordBatch(server_ids=["vm"], password="StrongPass1!"), ("project", "token", None), None, None, None)
    assert result["items"][0]["status"] == "failed"
    assert result["items"][0]["error_detail"] == detail
