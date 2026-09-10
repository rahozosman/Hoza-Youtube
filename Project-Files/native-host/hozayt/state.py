"""The runtime file: what is listening, where, and with which token.

This is the only thing that connects the three roles. The supervisor writes it,
the host reads it to answer the extension, the verifier reads it to check the
installation, and the backend never touches it.

It is written atomically, because a host reading a half-written file would tell
the extension to connect to a port that does not exist.
"""

from __future__ import annotations

import json
import os
import secrets
import time
from typing import Any

from . import __version__, places

# What the supervisor can be doing, in the order the extension expects to see.
STARTING = "starting"
READY = "ready"
RESTARTING = "restarting"
CRASHED = "crashed"
STOPPED = "stopped"


def new_token() -> str:
    """A per-session secret the backend requires on every API call."""
    return secrets.token_urlsafe(32)


def read() -> dict[str, Any]:
    try:
        raw = places.runtime_path().read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


def write(**fields: Any) -> dict[str, Any]:
    """Merge `fields` into the runtime file and return the result."""
    current = read()
    current.update(fields)
    current["version"] = __version__
    current["updated"] = time.time()

    places.ensure_dirs()
    target = places.runtime_path()
    temporary = target.with_suffix(".json.tmp")
    try:
        temporary.write_text(json.dumps(current, indent=2), encoding="utf-8")
        os.replace(temporary, target)
    except OSError:
        pass
    return current


def clear() -> None:
    """Say the backend is down without losing the port it was last happy on."""
    write(state=STOPPED, pid=None, token=None)


def remembered_port(default: int = 8765) -> int:
    """The port that worked last time, so a machine settles on one address."""
    value = read().get("port")
    if isinstance(value, int) and 1 <= value <= 65535:
        return value
    return default
