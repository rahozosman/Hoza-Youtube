"""Where the installed application keeps things.

Two roots, and they are deliberately different:

  * the program directory is what the installer wrote and the uninstaller
    removes -- code, the bundled runtime, ffmpeg;
  * the data directory is the user's -- database, settings, downloads history,
    logs, runtime state. An upgrade replaces the first and never touches the
    second.

Everything is per-user under LOCALAPPDATA, which is what lets the whole product
install without asking for administrator rights.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


def frozen() -> bool:
    """True when running from the packaged executable rather than a checkout."""
    return bool(getattr(sys, "frozen", False))


def program_dir() -> Path:
    """The folder holding the executable (or the repository, in development)."""
    if frozen():
        return Path(sys.executable).resolve().parent
    # native-host/hozayt/places.py -> repository root
    return Path(__file__).resolve().parent.parent.parent


def server_dir() -> Path:
    """The folder the `app` package is imported from.

    Packaged, PyInstaller puts it beside the executable's bundle. From a
    checkout it is `server/`.
    """
    if frozen():
        base = Path(getattr(sys, "_MEIPASS", program_dir()))
        return base
    return program_dir() / "server"


def _local_app_data() -> Path:
    raw = os.environ.get("LOCALAPPDATA")
    if raw:
        return Path(raw)
    return Path.home() / "AppData" / "Local"


def data_dir() -> Path:
    """Everything the application writes for this user."""
    override = os.environ.get("HOZA_HOME")
    root = Path(override).expanduser() if override else _local_app_data() / "HozaYT"
    return root


def backend_data_dir() -> Path:
    """What the backend calls its data directory: database, config, temp."""
    return data_dir() / "data"


def log_dir() -> Path:
    return data_dir() / "logs"


def runtime_path() -> Path:
    """The file that says where the backend is listening, and with what token."""
    return data_dir() / "runtime.json"


def lock_path() -> Path:
    return data_dir() / "supervisor.lock"


def ensure_dirs() -> None:
    for directory in (data_dir(), backend_data_dir(), log_dir()):
        try:
            directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            pass


def executable() -> str:
    """The command that re-invokes this program in another role."""
    if frozen():
        return sys.executable
    return sys.executable  # python.exe; the role script is added by the caller


def relaunch_command(*args: str) -> list[str]:
    """Build an argument list that starts this program again in another role."""
    if frozen():
        return [sys.executable, *args]
    runner = program_dir() / "native-host" / "run.py"
    return [sys.executable, str(runner), *args]
