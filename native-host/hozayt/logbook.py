"""Logging for processes that have no console and no one watching.

A native messaging host must never write to stdout -- Chrome reads that as a
message frame and drops the port when it is not one -- so every role logs to a
file instead, one file per role so a crashed backend does not bury the host's
account of what it was doing.

Deliberately not `logging`: these processes are started detached, are killed
without warning, and a plain appended line that survives that is worth more
than handlers and formatters.
"""

from __future__ import annotations

import os
import sys
import threading
import traceback
from datetime import datetime
from pathlib import Path

from . import places

MAX_BYTES = 1_000_000
KEEP = 2

_lock = threading.Lock()
_role = "app"


def bind(role: str) -> None:
    """Name the log file for this process."""
    global _role
    _role = role


def path() -> Path:
    return places.log_dir() / f"{_role}.log"


def _rotate(target: Path) -> None:
    try:
        if not target.exists() or target.stat().st_size <= MAX_BYTES:
            return
    except OSError:
        return
    for index in range(KEEP, 0, -1):
        older = target.with_suffix(f".log.{index}")
        newer = target if index == 1 else target.with_suffix(f".log.{index - 1}")
        try:
            if newer.exists():
                older.unlink(missing_ok=True)
                newer.replace(older)
        except OSError:
            return


def write(message: str, *, level: str = "info") -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {level:<5}  [{os.getpid()}]  {message}"
    target = path()
    with _lock:
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            _rotate(target)
            with target.open("a", encoding="utf-8", errors="replace") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
        # Only the roles that own a console echo there. The host never does.
        if _role not in ("host",) and sys.stderr is not None:
            try:
                print(line, file=sys.stderr, flush=True)
            except (OSError, ValueError):
                pass


def info(message: str) -> None:
    write(message)


def warn(message: str) -> None:
    write(message, level="warn")


def error(message: str) -> None:
    write(message, level="error")


def exception(message: str) -> None:
    write(f"{message}\n{traceback.format_exc()}", level="error")


def install_excepthook() -> None:
    """Make an unhandled exception in a windowless process leave a trace."""

    def handler(kind, value, tb):
        write("".join(traceback.format_exception(kind, value, tb)), level="error")

    sys.excepthook = handler
