"""Input validation and containment.

Three jobs:

1. Decide whether a URL is safe to hand to the extractor (blocks SSRF into the
   local network and non-http schemes).
2. Keep every path the app writes inside a directory the user approved.
3. Redact anything credential-shaped before it reaches a log record.

Nothing here ever builds a shell string. Process arguments are assembled as
lists by the callers, and every value that reaches ffmpeg comes from a
validated enum rather than from free user text.
"""

from __future__ import annotations

import ipaddress
import os
import re
import socket
from pathlib import Path
from urllib.parse import urlparse

ALLOWED_SCHEMES = {"http", "https"}

# Hosts that must never be resolved on the user's behalf.
BLOCKED_HOSTNAMES = {
    "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback",
    "metadata.google.internal", "metadata", "instance-data",
}

MAX_URL_LENGTH = 2048


class ValidationError(ValueError):
    """Raised when user input fails a safety check."""

    def __init__(self, message: str, *, hint: str | None = None):
        super().__init__(message)
        self.message = message
        self.hint = hint


def _is_private_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_media_url(raw: str, *, resolve_dns: bool = True) -> str:
    """Return a normalised URL, or raise ValidationError.

    `resolve_dns` is disabled in unit tests so the checks stay offline.
    """
    if not raw or not raw.strip():
        raise ValidationError("No link was provided.", hint="Paste a media link first.")
    url = raw.strip()
    if len(url) > MAX_URL_LENGTH:
        raise ValidationError("That link is too long to process.")
    if "\n" in url or "\r" in url or "\x00" in url:
        raise ValidationError("That link contains characters that are not allowed.")

    if not re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*://", url):
        url = "https://" + url

    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise ValidationError(
            f"Links using {parsed.scheme}: are not supported.",
            hint="Only http and https links can be analysed.",
        )
    host = (parsed.hostname or "").lower().rstrip(".")
    if not host:
        raise ValidationError("That link has no host name.")
    if host in BLOCKED_HOSTNAMES:
        raise ValidationError(
            "Links to this machine cannot be analysed.",
            hint="Paste a public media link instead.",
        )

    # A literal IP address is checked directly; a name is resolved first.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if ip is not None:
        if _is_private_ip(ip):
            raise ValidationError(
                "Links to private network addresses cannot be analysed.",
                hint="This protects your local network from being probed.",
            )
    elif resolve_dns:
        try:
            infos = socket.getaddrinfo(host, None)
        except OSError:
            raise ValidationError(
                f"The host {host} could not be found.",
                hint="Check the link and your internet connection.",
            ) from None
        for info in infos:
            addr = info[4][0]
            try:
                resolved = ipaddress.ip_address(addr.split("%")[0])
            except ValueError:
                continue
            if _is_private_ip(resolved):
                raise ValidationError(
                    "That host resolves to a private network address.",
                    hint="This protects your local network from being probed.",
                )
    return url


def validate_server_url(raw: str) -> str:
    """Validate a backend server address.

    Unlike media URLs, these are *allowed* to be local: the user's own backend
    runs on 127.0.0.1, and a second instance may run on the LAN.
    """
    if not raw or not raw.strip():
        raise ValidationError("Server address is empty.")
    url = raw.strip().rstrip("/")
    if not re.match(r"^https?://", url, re.I):
        url = "http://" + url
    parsed = urlparse(url)
    if parsed.scheme.lower() not in ALLOWED_SCHEMES:
        raise ValidationError("A server address must start with http:// or https://.")
    if not parsed.hostname:
        raise ValidationError("That server address has no host name.")
    if parsed.port is not None and not (1 <= parsed.port <= 65535):
        raise ValidationError("That server port is out of range.")
    return url


def contain(candidate: os.PathLike | str, *roots: os.PathLike | str) -> Path:
    """Resolve `candidate` and confirm it sits inside one of `roots`.

    Raises ValidationError otherwise. This is the last line of defence against
    a filename template or a job payload trying to write outside the download
    and temporary directories.
    """
    target = Path(candidate).expanduser()
    try:
        target = target.resolve()
    except OSError:
        target = Path(os.path.abspath(str(target)))
    for root in roots:
        base = Path(root).expanduser()
        try:
            base = base.resolve()
        except OSError:
            base = Path(os.path.abspath(str(base)))
        try:
            if os.path.commonpath([str(target), str(base)]) == str(base):
                return target
        except ValueError:
            # Different drives on Windows: commonpath raises rather than returning.
            continue
    raise ValidationError(
        "That location is outside the folders this app is allowed to write to."
    )


_SECRET_PATTERNS = [
    re.compile(r"(?i)\b(authorization|cookie|set-cookie|x-api-key)\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)\b(token|secret|password|passwd|api[_-]?key|bearer)\b\s*[:=]\s*\S+"),
    re.compile(r"(?i)([?&](?:key|token|sig|signature|access_token|auth)=)[^&\s]+"),
]


def redact(text: str) -> str:
    """Strip credential-shaped values and control characters from log text."""
    if not text:
        return ""
    out = str(text)
    for pattern in _SECRET_PATTERNS:
        out = pattern.sub(lambda m: f"{m.group(1)}[redacted]", out)
    # Log injection: collapse newlines so one record cannot forge another.
    out = out.replace("\r", " ").replace("\n", " ")
    out = "".join(ch for ch in out if ch == "\t" or ord(ch) >= 32)
    return out.strip()
