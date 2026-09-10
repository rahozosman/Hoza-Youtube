"""Backend server registry, health monitoring and failover.

The machine running this process is always registered as `local`. Additional
instances of this same application can be added in Settings, and they are
genuinely polled, genuinely measured, and genuinely used: a job routed to a
remote instance runs there and its output file is streamed back here.

Nothing in this module reports a status it did not measure. A server that has
never answered shows as unknown, not online.
"""

from __future__ import annotations

import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import unquote

import httpx

from . import config, logs, paths
from .security import ValidationError, redact, validate_server_url

ONLINE = "online"
DEGRADED = "degraded"
OFFLINE = "offline"
UNKNOWN = "unknown"

# Built-in entries. Both are always in the registry and neither can be removed:
# "local" is this machine, and "github" is the slot for the GitHub-hosted
# instance. Their addresses come from configuration, never from the server list.
LOCAL = "local"
GITHUB = "github"
BUILT_IN = (LOCAL, GITHUB)

# Consecutive failures before a server stops receiving work.
FAILURE_THRESHOLD = 2
# How long an unhealthy server is skipped before it is retried.
COOLDOWN_SECONDS = 60
# A response slower than this is healthy but degraded.
SLOW_MS = 1500


class ServerError(RuntimeError):
    """A remote instance could not be reached or refused the request.

    `transport` distinguishes a server that is genuinely unwell from one that
    simply rejected a bad request. Only the former should affect health, so a
    422 does not take a working server out of rotation.
    """

    def __init__(self, message: str, *, transport: bool = True):
        super().__init__(message)
        self.transport = transport


@dataclass
class Server:
    name: str
    url: str
    role: str = "api+worker"
    token: str | None = None
    is_local: bool = False
    # Built-in entries are permanent. The dashboard hides Remove for them and
    # the API refuses to delete them.
    built_in: bool = False

    status: str = UNKNOWN
    latency_ms: float | None = None
    last_check: float | None = None
    error: str | None = None
    metrics: dict[str, Any] = field(default_factory=dict)
    failures: int = 0
    unhealthy_until: float = 0.0

    @property
    def healthy(self) -> bool:
        if self.is_local:
            return True
        # A built-in entry waiting for an address is shown, but is not somewhere
        # a job can be sent.
        if not self.url:
            return False
        if time.time() < self.unhealthy_until:
            return False
        return self.status in (ONLINE, DEGRADED)

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "url": self.url,
            "role": self.role,
            "is_local": self.is_local,
            "built_in": self.built_in,
            "configured": bool(self.url),
            "status": self.status,
            "latency_ms": round(self.latency_ms, 1) if self.latency_ms is not None else None,
            "last_check": self.last_check,
            "error": self.error,
            "metrics": self.metrics,
            "failures": self.failures,
            "accepting_jobs": self.healthy,
            "cooldown_remaining": max(0, round(self.unhealthy_until - time.time())),
        }


_registry: dict[str, Server] = {}
_lock = threading.RLock()
_monitor: threading.Thread | None = None
_stop = threading.Event()
_port = 8765


def set_port(port: int) -> None:
    global _port
    _port = port


def current_port() -> int:
    """The port this instance is serving on.

    In a packaged installation the supervisor chooses it, so nothing may assume
    8765: the extension is told the real number over native messaging and the
    dashboard reads it from the address it was opened at.
    """
    return _port


def local_metrics() -> dict[str, Any]:
    """Real resource figures for this machine."""
    out: dict[str, Any] = {}
    try:
        import psutil

        out["cpu_percent"] = psutil.cpu_percent(interval=None)
        memory = psutil.virtual_memory()
        out["memory_percent"] = memory.percent
        out["memory_used"] = memory.used
        out["memory_total"] = memory.total
    except Exception:
        out["cpu_percent"] = None
        out["memory_percent"] = None
    try:
        directory = config.download_dir()
        free = paths.free_space(directory)
        import shutil

        usage = shutil.disk_usage(str(directory))
        out["disk_free"] = free
        out["disk_total"] = usage.total
        out["disk_percent"] = round((usage.used / usage.total) * 100, 1) if usage.total else None
    except Exception:
        out["disk_free"] = None
    try:
        from . import jobs as jobs_mod

        stats = jobs_mod.queue.stats()
        out["active_jobs"] = stats["active"]
        out["queue_length"] = stats["queued"]
    except Exception:
        out["active_jobs"] = None
        out["queue_length"] = None
    return out


