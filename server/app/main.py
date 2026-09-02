"""HTTP API and static hosting for the Hoza YT dashboard.

Route layout follows the project's existing convention of a flat `/api/...`
surface returning JSON. Job progress is delivered over server-sent events, so
the dashboard does not poll while downloads run.
"""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse

from . import (
    APP_NAME, DEVELOPER, DEVELOPER_EMAIL, __version__,
    analyzer, config, db, diagnostics, downloader, extension, ffmpeg as ffmpeg_mod,
    formats, jobs as jobs_mod, logs, paths, servers, updates,
)
from .analyzer import AnalysisError
from .formats import SelectionError
from .models import (
    AnalyzeRequest, ExtensionPing, HandoffRequest, JobRequest, ServerEntry,
    SettingsUpdate,
)
from .security import ValidationError, contain, validate_server_url

MAX_BODY_BYTES = 256 * 1024
START_TIME = time.time()

_CREATE_NO_WINDOW = 0x08000000 if sys.platform.startswith("win") else 0


# --------------------------------------------------------------------------- #
# Lifespan
# --------------------------------------------------------------------------- #

@asynccontextmanager
async def lifespan(app: FastAPI):
    paths.ensure_dirs()
    db.connect()
    config.load()
    ffmpeg_mod.warm()
    jobs_mod.queue.bind_loop(asyncio.get_running_loop())
    recovered = jobs_mod.queue.recover()
    servers.start_monitor()
    cleaned = 0
    if config.load()["storage"]["cleanup_temp"]:
        cleaned = downloader.cleanup_partials(
            older_than_hours=config.load()["storage"]["cleanup_age_hours"]
        )
    logs.info(
        "system",
        f"{APP_NAME} {__version__} started",
        detail=f"recovered {recovered} job(s), removed {cleaned} stale temporary file(s)",
    )
    cleanup_task = asyncio.create_task(_periodic_cleanup())
    try:
        yield
    finally:
        cleanup_task.cancel()
        servers.stop_monitor()
        jobs_mod.queue.shutdown()
        logs.info("system", "Server stopping")


async def _periodic_cleanup() -> None:
    """Hourly removal of abandoned temporary files."""
    while True:
        try:
            await asyncio.sleep(3600)
            cfg = config.load()["storage"]
            if cfg["cleanup_temp"]:
                removed = downloader.cleanup_partials(older_than_hours=cfg["cleanup_age_hours"])
                if removed:
                    logs.info("system", f"Scheduled cleanup removed {removed} temporary file(s)")
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logs.error("system", f"Cleanup task error: {exc}")


app = FastAPI(
    title=f"{APP_NAME} API",
    version=__version__,
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url=None,
)

# The dashboard is same-origin. These entries let the browser extension and a
# second instance on the LAN talk to this API without opening it to any website.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|moz-extension://.*|http://(localhost|127\.0\.0\.1)(:\d+)?)$",
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "X-Hoza-Token"],
)


# --------------------------------------------------------------------------- #
# Middleware: body size ceiling and rate limiting
# --------------------------------------------------------------------------- #

_hits: dict[str, deque] = defaultdict(deque)


@app.middleware("http")
async def guard(request: Request, call_next):
    length = request.headers.get("content-length")
    if length and length.isdigit() and int(length) > MAX_BODY_BYTES:
        return JSONResponse(
            {"error": "That request is too large.", "code": "payload_too_large"},
            status_code=413,
        )

    if request.url.path.startswith("/api/") and request.url.path != "/api/events":
        limit = config.load()["network"]["rate_limit_per_minute"]
        client = request.client.host if request.client else "unknown"
        now = time.time()
        bucket = _hits[client]
        while bucket and now - bucket[0] > 60:
            bucket.popleft()
        if len(bucket) >= limit:
            return JSONResponse(
                {
                    "error": "Too many requests. Slow down for a moment.",
                    "code": "rate_limited",
                    "retryable": True,
                },
                status_code=429,
            )
        bucket.append(now)

    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001
        logs.error("api", f"Unhandled error on {request.url.path}: {exc}")
        return JSONResponse(
            {
                "error": "Something went wrong handling that request.",
                "code": "internal_error",
                "hint": "The Logs page has the details.",
                "retryable": True,
            },
            status_code=500,
        )


def fail(status: int, message: str, code: str = "error", hint: str | None = None,
         retryable: bool = False) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={"error": message, "code": code, "hint": hint, "retryable": retryable},
    )


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    detail = exc.detail
    if isinstance(detail, dict):
        return JSONResponse(detail, status_code=exc.status_code)
    return JSONResponse({"error": str(detail), "code": "error"}, status_code=exc.status_code)


