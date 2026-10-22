"""Delay tokens and timed terminal input for user-authored Teleport scripts."""

import os
import queue
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path

from fastapi import HTTPException

SLEEP_TOKEN = re.compile(r"\{\{\s*sleep\.(\d+(?:\.\d+)?)s\s*\}\}")
SLEEP_CANDIDATE = re.compile(r"\{\{\s*sleep\.[^}]*\}\}")


def script_steps(command: str, timeout: float) -> list[tuple[float, str]]:
    """Each token separates a command/input line, with a delay before that line."""
    for candidate in SLEEP_CANDIDATE.finditer(command):
        if not SLEEP_TOKEN.fullmatch(candidate.group()):
            raise HTTPException(422, "Invalid sleep token. Use {{sleep.2s}} or {{sleep.0.5s}}.")
    steps = []
    start, delay, total = 0, 0.0, 0.0
    for token in SLEEP_TOKEN.finditer(command):
        steps.append((delay, command[start : token.start()].strip()))
        delay = float(token.group(1))
        total += delay
        start = token.end()
    steps.append((delay, command[start:].strip()))
    if total >= timeout:
        raise HTTPException(
            422, "Total sleep time must be shorter than the Teleport command timeout."
        )
    return steps


def is_interactive_password_script(command: str) -> bool:
    """Recognize passwd with delayed answers; ordinary delayed commands stay scripts."""
    token = SLEEP_TOKEN.search(command)
    if not token:
        return False
    try:
        words = shlex.split(command[: token.start()].strip())
    except ValueError:
        return False
    if not words or words[0].rsplit("/", 1)[-1] != "passwd":
        return False
    # Status/locking flags don't ask for password input.
    return not any(word.startswith("-") for word in words[1:])


def render_script_delays(command: str, timeout: float) -> str:
    script_steps(command, timeout)
    return SLEEP_TOKEN.sub(lambda token: f"\nsleep {float(token.group(1)):g}\n", command)


def run_timed_terminal(
    args: list[str],
    *,
    binary: str,
    home: Path,
    marker: str,
    inputs: list[tuple[float, str]],
    timeout: float,
) -> tuple[int, str]:
    """Send delayed input only after the remote command has reached its ready marker."""
    environment = {**os.environ, "TELEPORT_HOME": str(home), "TELEPORT_ADD_KEYS_TO_AGENT": "no"}
    master = None
    if os.name == "nt":
        try:
            from winpty import PtyProcess
        except ImportError:
            raise HTTPException(
                503, "pywinpty is required for interactive Teleport scripts on Windows."
            ) from None
        process = PtyProcess.spawn([binary, *args], env=environment)
        read = lambda: process.read(4096)
        write = lambda value: process.write(value.replace("\n", "\r\n"))
        alive = process.isalive
        finish = lambda: process.wait() or process.exitstatus or 0
        close = lambda: process.close(force=True)
    else:
        import pty
        import termios

        master, slave = pty.openpty()
        # The remote PTY controls input echo. Do not echo secrets on the local PTY.
        attributes = termios.tcgetattr(slave)
        attributes[3] &= ~termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attributes)
        try:
            process = subprocess.Popen(
                [binary, *args],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                env=environment,
                close_fds=True,
            )
        except BaseException:
            os.close(master)
            raise
        finally:
            os.close(slave)
        read = lambda: os.read(master, 4096).decode(errors="replace")
        write = lambda value: os.write(master, value.encode())
        alive = lambda: process.poll() is None
        finish = process.wait

        def close():
            if process.poll() is None:
                process.kill()
            process.wait()
            os.close(master)

    messages = queue.Queue()

    def collect():
        try:
            while True:
                chunk = read()
                if not chunk:
                    break
                messages.put(chunk)
        except (EOFError, OSError):
            pass
        finally:
            messages.put(None)

    reader = threading.Thread(target=collect, daemon=True)
    reader.start()
    output, sent, due, eof = "", 0, None, False
    exited_at = None
    deadline = time.monotonic() + timeout
    try:
        while alive() or not eof:
            now = time.monotonic()
            if not alive():
                if exited_at is None:
                    exited_at = now
                # ConPTY can keep its output pipe open after the child exits.
                # Drain queued output briefly, then close the PTY to unblock read.
                if now - exited_at >= 0.25 and messages.empty():
                    break
            if now >= deadline:
                raise TimeoutError
            try:
                chunk = messages.get(timeout=min(0.05, deadline - now))
                if chunk is None:
                    eof = True
                else:
                    output = (output + chunk)[-16000:]
                    if due is None and marker in output:
                        due = time.monotonic() + (inputs[0][0] if inputs else 0)
            except queue.Empty:
                pass
            if due is not None and sent < len(inputs) and time.monotonic() >= due and alive():
                text = inputs[sent][1]
                if text:
                    write(text + "\n")
                sent += 1
                if sent < len(inputs):
                    due = time.monotonic() + inputs[sent][0]
        code = finish()
    finally:
        close()
        reader.join(timeout=1)
    output = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output).replace(marker, "")
    for _, text in inputs:
        for secret in text.splitlines():
            if secret:
                output = output.replace(secret, "[redacted]")
    if code == 0 and any(text for _, text in inputs[sent:]):
        code = 1
        output += "\nCommand exited before all interactive input steps were sent."
    return code, output.strip()[-12000:]