def _build_registry() -> None:
    """Rebuild the registry from configuration, keeping known health state."""
    cfg = config.load()["network"]
    with _lock:
        previous = dict(_registry)
        _registry.clear()
        local = previous.get(LOCAL) or Server(
            name=LOCAL,
            url=f"http://127.0.0.1:{_port}",
            role="api+worker",
            is_local=True,
            built_in=True,
        )
        local.url = f"http://127.0.0.1:{_port}"
        local.built_in = True
        local.status = ONLINE
        local.latency_ms = 0.0
        local.last_check = time.time()
        local.metrics = local_metrics()
        _registry[LOCAL] = local

        # The GitHub entry is permanent in the same way, but unlike local it
        # starts with no address. Until one is set it sits in the list saying
        # so, rather than pretending to be a server that is merely offline.
        github = previous.get(GITHUB) or Server(name=GITHUB, url="", built_in=True)
        github.built_in = True
        github.url = ""
        raw = str(cfg.get("github_url") or "").strip()
        if raw:
            try:
                github.url = validate_server_url(raw)
            except ValidationError as exc:
                logs.warning("network", f"Ignoring the GitHub server address: {exc}")
        if not github.url:
            github.status = UNKNOWN
            github.latency_ms = None
            github.error = None
            github.failures = 0
            github.unhealthy_until = 0.0
        _registry[GITHUB] = github

        for index, entry in enumerate(cfg["servers"], start=1):
            if not isinstance(entry, dict) or not entry.get("url"):
                continue
            try:
                url = validate_server_url(entry["url"])
            except ValidationError as exc:
                logs.warning("network", f"Ignoring server entry: {exc}")
                continue
            name = str(entry.get("name") or f"server-{index}").strip() or f"server-{index}"
            if name in BUILT_IN:
                name = f"{name}-{index}"
            existing = previous.get(name)
            server = existing or Server(name=name, url=url)
            server.url = url
            server.role = str(entry.get("role") or "api+worker")
            server.token = entry.get("token") or None
            _registry[name] = server


def registry() -> list[Server]:
    if not _registry:
        _build_registry()
    with _lock:
        return list(_registry.values())


def get(name: str) -> Server | None:
    if not _registry:
        _build_registry()
    with _lock:
        return _registry.get(name)


def refresh_config() -> None:
    _build_registry()


def _headers(server: Server) -> dict[str, str]:
    headers = {"Accept": "application/json"}
    if server.token:
        headers["X-Hoza-Token"] = server.token
    return headers


def check(server: Server) -> Server:
    """Poll one server and record what actually came back."""
    if server.is_local:
        server.status = ONLINE
        server.latency_ms = 0.0
        server.last_check = time.time()
        server.error = None
        server.failures = 0
        server.metrics = local_metrics()
        return server

    if not server.url:
        # A built-in entry nobody has given an address to. Not offline: there is
        # simply nothing to ask.
        server.status = UNKNOWN
        server.latency_ms = None
        server.last_check = time.time()
        server.error = None
        server.failures = 0
        return server

    timeout = config.load()["network"]["request_timeout"]
    started = time.perf_counter()
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            response = client.get(f"{server.url}/api/health", headers=_headers(server))
        elapsed = (time.perf_counter() - started) * 1000
        server.latency_ms = elapsed
        server.last_check = time.time()
        if response.status_code != 200:
            raise ServerError(f"HTTP {response.status_code}")
        payload = response.json()
        server.metrics = payload.get("metrics") or {}
        server.error = None
        server.failures = 0
        server.unhealthy_until = 0.0
        degraded = elapsed > SLOW_MS or payload.get("status") == DEGRADED
        server.status = DEGRADED if degraded else ONLINE
    except Exception as exc:  # noqa: BLE001 - any transport failure means offline
        server.latency_ms = None
        server.last_check = time.time()
        server.error = redact(str(exc))[:200] or exc.__class__.__name__
        server.failures += 1
        server.status = OFFLINE
        if server.failures >= FAILURE_THRESHOLD:
            server.unhealthy_until = time.time() + COOLDOWN_SECONDS
            logs.warning(
                "network",
                f"{server.name} marked unhealthy after {server.failures} failures",
                detail=server.error,
            )
    return server