# --------------------------------------------------------------------------- #
# Static dashboard
# --------------------------------------------------------------------------- #

@app.get("/", include_in_schema=False)
async def index():
    target = paths.STATIC_DIR / "index.html"
    if not target.exists():
        return PlainTextResponse("Dashboard files are missing from server/static.", 500)
    return FileResponse(target, media_type="text/html")


@app.get("/static/{filename:path}", include_in_schema=False)
async def static_file(filename: str):
    try:
        target = contain(paths.STATIC_DIR / filename, paths.STATIC_DIR)
    except ValidationError:
        raise fail(404, "Not found.")
    if not target.is_file():
        raise fail(404, "Not found.")
    return FileResponse(target)


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    icon = paths.SERVER_DIR.parent / "icons" / "icon-48.png"
    if icon.exists():
        return FileResponse(icon)
    raise fail(404, "Not found.")


# --------------------------------------------------------------------------- #
# Health and about
# --------------------------------------------------------------------------- #

@app.get("/api/health")
async def health():
    stats = jobs_mod.queue.stats()
    info = ffmpeg_mod.probe()
    degraded = not info.available
    return {
        "status": "degraded" if degraded else "online",
        "app": APP_NAME,
        "version": __version__,
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "queue": stats,
        "ffmpeg": info.available,
        "metrics": servers.local_metrics(),
    }


@app.get("/api/updates")
async def updates_check(refresh: bool = Query(False)):
    """Whether GitHub has a newer release than the one running.

    The answer is cached for a day, so the dashboard may poll this freely.
    `refresh=true` goes and looks again.
    """
    return await asyncio.to_thread(updates.check, refresh)


@app.get("/api/about")
async def about():
    import yt_dlp

    info = ffmpeg_mod.probe()
    return {
        "app": APP_NAME,
        "description": "A local media downloading and processing application.",
        "version": __version__,
        "developer": DEVELOPER,
        "contact": DEVELOPER_EMAIL,
        "python": sys.version.split()[0],
        "platform": sys.platform,
        "yt_dlp": yt_dlp.version.__version__,
        "ffmpeg": info.version,
        "ffmpeg_source": info.source,
        "database": str(paths.DB_PATH),
        "uptime_seconds": round(time.time() - START_TIME, 1),
        "license": "For personal use with media you are authorised to download.",
    }


# --------------------------------------------------------------------------- #
# Analysis
# --------------------------------------------------------------------------- #

@app.post("/api/analyze")
async def analyze(payload: AnalyzeRequest):
    try:
        result = await asyncio.to_thread(
            analyzer.analyze, payload.url, use_cache=not payload.refresh
        )
    except AnalysisError as exc:
        logs.warning("api", f"Analysis failed: {exc.message}")
        raise fail(422, exc.message, exc.code, exc.hint, exc.retryable)

    cfg = config.load()
    result["presets"] = formats.preset_options(
        result, prefer_hdr=cfg["video"]["prefer_hdr"]
    )
    result["audio_tiers"] = formats.audio_options(result)
    result["capabilities"] = ffmpeg_mod.probe().to_dict()
    result["heights"] = formats.available_heights(result)
    return result


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #

def _apply_overrides(payload: JobRequest) -> None:
    """Apply per-download overrides to the saved settings."""
    update: dict[str, dict[str, Any]] = {}
    if payload.audio_format or payload.audio_bitrate:
        update["audio"] = {}
        if payload.audio_format:
            update["audio"]["format"] = payload.audio_format
        if payload.audio_bitrate:
            update["audio"]["bitrate"] = payload.audio_bitrate
    if payload.subtitle_mode:
        update["subtitles"] = {"mode": payload.subtitle_mode}
    if update:
        config.save(update)


