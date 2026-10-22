from fastapi.testclient import TestClient

from app.main import app


def test_health_and_openapi_routes():
    with TestClient(app, base_url="http://localhost") as client:
        assert client.get("/health/live").json() == {"status": "ok"}
        assert client.get("/health/ready").json() == {"status": "ready"}
    assert "/api/v1/cloud/servers" in app.openapi()["paths"]
