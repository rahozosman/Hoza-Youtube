"""Process helpers, with one restriction: we only ever stop our own.

The old development supervisor cleared a busy port by terminating whatever held
it. That is fine on a developer's machine and unacceptable in a shipped
product, so nothing in this module can stop a process that this installation
did not start. Ownership is established by pid *and* by executable path, so a
recycled pid belonging to something else is never mistaken for ours.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0)

# Every Chromium browser the extension can run in, plus Firefox.
BROWSER_EXECUTABLES = {
    "chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "opera.exe",
    "opera_gx.exe", "chromium.exe", "firefox.exe", "thorium.exe", "yandex.exe",
}


def _psutil():
    try:
        import psutil
    except ImportError:
        return None
    return psutil


def browser_running() -> bool:
    """True while any browser that could be hosting the extension is alive."""
    psutil = _psutil()
    if psutil is None:
        # With no way to tell, a backend that stays up costs a little memory.
        # One that shuts down under a browser that is still open costs the user
        # their download.
        return True
    try:
        for proc in psutil.process_iter(["name"]):
            if (proc.info.get("name") or "").lower() in BROWSER_EXECUTABLES:
                return True
    except Exception:
        return True
    return False


def alive(pid: int | None, *, exe: str | None = None) -> bool:
    """True when `pid` is running and, if given, is running `exe`."""
    if not isinstance(pid, int) or pid <= 0:
        return False
    psutil = _psutil()
    if psutil is None:
        return False
    try:
        proc = psutil.Process(pid)
        if not proc.is_running():
            return False
        if exe is None:
            return True
        try:
            actual = proc.exe()
        except Exception:
            return False
        return Path(actual).resolve() == Path(exe).resolve()
    except Exception:
        return False


def stop(pid: int | None, *, exe: str | None = None, what: str = "process",
         timeout: float = 10.0) -> bool:
    """Ask `pid` to exit, then insist. Refuses anything that is not ours."""
    if not alive(pid, exe=exe):
        return False
    psutil = _psutil()
    if psutil is None:
        return False
    try:
        proc = psutil.Process(int(pid))
        proc.terminate()
        try:
            proc.wait(timeout=timeout)
            return True
        except psutil.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            return True
    except Exception:
        return False


def spawn_detached(command: list[str], *, cwd: str | None = None,
                   env: dict[str, str] | None = None,
                   stdout=None, stderr=None) -> subprocess.Popen | None:
    """Start a process that outlives its parent and never shows a window."""
    try:
        return subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout if stdout is not None else subprocess.DEVNULL,
            stderr=stderr if stderr is not None else subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
            close_fds=True,
        )
    except OSError:
        return None


def spawn_child(command: list[str], *, cwd: str | None = None,
                env: dict[str, str] | None = None,
                stdout=None, stderr=None) -> subprocess.Popen | None:
    """Start a process this one supervises: no window, but not detached, so
    its exit code comes back here."""
    try:
        return subprocess.Popen(
            command,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stdout if stdout is not None else subprocess.DEVNULL,
            stderr=stderr if stderr is not None else subprocess.STDOUT,
            creationflags=CREATE_NO_WINDOW,
            close_fds=True,
        )
    except OSError:
        return None


def clean_environment() -> dict[str, str]:
    """A copy of this process's environment, minus anything PyInstaller added
    for its own bootstrap that a child must not inherit."""
    env = dict(os.environ)
    for name in ("_PYI_APPLICATION_HOME_DIR", "_MEIPASS2", "_PYI_ARCHIVE_FILE",
                 "_PYI_PARENT_PROCESS_LEVEL"):
        env.pop(name, None)
    if getattr(sys, "frozen", False):
        # A frozen child re-reads these from its own bundle.
        env.pop("PYTHONHOME", None)
        env.pop("PYTHONPATH", None)
    return env