@app.post("/api/jobs")
async def create_job(payload: JobRequest):
    try:
        analysis = await asyncio.to_thread(analyzer.analyze, payload.url, use_cache=True)
    except AnalysisError as exc:
        raise fail(422, exc.message, exc.code, exc.hint, exc.retryable)

    selection_input = payload.selection
    if hasattr(selection_input, "model_dump"):
        selection_input = selection_input.model_dump()

    try:
        selection = formats.build_selection(analysis, selection_input)
    except SelectionError as exc:
        raise fail(422, str(exc), "selection_invalid",
                   "Analyse the link again to refresh the format list.", True)

    try:
        _apply_overrides(payload)
    except config.ConfigError as exc:
        raise fail(400, str(exc), "settings_invalid")

    if selection_input.get("container"):
        try:
            config.save({"video": {"container": selection_input["container"]}})
        except config.ConfigError as exc:
            raise fail(400, str(exc), "settings_invalid")

    ok, reason = downloader.disk_guard()
    if not ok:
        raise fail(507, "Storage unavailable.", "storage_full", reason)

    server = "local" if payload.local_only else payload.server
    job = jobs_mod.queue.create(
        url=analysis["webpage_url"],
        selection=selection,
        analysis=analysis,
        priority=payload.priority,
        server=server,
    )
    return job


@app.get("/api/jobs")
async def list_jobs(
    status: str | None = Query(default=None, max_length=32),
    limit: int = Query(default=100, ge=1, le=500),
):
    statuses = [s.strip() for s in status.split(",")] if status else None
    return {
        "jobs": jobs_mod.queue.list(statuses, limit),
        "stats": jobs_mod.queue.stats(),
    }


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = jobs_mod.queue.get(job_id)
    if not job:
        raise fail(404, "No job with that identifier.", "not_found")
    return job


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    if not jobs_mod.queue.cancel(job_id):
        raise fail(409, "That job has already finished.", "not_cancellable")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/pause")
async def pause_job(job_id: str):
    if not jobs_mod.queue.pause(job_id):
        raise fail(409, "That job cannot be paused right now.", "not_pausable")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/resume")
async def resume_job(job_id: str):
    if not jobs_mod.queue.resume(job_id):
        raise fail(409, "That job is not paused.", "not_resumable")
    return {"ok": True}


@app.post("/api/jobs/{job_id}/retry")
async def retry_job(job_id: str):
    if not jobs_mod.queue.retry(job_id):
        raise fail(409, "Only a finished job can be retried.", "not_retryable")
    return {"ok": True}


@app.delete("/api/jobs/{job_id}")
async def delete_job(job_id: str):
    """Remove the job record. The downloaded file is never deleted here."""
    if not jobs_mod.queue.remove(job_id):
        raise fail(404, "No job with that identifier.", "not_found")
    return {"ok": True, "note": "The record was removed. The file was left in place."}


@app.post("/api/jobs/clear")
async def clear_jobs():
    return {"ok": True, "removed": jobs_mod.queue.clear_finished()}


@app.post("/api/jobs/pause-all")
async def pause_all():
    return {"ok": True, "paused": jobs_mod.queue.pause_all()}


@app.post("/api/jobs/resume-all")
async def resume_all():
    return {"ok": True, "resumed": jobs_mod.queue.resume_all()}


@app.get("/api/jobs/{job_id}/file")
async def job_file(job_id: str):
    """Serve a finished file. Used by a coordinating instance to collect output."""
    job = jobs_mod.queue.get(job_id)
    if not job or job["status"] != jobs_mod.COMPLETED or not job.get("filepath"):
        raise fail(404, "No finished file for that job.", "not_found")
    try:
        target = contain(job["filepath"], config.download_dir(), config.temp_dir())
    except ValidationError:
        raise fail(403, "That file is outside the approved folders.", "forbidden")
    if not target.is_file():
        raise fail(404, "The file is no longer on disk.", "missing_file")
    return FileResponse(target, filename=target.name, media_type="application/octet-stream")


# --------------------------------------------------------------------------- #
# Live updates
# --------------------------------------------------------------------------- #

@app.get("/api/events")
async def events(request: Request):
    """Server-sent events carrying job and server changes."""

    async def stream():
        queue = jobs_mod.queue.subscribe()
        try:
            snapshot = {
                "event": "snapshot",
                "data": {
                    "jobs": jobs_mod.queue.list(limit=100),
                    "stats": jobs_mod.queue.stats(),
                },
            }
            yield f"data: {json.dumps(snapshot)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=20)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {json.dumps(message)}\n\n"
        finally:
            jobs_mod.queue.unsubscribe(queue)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"},
    )


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #

