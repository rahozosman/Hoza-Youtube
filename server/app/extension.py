"""Extension presence tracking.

The browser extension posts a heartbeat when its popup opens and when it hands
a link to the dashboard. Nothing is inferred: until a heartbeat arrives, the
dashboard reports the extension as not yet seen rather than disconnected.
"""

from __future__ import annotations

import threading
import time
from typing import Any

_lock = threading.Lock()
_state: dict[str, Any] = {
    "seen": False,
    "last_seen": 0.0,
    "version": None,
    "browser": None,
    "pings": 0,
}

# A link the extension handed over, waiting for the dashboard to pick it up.
_handoff: dict[str, Any] | None = None
STALE_AFTER = 120.0
HANDOFF_TTL = 300.0


def ping(version: str | None = None, browser: str | None = None) -> dict[str, Any]:
    with _lock:
        _state["seen"] = True
        _state["last_seen"] = time.time()
        _state["pings"] += 1
        if version:
            _state["version"] = version
        if browser:
            _state["browser"] = browser
        return dict(_state)


def status() -> dict[str, Any]:
    with _lock:
        state = dict(_state)
    state["connected"] = bool(
        state["seen"] and time.time() - state["last_seen"] < STALE_AFTER
    )
    state["age_seconds"] = (
        round(time.time() - state["last_seen"]) if state["seen"] else None
    )
    return state


def offer(payload: dict[str, Any]) -> None:
    """Store a link the extension wants the dashboard to analyse."""
    global _handoff
    with _lock:
        _handoff = {**payload, "at": time.time()}


def take() -> dict[str, Any] | None:
    """Return and clear a pending handoff, if it is still fresh."""
    global _handoff
    with _lock:
        pending = _handoff
        _handoff = None
    if not pending:
        return None
    if time.time() - pending.get("at", 0) > HANDOFF_TTL:
        return None
    return pending
