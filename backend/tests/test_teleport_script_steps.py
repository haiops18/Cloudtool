import re
import sys

import pytest
from fastapi import HTTPException

from app.services.teleport_script import (
    is_interactive_password_script,
    render_script_delays,
    run_timed_terminal,
    script_steps,
)


def test_sleep_steps_and_script_commands():
    assert script_steps("passwd admin {{sleep.1s}} secret {{sleep.0.5s}} secret", 90) == [
        (0, "passwd admin"),
        (1, "secret"),
        (0.5, "secret"),
    ]
    assert render_script_delays("df -h {{sleep.2s}} free -h", 90) == "df -h \nsleep 2\n free -h"
    assert render_script_delays("  echo a\n\n", 90) == "  echo a\n\n"


@pytest.mark.parametrize(
    "command",
    [
        "a {{sleep.-1s}} b",
        "a {{sleep.2ms}} b",
        "a {{sleep.90s}} b",
        "a {{sleep.50s}} b {{sleep.40s}} c",
    ],
)
def test_invalid_and_excessive_delays_rejected(command):
    with pytest.raises(HTTPException) as error:
        script_steps(command, 90)
    assert error.value.status_code == 422


def test_real_local_pty_delays_input_until_ready_and_redacts_input(tmp_path):
    # A harmless local process stands in for tsh + a remote password prompt.
    marker = "__READY_TEST__"
    program = """import sys,time
start=time.monotonic()
time.sleep(0.15)
print('__READY_TEST__',flush=True)
first=input('New password: ')
a=time.monotonic()-start
second=input('Retype password: ')
b=time.monotonic()-start
print('TIMING %.3f %.3f' % (a,b),flush=True)
print(first,second,flush=True)
time.sleep(0.25)
print('COMMAND_FINISHED',flush=True)
sys.exit(0 if first == second else 1)
"""
    code, output = run_timed_terminal(
        ["-u", "-c", program],
        binary=sys.executable,
        home=tmp_path,
        marker=marker,
        inputs=[(0.15, "sample-secret"), (0.2, "sample-secret")],
        timeout=10,
    )
    assert code == 0
    assert "COMMAND_FINISHED" in output
    assert "sample-secret" not in output
    assert marker not in output
    assert "[redacted]" in output
    timing = re.search(r"TIMING (\d+\.\d+) (\d+\.\d+)", output)
    assert timing, output
    first, second = map(float, timing.groups())
    assert first >= 0.28
    assert second - first >= 0.18


def test_interactive_timeout_kills_local_process(tmp_path):
    with pytest.raises(TimeoutError):
        run_timed_terminal(
            ["-u", "-c", "import time;time.sleep(5)"],
            binary=sys.executable,
            home=tmp_path,
            marker="missing-marker",
            inputs=[],
            timeout=0.2,
        )


def test_command_exiting_before_inputs_is_not_reported_as_success(tmp_path):
    code, output = run_timed_terminal(
        ["-u", "-c", "print('__READY_TEST__',flush=True)"],
        binary=sys.executable,
        home=tmp_path,
        marker="__READY_TEST__",
        inputs=[(1, "sample-secret")],
        timeout=5,
    )
    assert code == 1
    assert "before all interactive input steps" in output
    assert "sample-secret" not in output


@pytest.mark.parametrize(
    ("script", "expected"),
    [
        ("passwd admin  \n{{sleep.1s}}  \nsecret \n{{sleep.1s}} secret", True),
        ("/usr/bin/passwd admin {{sleep.1s}} secret {{sleep.1s}} secret", True),
        ("df -h {{sleep.2s}} free -h", False),
        ("passwd -S admin {{sleep.1s}} df -h", False),
        ("echo 'admin:secret' | chpasswd", False),
    ],
)
def test_auto_detects_password_prompts_without_changing_ordinary_scripts(script, expected):
    assert is_interactive_password_script(script) is expected
