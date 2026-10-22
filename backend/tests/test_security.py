import pytest

from app.core.security import redact, validate_server_password


def test_recursive_redaction_and_console_url():
    value = redact(
        {
            "Authorization": "Token secret",
            "nested": [{"password": "secret"}],
            "url": "https://vnc.viettelcloud.vn/vnc?token=abc",
        }
    )
    assert value["Authorization"] == "[REDACTED]"
    assert value["nested"][0]["password"] == "[REDACTED]"
    assert "abc" not in value["url"]


def test_password_policy():
    assert validate_server_password("Strong@123") == "Strong@123"
    with pytest.raises(ValueError):
        validate_server_password("abcd@123")
