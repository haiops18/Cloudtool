from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import Response
from starlette.requests import Request
from app.api.routers import auth

@pytest.mark.asyncio
@pytest.mark.parametrize('remaining,renewed', [(60, True), (auth.settings.SESSION_TTL_SECONDS, False)])
async def test_me_renews_active_cookie_without_rotating_session(remaining, renewed):
    session = SimpleNamespace(expires_at=datetime.now(UTC) + timedelta(seconds=remaining))
    db = SimpleNamespace(commit=AsyncMock())
    request = Request({'type': 'http', 'headers': [(b'cookie', f'{auth.settings.SESSION_COOKIE_NAME}=existing-session'.encode())]})
    response = Response()
    output = SimpleNamespace(model_copy=lambda **kwargs: kwargs)
    with patch.object(auth, 'current_csrf', AsyncMock(return_value='existing-csrf')), patch.object(auth.UserOut, 'model_validate', return_value=output):
        await auth.me(request, response, object(), session, db)
    assert db.commit.await_count == int(renewed)
    cookies = response.headers.getlist('set-cookie')
    if renewed:
        assert any('existing-session' in cookie and 'HttpOnly' in cookie for cookie in cookies)
        assert any('existing-csrf' in cookie for cookie in cookies)
        assert session.expires_at > datetime.now(UTC) + timedelta(seconds=auth.settings.SESSION_TTL_SECONDS - 5)
    else:
        assert not cookies

def test_cloud_unauthorized_does_not_expire_web_session():
    from app.gateway.client import CloudApiGateway
    assert CloudApiGateway._local_status(401) == 403
    assert CloudApiGateway._local_status(403) == 403
    assert CloudApiGateway._local_status(429) == 429