def check_all() -> list[dict]:
    if not _registry:
        _build_registry()
    with _lock:
        targets = list(_registry.values())
    return [check(server).to_dict() for server in targets]


def mark_unhealthy(name: str, reason: str) -> None:
    with _lock:
        server = _registry.get(name)
        if not server or server.is_local:
            return
        server.failures += 1
        server.status = OFFLINE
        server.error = redact(reason)[:200]
        server.unhealthy_until = time.time() + COOLDOWN_SECONDS


def route(preferred: str | None = None, *, exclude: set[str] | None = None) -> Server | None:
    """Choose a server for a new job.

    Prefers the named server when it is healthy, otherwise the first healthy
    remote worker, otherwise the local instance. Returns None only when the
    registry is empty, which cannot happen in normal operation.
    """
    if not _registry:
        _build_registry()
    exclude = exclude or set()
    cfg = config.load()
    with _lock:
        candidates = [s for s in _registry.values() if s.name not in exclude]

    if preferred and preferred not in exclude:
        chosen = next((s for s in candidates if s.name == preferred), None)
        # A server the monitor has not reached yet is unknown, not unhealthy.
        # Poll it now rather than silently sending the job somewhere else.
        if chosen and not chosen.is_local and chosen.status == UNKNOWN:
            check(chosen)
        if chosen and chosen.healthy:
            return chosen
        if chosen and not cfg["network"]["failover_enabled"]:
            return chosen
        if chosen:
            logs.info("network", f"{preferred} is unhealthy, routing elsewhere")

    if not cfg["network"]["failover_enabled"] or not cfg["advanced"]["allow_remote_dispatch"]:
        return next((s for s in candidates if s.is_local), None)

    remote = [s for s in candidates if not s.is_local and s.healthy and "worker" in s.role]
    if remote:
        # Least loaded first, falling back to lowest latency.
        remote.sort(key=lambda s: (
            s.metrics.get("active_jobs") if s.metrics.get("active_jobs") is not None else 0,
            s.latency_ms if s.latency_ms is not None else 9999,
        ))
        return remote[0]
    return next((s for s in candidates if s.is_local), None)


# --------------------------------------------------------------------------- #
# Remote job dispatch
# --------------------------------------------------------------------------- #

def _as_request(selection: dict) -> dict:
    """Convert a resolved selection into the request shape the API accepts.

    A resolved selection carries whole stream objects. The remote validates its
    own request body against a fresh analysis, so it needs the identifiers.
    """
    video = selection.get("video") or {}
    audio = selection.get("audio") or {}
    return {
        "kind": selection.get("kind", "video"),
        # The remote re-resolves against its own analysis, so ask for the exact
        # streams rather than replaying a preset that could resolve differently.
        "preset": "custom",
        "video_format_id": video.get("format_id"),
        "audio_format_id": audio.get("format_id"),
        "height": video.get("height"),
    }


def _filename_from(disposition: str) -> str:
    """Read a filename out of a Content-Disposition header.

    Handles both the plain `filename="x"` form and the RFC 5987
    `filename*=utf-8''x` form that servers use for non-ASCII names.
    """
    if not disposition:
        return "download"
    encoded = re.search(r"filename\*\s*=\s*([^;]+)", disposition, re.I)
    if encoded:
        value = encoded.group(1).strip().strip('"')
        parts = value.split("'", 2)
        raw = parts[2] if len(parts) == 3 else value
        charset = parts[0] or "utf-8" if len(parts) == 3 else "utf-8"
        try:
            return unquote(raw, encoding=charset or "utf-8") or "download"
        except (LookupError, ValueError):
            return unquote(raw) or "download"
    plain = re.search(r"filename\s*=\s*(\"([^\"]*)\"|[^;]+)", disposition, re.I)
    if plain:
        return (plain.group(2) or plain.group(1)).strip().strip('"') or "download"
    return "download"


