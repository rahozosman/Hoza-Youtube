"""The session token that guards the API in a packaged installation.

Loopback and CORS already keep an ordinary web page out of this API: a
cross-origin request carrying `Content-Type: application/json` is preflighted,
and the preflight is refused for anything but the extension and the dashboard
itself. This adds a second, independent lock, so that a program running as the
same user still has to have been told the secret before it can queue a
download or read the history.

The token is generated once per session by the supervisor and handed to exactly
two callers:

  * the extension, over native messaging, which Chrome only opens for the one
    extension named in the host manifest;
  * the dashboard, injected into the page the backend itself serves, which no
    other origin is allowed to read.

Development is unaffected. `python server/server.py` sets no token, nothing is
required, and every existing workflow behaves exactly as it did.
"""

from __future__ import annotations

import hmac
import os

# Endpoints that answer without a token. Health has to: the supervisor, the
# installer's verification and any second instance on the network use it to
# find out whether this process is alive, and none of them can be handed a
# secret first. Its unauthenticated form says only that the server is up.
PUBLIC_PATHS = frozenset({"/api/health"})

HEADER = "X-Hoza-Token"
QUERY = "token"

_token = os.environ.get("HOZA_API_TOKEN", "").strip()
_packaged = os.environ.get("HOZA_PACKAGED", "") == "1"


def token() -> str:
    return _token


def packaged() -> bool:
    """True when running as the installed application rather than a checkout."""
    return _packaged


def required() -> bool:
    """Whether callers must present the token. False for a plain dev server."""
    return bool(_token)


def matches(candidate: str | None) -> bool:
    """Constant-time comparison, so a wrong token leaks nothing by timing."""
    if not _token:
        return True
    if not candidate:
        return False
    return hmac.compare_digest(candidate, _token)


def authenticated(request) -> bool:
    """Whether this request carried the token.

    The header is what the extension and the dashboard's own calls use. The
    query parameter exists for `EventSource`, which the browser will not let a
    page add headers to; it never leaves this machine.
    """
    if not required():
        return True
    presented = request.headers.get(HEADER)
    if presented is None:
        presented = request.query_params.get(QUERY)
    return matches(presented)


def allows(path: str, request) -> bool:
    """Whether this request may proceed."""
    if not required():
        return True
    if path in PUBLIC_PATHS:
        return True
    if not path.startswith("/api/"):
        return True
    return authenticated(request)