@app.get("/api/history")
async def history(
    kind: str | None = Query(default=None, max_length=16),
    status: str | None = Query(default=None, max_length=16),
    search: str | None = Query(default=None, max_length=200),
    sort: str = Query(default="newest", max_length=16),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    entries, total = db.list_history(
        kind=kind, status=status, search=search, sort=sort, limit=limit, offset=offset
    )
    for entry in entries:
        entry["exists"] = bool(entry.get("filepath") and Path(entry["filepath"]).is_file())
    return {"entries": entries, "total": total, "stats": db.history_stats()}


@app.delete("/api/history/{entry_id}")
async def delete_history(entry_id: str):
    db.delete_history(entry_id)
    return {"ok": True, "note": "The record was removed. The file was left in place."}


@app.post("/api/history/clear")
async def clear_history():
    return {"ok": True, "removed": db.clear_history()}


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

@app.get("/api/settings")
async def get_settings():
    return {"settings": config.load(), "schema": config.schema()}


@app.put("/api/settings")
async def put_settings(payload: SettingsUpdate):
    incoming = payload.model_dump()
    try:
        updated = config.save(incoming)
    except config.ConfigError as exc:
        raise fail(400, str(exc), "settings_invalid",
                   "Correct the highlighted value and save again.")
    jobs_mod.queue.resize()
    if "network" in incoming:
        servers.refresh_config()
    jobs_mod.queue.publish("settings:changed", {"settings": updated})
    logs.info("api", "Settings updated", detail=", ".join(sorted(incoming.keys())))
    return {"settings": updated, "schema": config.schema()}


@app.post("/api/settings/reset")
async def reset_settings():
    updated = config.reset()
    jobs_mod.queue.resize()
    servers.refresh_config()
    jobs_mod.queue.publish("settings:changed", {"settings": updated})
    logs.warning("api", "Settings reset to defaults")
    return {"settings": updated, "schema": config.schema()}


# --------------------------------------------------------------------------- #
# Servers
# --------------------------------------------------------------------------- #

@app.get("/api/servers")
async def list_servers():
    return {
        "servers": [s.to_dict() for s in servers.registry()],
        "failover_enabled": config.load()["network"]["failover_enabled"],
        "remote_dispatch": config.load()["advanced"]["allow_remote_dispatch"],
    }


@app.post("/api/servers/check")
async def check_servers():
    results = await asyncio.to_thread(servers.check_all)
    return {"servers": results}


@app.post("/api/servers")
async def add_server(entry: ServerEntry):
    try:
        url = validate_server_url(entry.url)
    except ValidationError as exc:
        raise fail(400, exc.message, "invalid_url", exc.hint)
    cfg = config.load()
    existing = cfg["network"]["servers"]
    if any(s.get("name") == entry.name for s in existing):
        raise fail(409, f"A server named {entry.name} already exists.", "duplicate")
    if entry.name == "local":
        raise fail(400, "The name 'local' is reserved for this machine.", "reserved_name")
    existing.append({"name": entry.name, "url": url, "role": entry.role, "token": entry.token})
    config.save({"network": {"servers": existing}})
    servers.refresh_config()
    logs.info("network", f"Added server {entry.name} at {url}")
    checked = await asyncio.to_thread(servers.check_all)
    return {"servers": checked}


@app.delete("/api/servers/{name}")
async def remove_server(name: str):
    if name == "local":
        raise fail(400, "This machine cannot be removed.", "reserved_name")
    cfg = config.load()
    remaining = [s for s in cfg["network"]["servers"] if s.get("name") != name]
    if len(remaining) == len(cfg["network"]["servers"]):
        raise fail(404, "No server with that name.", "not_found")
    config.save({"network": {"servers": remaining}})
    servers.refresh_config()
    logs.info("network", f"Removed server {name}")
    return {"servers": [s.to_dict() for s in servers.registry()]}


# --------------------------------------------------------------------------- #
# Diagnostics and logs
# --------------------------------------------------------------------------- #

@app.get("/api/diagnostics")
@app.post("/api/diagnostics/run")
async def run_diagnostics():
    return await asyncio.to_thread(diagnostics.run_all)


@app.get("/api/logs")
async def get_logs(
    category: str | None = Query(default=None, max_length=24),
    level: str | None = Query(default=None, max_length=16),
    search: str | None = Query(default=None, max_length=200),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    entries, total = db.list_logs(
        category=category, level=level, search=search, limit=limit, offset=offset
    )
    return {
        "entries": entries,
        "total": total,
        "categories": list(db.LOG_CATEGORIES),
        "levels": list(db.LOG_LEVELS),
    }


@app.delete("/api/logs")
async def clear_logs():
    return {"ok": True, "removed": db.clear_logs()}


@app.get("/api/logs/export")
async def export_logs(limit: int = Query(default=2000, ge=1, le=20000)):
    entries, _ = db.list_logs(limit=limit)
    text = logs.export_text(entries)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    return PlainTextResponse(
        text,
        headers={"Content-Disposition": f'attachment; filename="hoza-logs-{stamp}.txt"'},
    )


# --------------------------------------------------------------------------- #
# Extension bridge
# --------------------------------------------------------------------------- #

@app.post("/api/extension/ping")
async def extension_ping(payload: ExtensionPing):
    state = extension.ping(payload.version, payload.browser)
    return {"ok": True, "extension": state, "settings": config.load()}


@app.get("/api/extension/status")
async def extension_status():
    return extension.status()


@app.post("/api/extension/handoff")
async def extension_handoff(payload: HandoffRequest):
    extension.offer(payload.model_dump())
    jobs_mod.queue.publish("extension:handoff", payload.model_dump())
    logs.info("extension", f"Received a link from the extension: {payload.title or payload.url}")
    return {"ok": True}


@app.get("/api/extension/handoff")
async def take_handoff():
    return {"handoff": extension.take()}


# --------------------------------------------------------------------------- #
# System actions
# --------------------------------------------------------------------------- #

def _open_path(target: Path) -> None:
    if sys.platform.startswith("win"):
        os.startfile(str(target))  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(target)], shell=False)
    else:
        subprocess.Popen(["xdg-open", str(target)], shell=False)


