"""Port selection and health probing.

The rule this module exists to enforce: a port that is taken belongs to
whoever took it. Nothing here ever kills a stranger to free an address. If
8765 is busy the question asked is only "is that our backend?", and the answer
decides between adopting it and moving to a different port.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

from . import APP_ID

HOST = "127.0.0.1"

# The address the extension and the dashboard have always used. Everything else
# is a fallback for a machine where something else got there first.
PREFERRED_PORT = 8765
FALLBACK_RANGE = range(8766, 8800)


def port_free(port: int, host: str = HOST) -> bool:
    """True when nothing is listening on `host:port` right now."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind((host, port))
            return True
        except OSError:
            return False


def health(port: int, host: str = HOST, token: str | None = None,
           timeout: float = 3.0) -> dict[str, Any] | None:
    """The health document from `host:port`, or None when nothing answered."""
    url = f"http://{host}:{port}/api/health"
    request = urllib.request.Request(url)
    if token:
        request.add_header("X-Hoza-Token", token)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read(256 * 1024).decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return payload if isinstance(payload, dict) else None


def is_ours(port: int, host: str = HOST, token: str | None = None) -> bool:
    """True when the thing on this port is a Hoza YT backend.

    The signature is in the health document rather than inferred from the
    process, so this works whether the backend was started by this supervisor,
    by another one, or by a developer running the server from a checkout.
    """
    payload = health(port, host, token, timeout=2.0)
    return bool(payload) and payload.get("app") == APP_ID


def serving(port: int, host: str = HOST, token: str | None = None) -> bool:
    """True when our backend on this port is fit to take requests.

    "degraded" means ffmpeg is missing: unhappy, but still answering, and the
    dashboard says so itself. Restarting over that would fix nothing.
    """
    payload = health(port, host, token, timeout=3.0)
    if not payload or payload.get("app") != APP_ID:
        return False
    return payload.get("status") in {"online", "degraded"}


def choose_port(preferred: int = PREFERRED_PORT, host: str = HOST,
                token: str | None = None) -> tuple[int, bool]:
    """Pick the port to serve on.

    Returns `(port, adopt)`. `adopt` is True when a Hoza YT backend is already
    listening there and should simply be used -- a second Chrome profile, or a
    developer's server from a checkout, is not a reason to start a second copy.
    """
    for candidate in (preferred, PREFERRED_PORT):
        if port_free(candidate, host):
            return candidate, False
        if is_ours(candidate, host, token):
            return candidate, True

    for candidate in FALLBACK_RANGE:
        if port_free(candidate, host):
            return candidate, False

    # Every candidate is held by something that is not ours. Ask the OS for
    # anything at all rather than failing to start.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((host, 0))
        return probe.getsockname()[1], False
