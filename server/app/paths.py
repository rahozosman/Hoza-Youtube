"""Filesystem locations the backend owns.

Everything the app writes lives under one of these roots. `security.contain`
checks candidate paths against them, so a traversal attempt cannot escape.
"""

from __future__ import annotations

import os
from pathlib import Path

# server/app/paths.py -> server/
SERVER_DIR = Path(__file__).resolve().parent.parent
APP_DIR = SERVER_DIR / "app"
STATIC_DIR = SERVER_DIR / "static"

# Each running instance owns its state. Two instances sharing one data
# directory would overwrite each other's configuration, so a second instance on
# the same machine must be given its own with --data-dir.
DATA_DIR = Path(os.environ.get("HOZA_DATA_DIR") or (SERVER_DIR / "data")).expanduser()

DB_PATH = DATA_DIR / "hoza.db"
CONFIG_PATH = DATA_DIR / "config.json"

DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "Hoza YT"
DEFAULT_TEMP_DIR = DATA_DIR / "tmp"


def ensure_dirs() -> None:
    """Create the directories the app needs. Safe to call repeatedly."""
    for d in (DATA_DIR, DEFAULT_TEMP_DIR, STATIC_DIR):
        d.mkdir(parents=True, exist_ok=True)


def free_space(path: os.PathLike | str) -> int | None:
    """Bytes free on the volume holding `path`, or None if it cannot be read."""
    import shutil

    try:
        return shutil.disk_usage(str(path)).free
    except OSError:
        return None