@app.post("/api/system/open-folder")
async def open_folder(payload: dict | None = None):
    target = config.download_dir()
    if payload and payload.get("path"):
        try:
            candidate = contain(payload["path"], config.download_dir(), config.temp_dir())
            target = candidate if candidate.is_dir() else candidate.parent
        except ValidationError as exc:
            raise fail(403, exc.message, "forbidden")
    try:
        _open_path(target)
    except OSError as exc:
        raise fail(500, f"The folder could not be opened: {exc}", "open_failed")
    return {"ok": True, "path": str(target)}


@app.post("/api/system/reveal")
async def reveal(payload: dict):
    raw = (payload or {}).get("path")
    if not raw:
        raise fail(400, "No path was given.", "invalid_request")
    try:
        target = contain(raw, config.download_dir(), config.temp_dir())
    except ValidationError as exc:
        raise fail(403, exc.message, "forbidden")
    if not target.exists():
        raise fail(404, "That file is no longer on disk.", "missing_file")
    try:
        if sys.platform.startswith("win"):
            subprocess.Popen(
                ["explorer", "/select,", os.path.normpath(str(target))], shell=False
            )
        elif sys.platform == "darwin":
            subprocess.Popen(["open", "-R", str(target)], shell=False)
        else:
            _open_path(target.parent)
    except OSError as exc:
        raise fail(500, f"The file could not be revealed: {exc}", "reveal_failed")
    return {"ok": True}


@app.post("/api/system/open-file")
async def open_file(payload: dict):
    raw = (payload or {}).get("path")
    if not raw:
        raise fail(400, "No path was given.", "invalid_request")
    try:
        target = contain(raw, config.download_dir(), config.temp_dir())
    except ValidationError as exc:
        raise fail(403, exc.message, "forbidden")
    if not target.is_file():
        raise fail(404, "That file is no longer on disk.", "missing_file")
    try:
        _open_path(target)
    except OSError as exc:
        raise fail(500, f"The file could not be opened: {exc}", "open_failed")
    return {"ok": True}


@app.post("/api/system/pick-folder")
async def pick_folder():
    """Open the operating system's folder chooser in a helper process."""
    script = (
        "import sys,tkinter as tk\n"
        "from tkinter import filedialog\n"
        "root = tk.Tk(); root.withdraw(); root.attributes('-topmost', True)\n"
        "print(filedialog.askdirectory(initialdir=sys.argv[1], "
        "title='Choose a download folder') or '')\n"
    )
    try:
        result = await asyncio.to_thread(
            subprocess.run,
            [sys.executable, "-c", script, str(config.download_dir())],
            capture_output=True, text=True, timeout=300, shell=False,
            creationflags=_CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise fail(500, f"The folder chooser could not be opened: {exc}", "picker_failed",
                   "Type the path into the field instead.")
    chosen = (result.stdout or "").strip()
    return {"path": chosen or None}


@app.post("/api/maintenance/cleanup")
async def cleanup():
    removed = downloader.cleanup_partials()
    cached = db.cache_clear()
    logs.info("system", f"Manual cleanup removed {removed} temporary file(s)")
    return {"ok": True, "temp_files_removed": removed, "cache_entries_removed": cached}


@app.post("/api/maintenance/cache-clear")
async def clear_cache():
    return {"ok": True, "removed": db.cache_clear()}
