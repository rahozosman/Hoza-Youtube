"""Asks GitHub whether a newer version has been published.

This is the only thing the server fetches from GitHub. It reads the latest
release of whichever repository this clone points at, so nothing has to be
configured: push to a remote and the check starts working.

The repository is resolved once, in this order:

  1. `HOZA_GITHUB_REPO`, for a checkout with no remote or an unusual one
  2. `git remote get-url origin`, parsed into `owner/name`
  3. nothing, and the check reports itself as disabled

A private repository answers 404 to an anonymous request. That is reported as
`unavailable` rather than as an error, because it is a normal state and not
something the user did wrong.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from typing import Any

from . import __version__, paths

# Once a day is plenty for a release check, and it keeps the dashboard from
# hitting GitHub's unauthenticated rate limit on every page load.
CACHE_SECONDS = 24 * 60 * 60
TIMEOUT_SECONDS = 10

_CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

_lock = threading.Lock()
_cache: dict[str, Any] | None = None
_cached_at = 0.0
_repo: str | None | bool = False  # False means "not looked up yet".


# --------------------------------------------------------------------------- #
# Which repository
# --------------------------------------------------------------------------- #

def _parse_remote(url: str) -> str | None:
    """`owner/name` out of any of the URL shapes git accepts."""
    url = url.strip()
    if not url:
        return None
    # git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
    match = re.search(r"github\.com[:/]+([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", url)
    if not match:
        return None
    return f"{match.group(1)}/{match.group(2)}"


def repository() -> str | None:
    """The `owner/name` this clone belongs to, or None if it cannot be told."""
    global _repo
    if _repo is not False:
        return _repo  # type: ignore[return-value]

    configured = os.environ.get("HOZA_GITHUB_REPO", "").strip()
    if configured:
        _repo = _parse_remote(configured) or configured
        return _repo  # type: ignore[return-value]

    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            cwd=str(paths.SERVER_DIR.parent),
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=_CREATE_NO_WINDOW,
        )
        _repo = _parse_remote(result.stdout) if result.returncode == 0 else None
    except (OSError, subprocess.SubprocessError):
        _repo = None

    return _repo  # type: ignore[return-value]


# --------------------------------------------------------------------------- #
# Comparing versions
# --------------------------------------------------------------------------- #

def _parts(version: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", version)) or (0,)


def _newer(candidate: str, current: str) -> bool:
    left, right = _parts(candidate), _parts(current)
    # Pad so 2.1 and 2.1.0 compare equal rather than by length.
    width = max(len(left), len(right))
    left += (0,) * (width - len(left))
    right += (0,) * (width - len(right))
    return left > right


# --------------------------------------------------------------------------- #
# The check
# --------------------------------------------------------------------------- #

def _fetch(repo: str) -> dict[str, Any]:
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/releases/latest",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": f"HozaYT/{__version__}",
        },
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def check(force: bool = False) -> dict[str, Any]:
    """The current release picture. Never raises; never blocks for long."""
    global _cache, _cached_at

    with _lock:
        fresh = _cache is not None and (time.time() - _cached_at) < CACHE_SECONDS
        if fresh and not force:
            return dict(_cache)  # type: ignore[arg-type]

    repo = repository()
    base: dict[str, Any] = {
        "current": __version__,
        "latest": None,
        "update_available": False,
        "repository": repo,
        "url": None,
        "published_at": None,
        "checked_at": time.time(),
    }

    if not repo:
        base["status"] = "disabled"
        base["detail"] = (
            "No GitHub remote is set, so there is nothing to check against. "
            "Push this clone to GitHub, or set HOZA_GITHUB_REPO."
        )
        return base

    try:
        release = _fetch(repo)
    except urllib.error.HTTPError as err:
        base["status"] = "unavailable"
        base["detail"] = (
            f"{repo} has no published releases yet, or it is private."
            if err.code == 404
            else f"GitHub answered {err.code}."
        )
        return base
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as err:
        base["status"] = "unavailable"
        base["detail"] = f"Could not reach GitHub: {err}"
        return base

    tag = str(release.get("tag_name") or "").lstrip("vV")
    base.update(
        status="ok",
        latest=tag or None,
        update_available=bool(tag) and _newer(tag, __version__),
        url=release.get("html_url"),
        published_at=release.get("published_at"),
        detail=None,
    )

    with _lock:
        _cache = dict(base)
        _cached_at = time.time()

    return base
