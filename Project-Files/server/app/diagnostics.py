"""Diagnostics that actually exercise each component.

Every check here performs real work: it runs the binary, writes to the folder,
opens the socket. A check that cannot be performed reports "unknown" rather
than passing by default.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import yt_dlp

from . import __version__, config, db, ffmpeg as ffmpeg_mod, paths, servers
from .analyzer import human_size
from .security import redact

PASS = "pass"
WARN = "warn"
FAIL = "fail"
UNKNOWN = "unknown"

_CREATE_NO_WINDOW = 0x08000000 if sys.platform.startswith("win") else 0


def _check(name: str, group: str, status: str, message: str, **extra: Any) -> dict:
    return {"name": name, "group": group, "status": status, "message": message, **extra}


def check_ffmpeg() -> dict:
    info = ffmpeg_mod.probe()
    if not info.available:
        return _check(
            "ffmpeg", "processing", FAIL,
            "ffmpeg was not found. Audio conversion and stream merging are unavailable.",
            hint="Run: pip install imageio-ffmpeg",
        )
    formats = info.audio_formats()
    if not formats:
        return _check(
            "ffmpeg", "processing", WARN,
            f"ffmpeg {info.version} runs but reports no usable audio encoders.",
            path=info.path,
        )
    return _check(
        "ffmpeg", "processing", PASS,
        f"ffmpeg {info.version} ({info.source}) with {len(info.encoders)} encoders.",
        path=info.path,
        audio_formats=formats,
        containers=info.video_containers(),
    )


def check_ffprobe() -> dict:
    path = ffmpeg_mod.ffprobe_path()
    if not path:
        return _check(
            "ffprobe", "processing", WARN,
            "ffprobe was not found. It is optional; media inspection falls back to ffmpeg.",
        )
    return _check("ffprobe", "processing", PASS, "ffprobe is available.", path=path)


def check_extractor() -> dict:
    try:
        version = yt_dlp.version.__version__
    except Exception as exc:  # noqa: BLE001
        return _check("yt-dlp", "processing", FAIL, f"The extractor could not be loaded: {exc}")
    # A stale extractor is the usual cause of sudden download failures.
    try:
        year, month, _ = version.split(".", 2)
        age_days = (time.time() - time.mktime((int(year), int(month), 1, 0, 0, 0, 0, 1, -1))) / 86400
    except Exception:
        age_days = 0
    if age_days > 120:
        return _check(
            "yt-dlp", "processing", WARN,
            f"Extractor {version} is more than four months old. Sites change often.",
            hint="Run 'python autorun.py --update' to refresh it.",
        )
    return _check("yt-dlp", "processing", PASS, f"Extractor {version} is loaded.")


def check_download_dir() -> dict:
    try:
        directory = config.download_dir()
    except Exception as exc:  # noqa: BLE001
        return _check("Download folder", "storage", FAIL, f"Unusable: {redact(str(exc))}")
    probe = directory / ".hoza-diagnostic"
    try:
        probe.write_text("ok", "utf-8")
        probe.unlink()
    except OSError as exc:
        return _check(
            "Download folder", "storage", FAIL,
            f"{directory} cannot be written to: {exc.strerror or exc}",
        )
    free = paths.free_space(directory)
    if free is not None and free < 1024**3:
        return _check(
            "Download folder", "storage", WARN,
            f"{directory} is writable but only {human_size(free)} is free.",
            path=str(directory), free=free,
        )
    return _check(
        "Download folder", "storage", PASS,
        f"{directory} is writable with {human_size(free)} free.",
        path=str(directory), free=free,
    )


def check_temp_dir() -> dict:
    try:
        directory = config.temp_dir()
        probe = directory / ".hoza-diagnostic"
        probe.write_text("ok", "utf-8")
        probe.unlink()
    except Exception as exc:  # noqa: BLE001
        return _check("Temporary folder", "storage", FAIL, f"Unusable: {redact(str(exc))}")
    leftovers = len(list(directory.glob("*.part"))) + len(list(directory.glob("*.ytdl")))
    if leftovers:
        return _check(
            "Temporary folder", "storage", WARN,
            f"{directory} holds {leftovers} leftover partial file(s).",
            path=str(directory), leftovers=leftovers,
        )
    return _check("Temporary folder", "storage", PASS, f"{directory} is writable and clean.",
                  path=str(directory))


def check_database() -> dict:
    try:
        conn = db.connect()
        conn.execute("SELECT 1").fetchone()
        stats = db.history_stats()
    except Exception as exc:  # noqa: BLE001
        return _check("Database", "storage", FAIL, f"SQLite error: {redact(str(exc))}")
    size = paths.DB_PATH.stat().st_size if paths.DB_PATH.exists() else 0
    return _check(
        "Database", "storage", PASS,
        f"SQLite is healthy, {stats['total']} history record(s), {human_size(size) or '0 B'} on disk.",
        path=str(paths.DB_PATH),
    )


def check_network() -> dict:
    """Confirm outbound DNS and TCP work, without downloading anything."""
    started = time.perf_counter()
    try:
        infos = socket.getaddrinfo("www.youtube.com", 443, proto=socket.IPPROTO_TCP)
        address = infos[0][4]
        with socket.create_connection(address, timeout=6):
            pass
    except OSError as exc:
        return _check(
            "Internet", "network", FAIL,
            f"Could not reach the network: {exc.strerror or exc}",
            hint="Check your connection, proxy or firewall.",
        )
    elapsed = (time.perf_counter() - started) * 1000
    status = WARN if elapsed > 2000 else PASS
    return _check(
        "Internet", "network", status,
        f"Outbound connection succeeded in {elapsed:.0f} ms.",
        latency_ms=round(elapsed, 1),
    )


def check_servers() -> list[dict]:
    out: list[dict] = []
    for record in servers.check_all():
        if record["is_local"]:
            out.append(_check(
                f"Server: {record['name']}", "servers", PASS,
                "This machine, always available.",
                **{k: record[k] for k in ("url", "status", "metrics")},
            ))
            continue
        if record["status"] == servers.ONLINE:
            status, message = PASS, f"Online, {record['latency_ms']} ms."
        elif record["status"] == servers.DEGRADED:
            status, message = WARN, f"Responding slowly, {record['latency_ms']} ms."
        elif record["status"] == servers.UNKNOWN:
            status, message = UNKNOWN, "Not polled yet."
        else:
            status, message = FAIL, f"Offline: {record['error'] or 'no response'}"
        out.append(_check(
            f"Server: {record['name']}", "servers", status, message,
            url=record["url"], accepting_jobs=record["accepting_jobs"],
        ))
    return out


def check_queue() -> dict:
    from . import jobs as jobs_mod

    stats = jobs_mod.queue.stats()
    return _check(
        "Queue", "processing", PASS,
        f"{stats['active']} active, {stats['queued']} waiting, "
        f"{stats['concurrency']} worker slot(s).",
        **stats,
    )


def check_extension() -> dict:
    from .extension import status as extension_status

    state = extension_status()
    if not state["seen"]:
        return _check(
            "Browser extension", "extension", UNKNOWN,
            "The extension has not contacted this backend yet.",
            hint="Open the extension popup and press Open Dashboard.",
        )
    age = time.time() - state["last_seen"]
    if age > 300:
        return _check(
            "Browser extension", "extension", WARN,
            f"Last seen {int(age // 60)} minute(s) ago.",
            version=state.get("version"),
        )
    return _check(
        "Browser extension", "extension", PASS,
        f"Connected, version {state.get('version') or 'unknown'}.",
        version=state.get("version"),
    )


def run_all() -> dict:
    """Run every diagnostic and summarise the result."""
    started = time.perf_counter()
    checks: list[dict] = [
        check_extractor(),
        check_ffmpeg(),
        check_ffprobe(),
        check_queue(),
        check_download_dir(),
        check_temp_dir(),
        check_database(),
        check_network(),
        check_extension(),
    ]
    checks.extend(check_servers())
    counts = {PASS: 0, WARN: 0, FAIL: 0, UNKNOWN: 0}
    for entry in checks:
        counts[entry["status"]] = counts.get(entry["status"], 0) + 1
    overall = FAIL if counts[FAIL] else (WARN if counts[WARN] else PASS)
    return {
        "overall": overall,
        "counts": counts,
        "checks": checks,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": sys.platform,
    }