def dispatch(server: Server, url: str, selection: dict) -> str:
    """Create the job on a remote instance and return its identifier."""
    timeout = config.load()["network"]["request_timeout"]
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{server.url}/api/jobs",
                json={"url": url, "selection": _as_request(selection), "local_only": True},
                headers=_headers(server),
            )
    except httpx.HTTPError as exc:
        raise ServerError(redact(str(exc))[:200]) from exc
    if response.status_code >= 400:
        detail = response.text[:200]
        try:
            detail = response.json().get("error") or detail
        except ValueError:
            pass
        # A 4xx means this request was unacceptable, not that the server is ill.
        raise ServerError(
            f"HTTP {response.status_code}: {detail}",
            transport=response.status_code >= 500,
        )
    return response.json()["id"]


def follow(server: Server, remote_id: str, *, interval: float = 1.0) -> Iterator[dict]:
    """Yield progress updates from a remote job until it reaches a final state."""
    timeout = config.load()["network"]["request_timeout"]
    deadline = time.time() + config.load()["downloads"]["timeout_seconds"] * 4
    with httpx.Client(timeout=timeout) as client:
        while time.time() < deadline:
            try:
                response = client.get(
                    f"{server.url}/api/jobs/{remote_id}", headers=_headers(server)
                )
            except httpx.HTTPError as exc:
                raise ServerError(redact(str(exc))[:200]) from exc
            if response.status_code == 404:
                raise ServerError("The remote job disappeared.", transport=False)
            payload = response.json()
            yield {
                "status": payload.get("status"),
                "progress": payload.get("progress", 0),
                "downloaded_bytes": payload.get("downloaded", 0),
                "total_bytes": payload.get("total", 0),
                "speed": payload.get("speed"),
                "eta": payload.get("eta"),
            }
            status = payload.get("status")
            if status == "completed":
                return
            if status in ("failed", "cancelled"):
                raise ServerError(
                    payload.get("error") or f"Remote job {status}.", transport=False
                )
            time.sleep(interval)
    raise ServerError("The remote job did not finish before the timeout.")


def fetch_file(server: Server, remote_id: str, destination: Path) -> Path:
    """Stream a finished remote file into the local download folder."""
    timeout = config.load()["network"]["request_timeout"]
    from .filenames import sanitize_component, unique_path

    try:
        with httpx.Client(timeout=None) as client:
            with client.stream(
                "GET",
                f"{server.url}/api/jobs/{remote_id}/file",
                headers=_headers(server),
                timeout=httpx.Timeout(timeout, read=None),
            ) as response:
                if response.status_code >= 400:
                    raise ServerError(f"HTTP {response.status_code} fetching the file.")
                name = _filename_from(response.headers.get("content-disposition", ""))
                target = unique_path(destination / sanitize_component(name))
                temp = target.with_suffix(target.suffix + ".part")
                with open(temp, "wb") as handle:
                    for chunk in response.iter_bytes(chunk_size=1024 * 256):
                        handle.write(chunk)
                temp.replace(target)
                return target
    except httpx.HTTPError as exc:
        raise ServerError(redact(str(exc))[:200]) from exc


def cancel_remote(server: Server, remote_id: str) -> None:
    try:
        with httpx.Client(timeout=10) as client:
            client.post(
                f"{server.url}/api/jobs/{remote_id}/cancel", headers=_headers(server)
            )
    except httpx.HTTPError:
        pass


# --------------------------------------------------------------------------- #
# Background monitor
# --------------------------------------------------------------------------- #

def _monitor_loop() -> None:
    while not _stop.is_set():
        interval = config.load()["network"]["health_interval"]
        try:
            _build_registry()
            with _lock:
                targets = [s for s in _registry.values() if not s.is_local]
            for server in targets:
                if _stop.is_set():
                    break
                check(server)
        except Exception as exc:  # noqa: BLE001
            logs.error("network", f"Health monitor error: {redact(str(exc))}")
        _stop.wait(interval)


def start_monitor() -> None:
    global _monitor
    if _monitor and _monitor.is_alive():
        return
    _build_registry()
    _stop.clear()
    _monitor = threading.Thread(target=_monitor_loop, daemon=True, name="health-monitor")
    _monitor.start()


def stop_monitor() -> None:
    _stop.set()
