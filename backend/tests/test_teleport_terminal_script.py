from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.api.routers.teleport import TshSshIn, tsh_ssh


@pytest.mark.asyncio
@pytest.mark.parametrize("login", ["root", "app"])
async def test_password_script_is_sent_to_remote_shell_stdin_once(login):
    user = SimpleNamespace(id="user")
    db = SimpleNamespace(
        get=AsyncMock(return_value=SimpleNamespace(created_by="user", verify_tls=True))
    )
    script = "printf '%s\n' 'admin:sample-password' | chpasswd\nid"
    with (
        patch("app.api.routers.teleport.tsh_host_for_request", new=AsyncMock(return_value="node")),
        patch("app.api.routers.teleport.tsh_binary", return_value="tsh"),
        patch("app.api.routers.teleport.tsh_home", return_value=Path("isolated-home")),
        patch("app.api.routers.teleport.run_tsh", new=AsyncMock(return_value=(0, ""))) as run,
    ):
        result = await tsh_ssh(
            "link",
            TshSshIn(host="10.0.0.2", login=login, command=script),
            user,
            None,
            db,
        )
    run.assert_awaited_once_with(
        "ssh",
        f"--login={login}",
        "--no-relogin",
        "node",
        "sh -s",
        input_data=script + "\n",
        allow_error=True,
        home=Path("isolated-home"),
        binary="tsh",
    )
    assert result["exit_code"] == 0
    assert result["status"] == "success"
    assert result["output"] == ""


@pytest.mark.asyncio
async def test_remote_failure_returns_exit_code_and_actual_stderr_for_each_vm():
    user = SimpleNamespace(id="user")
    db = SimpleNamespace(
        get=AsyncMock(return_value=SimpleNamespace(created_by="user", verify_tls=False))
    )
    with (
        patch("app.api.routers.teleport.tsh_host_for_request", new=AsyncMock(return_value="node")),
        patch("app.api.routers.teleport.tsh_binary", return_value="tsh"),
        patch("app.api.routers.teleport.tsh_home", return_value=Path("isolated-home")),
        patch(
            "app.api.routers.teleport.run_tsh",
            new=AsyncMock(return_value=(1, "chpasswd: Permission denied")),
        ) as run,
    ):
        result = await tsh_ssh(
            "link",
            TshSshIn(host="node", login="app", command="chpasswd"),
            user,
            None,
            db,
        )
    assert result["status"] == "failed"
    assert result["exit_code"] == 1
    assert result["output"] == "chpasswd: Permission denied"
    assert run.call_args.args[0] == "--insecure"


@pytest.mark.asyncio
async def test_script_cannot_use_another_users_link():
    db = SimpleNamespace(get=AsyncMock(return_value=SimpleNamespace(created_by="another-user")))
    with (
        patch("app.api.routers.teleport.run_tsh", new=AsyncMock()) as run,
        pytest.raises(HTTPException) as error,
    ):
        await tsh_ssh(
            "link",
            TshSshIn(host="node", login="root", command="df -h"),
            SimpleNamespace(id="user"),
            None,
            db,
        )
    assert error.value.status_code == 404
    run.assert_not_awaited()


@pytest.mark.asyncio
async def test_interactive_passwd_executes_command_and_sends_delayed_inputs_separately():
    user = SimpleNamespace(id="user")
    db = SimpleNamespace(
        get=AsyncMock(return_value=SimpleNamespace(created_by="user", verify_tls=True))
    )
    with (
        patch("app.api.routers.teleport.tsh_host_for_request", new=AsyncMock(return_value="node")),
        patch("app.api.routers.teleport.tsh_binary", return_value="tsh"),
        patch("app.api.routers.teleport.tsh_home", return_value=Path("isolated-home")),
        patch(
            "app.api.routers.teleport.run_timed_terminal", return_value=(0, "Password updated")
        ) as run,
    ):
        result = await tsh_ssh(
            "link",
            TshSshIn(
                host="node",
                login="root",
                command="passwd admin  \n{{sleep.1s}}  \nexample-secret  \n{{sleep.2s}} example-secret",
            ),
            user,
            None,
            db,
        )
    arguments = run.call_args.args[0]
    assert "-t" in arguments
    assert "passwd admin" in arguments[-1]
    assert "example-secret" not in arguments[-1]
    assert run.call_args.kwargs["inputs"] == [(1.0, "example-secret"), (2.0, "example-secret")]
    assert result["status"] == "success"
