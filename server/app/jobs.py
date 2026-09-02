"""Job queue and worker pool.

Downloads are blocking work, so each job runs on its own thread under a
semaphore that enforces the configured concurrency. State changes are written
to SQLite and published to any connected dashboard over server-sent events, so
the interface updates without polling.

A job that was mid-flight when the process stopped is recovered on the next
start rather than left claiming to be running.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from typing import Any

from . import config, db, downloader, logs, servers
from .analyzer import AnalysisError, human_size
from .downloader import CancelSignal, PauseSignal, Progress
from .security import ValidationError

# Lifecycle, in the order a job moves through it.
QUEUED = "queued"
ANALYZING = "analyzing"
DOWNLOADING = "downloading"
PROCESSING = "processing"
FINALIZING = "finalizing"
COMPLETED = "completed"
FAILED = "failed"
CANCELLED = "cancelled"
PAUSED = "paused"

ACTIVE = {QUEUED, ANALYZING, DOWNLOADING, PROCESSING, FINALIZING, PAUSED}
TERMINAL = {COMPLETED, FAILED, CANCELLED}


class JobQueue:
    """Owns every job's lifecycle."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._control: dict[str, str] = {}          # job id -> run | pause | cancel
        self._threads: dict[str, threading.Thread] = {}
        self._semaphore = threading.BoundedSemaphore(self._concurrency())
        self._semaphore_size = self._concurrency()
        self._subscribers: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._stopping = False

    # -- setup ------------------------------------------------------------- #

    @staticmethod
    def _concurrency() -> int:
        return config.load()["downloads"]["concurrent"]

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def resize(self) -> None:
        """Apply a changed concurrency setting to the semaphore."""
        with self._lock:
            wanted = self._concurrency()
            if wanted == self._semaphore_size:
                return
            self._semaphore = threading.BoundedSemaphore(wanted)
            self._semaphore_size = wanted
            logs.info("worker", f"Download concurrency set to {wanted}")

    def recover(self) -> int:
        """Mark jobs orphaned by a restart, so nothing claims to be running."""
        recovered = 0
        for job in db.resettable_jobs():
            db.update_job(
                job["id"],
                status=FAILED,
                error="Interrupted when the server stopped.",
                error_code="interrupted",
                error_hint="Use Retry to start it again.",
                finished_at=time.time(),
            )
            recovered += 1
        if recovered:
            logs.warning("worker", f"Recovered {recovered} interrupted job(s) after restart")
        return recovered

    # -- events ------------------------------------------------------------ #

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        loop = asyncio.get_running_loop()
        with self._lock:
            self._subscribers.append((loop, queue))
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        with self._lock:
            self._subscribers = [(l, q) for (l, q) in self._subscribers if q is not queue]

    def publish(self, event: str, payload: dict) -> None:
        """Push an event to every connected dashboard. Never blocks a worker."""
        message = {"event": event, "data": payload, "ts": time.time()}
        with self._lock:
            targets = list(self._subscribers)
        for loop, queue in targets:
            try:
                loop.call_soon_threadsafe(queue.put_nowait, message)
            except (RuntimeError, asyncio.QueueFull):
                continue

    # -- job creation ------------------------------------------------------ #

    def create(
        self,
        *,
        url: str,
        selection: dict,
        analysis: dict | None = None,
        priority: int = 0,
        server: str | None = None,
    ) -> dict:
        job_id = uuid.uuid4().hex[:12]
        now = time.time()
        video = selection.get("video") or {}
        audio = selection.get("audio") or {}
        expected = (video.get("filesize") or 0) + (audio.get("filesize") or 0)
        record = {
            "id": job_id,
            "url": url,
            "kind": selection["kind"],
            "status": QUEUED,
            "title": (analysis or {}).get("title"),
            "thumbnail": (analysis or {}).get("thumbnail"),
            "uploader": (analysis or {}).get("uploader"),
            "duration": (analysis or {}).get("duration"),
            "selection": selection,
            "format_selector": selection["selector"],
            "quality_label": selection.get("quality_label"),
            "progress": 0.0,
            "downloaded": 0,
            "total": expected,
            "attempts": 0,
            "priority": priority,
            "server": server or "local",
            "created_at": now,
        }
        db.insert_job(record)
        with self._lock:
            self._control[job_id] = "run"
        logs.info("download", f"Queued {record['title'] or url}", job_id=job_id,
                  detail=selection.get("summary"))
        self.publish("job:created", self.get(job_id))
        self._spawn(job_id)
        return self.get(job_id)

    def _spawn(self, job_id: str, *, resume: bool = False) -> None:
        thread = threading.Thread(
            target=self._run, args=(job_id, resume), daemon=True, name=f"job-{job_id}"
        )
        with self._lock:
            self._threads[job_id] = thread
        thread.start()

    # -- execution --------------------------------------------------------- #

    def _control_state(self, job_id: str) -> str:
        with self._lock:
            return self._control.get(job_id, "run")

    def _set_status(self, job_id: str, status: str, **fields: Any) -> None:
        db.update_job(job_id, status=status, **fields)
        job = self.get(job_id)
        if job:
            self.publish("job:updated", job)

    def _run(self, job_id: str, resume: bool) -> None:
        if self._control_state(job_id) == "cancel":
            self._finish_cancelled(job_id)
            return
        acquired = False
        try:
            # Wait for a worker slot, checking for cancellation while we wait.
            while not acquired:
                if self._control_state(job_id) == "cancel":
                    self._finish_cancelled(job_id)
                    return
                if self._stopping:
                    return
                acquired = self._semaphore.acquire(timeout=0.5)
            self._execute(job_id, resume)
        finally:
            if acquired:
                try:
                    self._semaphore.release()
                except ValueError:
                    pass
            with self._lock:
                self._threads.pop(job_id, None)

    def _execute(self, job_id: str, resume: bool) -> None:
        job = db.get_job(job_id)
        if not job or job["status"] in TERMINAL:
            return

        ok, reason = downloader.disk_guard()
        if not ok:
            self._fail(job_id, "storage_full", "Storage unavailable.", reason, retryable=False)
            return

        attempts = (job["attempts"] or 0) + 1
        started = time.time()
        self._set_status(job_id, ANALYZING, attempts=attempts, started_at=started,
                         error=None, error_code=None, error_hint=None)

        target = servers.route(job.get("server"))
        if target and not target.is_local:
            self._execute_remote(job_id, job, target)
            return

        last_publish = [0.0]

        def on_progress(progress: Progress) -> None:
            status = {
                "downloading": DOWNLOADING,
                "processing": PROCESSING,
                "completed": FINALIZING,
            }.get(progress.status, DOWNLOADING)
            fields: dict[str, Any] = {
                "progress": progress.percent,
                "downloaded": progress.downloaded,
                "speed": progress.speed,
                "eta": progress.eta,
            }
            if progress.total:
                fields["total"] = progress.total
            db.update_job(job_id, status=status, **fields)
            # Publish at most a few times a second to keep the stream light.
            now = time.perf_counter()
            if now - last_publish[0] > 0.4 or progress.status != "downloading":
                last_publish[0] = now
                record = self.get(job_id)
                if record:
                    record["detail"] = progress.detail
                    self.publish("job:progress", record)

        try:
            result = downloader.run(
                job["url"], job["selection"],
                on_progress=on_progress,
                control=lambda: self._control_state(job_id),
                resume=resume,
            )
        except PauseSignal:
            self._set_status(job_id, PAUSED, speed=None, eta=None)
            logs.info("download", "Paused", job_id=job_id)
            return
        except CancelSignal:
            self._finish_cancelled(job_id)
            return
        except (AnalysisError, ValidationError) as exc:
            code = getattr(exc, "code", "invalid_request")
            hint = getattr(exc, "hint", None)
            retryable = getattr(exc, "retryable", False)
            self._fail(job_id, code, getattr(exc, "message", str(exc)), hint, retryable=retryable)
            return
        except Exception as exc:  # noqa: BLE001
            self._fail(job_id, "unexpected", str(exc)[:300], None, retryable=True)
            return

        if config.load()["storage"]["cleanup_temp"]:
            downloader.cleanup_job_leftovers(result["filepath"])

        finished = time.time()
        self._set_status(
            job_id, COMPLETED,
            progress=100.0,
            filepath=result["filepath"],
            filename=result["filename"],
            filesize=result["filesize"],
            downloaded=result["filesize"],
            total=result["filesize"],
            actual_format=result["actual_format"],
            processing_ms=result["processing_ms"],
            finished_at=finished,
            speed=None,
            eta=None,
        )
        self._record_history(job_id)
        logs.info(
            "download",
            f"Completed {result['filename']}",
            job_id=job_id,
            detail=f"{human_size(result['filesize'])} in {finished - started:.1f}s",
        )

    def _execute_remote(self, job_id: str, job: dict, target: servers.Server) -> None:
        """Dispatch to a healthy remote instance and stream the result back."""
        try:
            remote_id = servers.dispatch(target, job["url"], job["selection"])
        except servers.ServerError as exc:
            logs.warning("network", f"Dispatch to {target.name} failed: {exc}", job_id=job_id)
            # Only a transport failure says anything about the server's health.
            if getattr(exc, "transport", True):
                servers.mark_unhealthy(target.name, str(exc))
            fallback = servers.route(None, exclude={target.name})
            if fallback and fallback.is_local:
                db.update_job(job_id, server="local")
                self._execute(job_id, resume=False)
                return
            self._fail(job_id, "server_unavailable",
                       f"{target.name} could not accept the job.", str(exc), retryable=True)
            return

        db.update_job(job_id, remote_id=remote_id, server=target.name)
        try:
            for update in servers.follow(target, remote_id):
                if self._control_state(job_id) == "cancel":
                    servers.cancel_remote(target, remote_id)
                    self._finish_cancelled(job_id)
                    return
                db.update_job(
                    job_id,
                    status=update.get("status", DOWNLOADING),
                    progress=update.get("progress", 0),
                    downloaded=update.get("downloaded_bytes", 0),
                    total=update.get("total_bytes", 0),
                    speed=update.get("speed"),
                    eta=update.get("eta"),
                )
                record = self.get(job_id)
                if record:
                    self.publish("job:progress", record)
            saved = servers.fetch_file(target, remote_id, config.download_dir())
        except servers.ServerError as exc:
            servers.mark_unhealthy(target.name, str(exc))
            self._fail(job_id, "server_error", f"{target.name} failed during the job.",
                       str(exc), retryable=True)
            return

        self._set_status(
            job_id, COMPLETED,
            progress=100.0,
            filepath=str(saved),
            filename=saved.name,
            filesize=saved.stat().st_size,
            downloaded=saved.stat().st_size,
            total=saved.stat().st_size,
            finished_at=time.time(),
        )
        self._record_history(job_id)

    # -- outcomes ---------------------------------------------------------- #

    def _fail(self, job_id: str, code: str, message: str, hint: str | None,
              *, retryable: bool) -> None:
        job = db.get_job(job_id)
        if not job:
            return
        cfg = config.load()["downloads"]
        attempts = job["attempts"] or 1
        if retryable and cfg["auto_retry"] and attempts <= cfg["retry_count"]:
            delay = config.load()["network"]["retry_delay"] * attempts
            self._set_status(job_id, QUEUED, error=message, error_code=code, error_hint=hint,
                             speed=None, eta=None)
            logs.warning(
                "download",
                f"Attempt {attempts} failed, retrying in {delay}s: {message}",
                job_id=job_id,
            )
            timer = threading.Timer(delay, lambda: self._spawn(job_id, resume=True))
            timer.daemon = True
            timer.start()
            return
        self._set_status(job_id, FAILED, error=message, error_code=code, error_hint=hint,
                         finished_at=time.time(), speed=None, eta=None)
        self._record_history(job_id)
        logs.error("download", f"Failed: {message}", job_id=job_id, detail=hint)

    def _finish_cancelled(self, job_id: str) -> None:
        self._set_status(job_id, CANCELLED, error="Cancelled", error_code="cancelled",
                         finished_at=time.time(), speed=None, eta=None)
        if config.load()["storage"]["cleanup_temp"]:
            downloader.cleanup_partials()
        logs.info("download", "Cancelled", job_id=job_id)

    def _record_history(self, job_id: str) -> None:
        job = db.get_job(job_id)
        if not job:
            return
        selection = job.get("selection") or {}
        video = selection.get("video") or {}
        db.add_history({
            "id": job_id,
            "job_id": job_id,
            "url": job["url"],
            "kind": job["kind"],
            "title": job.get("title"),
            "thumbnail": job.get("thumbnail"),
            "uploader": job.get("uploader"),
            "quality": job.get("quality_label"),
            "format": job.get("actual_format") or job.get("format_selector"),
            "container": (job.get("filename") or "").rsplit(".", 1)[-1] or video.get("ext"),
            "filepath": job.get("filepath"),
            "filename": job.get("filename"),
            "filesize": job.get("filesize"),
            "status": job["status"],
            "error": job.get("error"),
            "created_at": job.get("finished_at") or time.time(),
        })

    # -- controls ---------------------------------------------------------- #

    def get(self, job_id: str) -> dict | None:
        job = db.get_job(job_id)
        if job:
            job["is_active"] = job["status"] in ACTIVE
        return job

    def list(self, statuses: list[str] | None = None, limit: int = 200) -> list[dict]:
        return db.list_jobs(statuses, limit)

    def cancel(self, job_id: str) -> bool:
        job = db.get_job(job_id)
        if not job or job["status"] in TERMINAL:
            return False
        with self._lock:
            self._control[job_id] = "cancel"
        if job["status"] in (QUEUED, PAUSED):
            self._finish_cancelled(job_id)
        return True

    def pause(self, job_id: str) -> bool:
        job = db.get_job(job_id)
        if not job or job["status"] not in (DOWNLOADING, QUEUED, ANALYZING):
            return False
        with self._lock:
            self._control[job_id] = "pause"
        if job["status"] == QUEUED:
            self._set_status(job_id, PAUSED)
        return True

    def resume(self, job_id: str) -> bool:
        job = db.get_job(job_id)
        if not job or job["status"] != PAUSED:
            return False
        with self._lock:
            self._control[job_id] = "run"
        self._set_status(job_id, QUEUED)
        self._spawn(job_id, resume=True)
        return True

    def retry(self, job_id: str) -> bool:
        job = db.get_job(job_id)
        if not job or job["status"] not in TERMINAL:
            return False
        with self._lock:
            self._control[job_id] = "run"
        db.update_job(
            job_id, status=QUEUED, progress=0, downloaded=0, attempts=0,
            error=None, error_code=None, error_hint=None,
            finished_at=None, started_at=None, speed=None, eta=None,
        )
        self.publish("job:updated", self.get(job_id))
        logs.info("download", "Retry requested", job_id=job_id)
        self._spawn(job_id, resume=True)
        return True

    def remove(self, job_id: str) -> bool:
        """Remove the job record. The downloaded file is left untouched."""
        job = db.get_job(job_id)
        if not job:
            return False
        if job["status"] in ACTIVE:
            self.cancel(job_id)
        db.delete_job(job_id)
        self.publish("job:removed", {"id": job_id})
        return True

    def clear_finished(self) -> int:
        count = db.clear_finished_jobs()
        self.publish("jobs:cleared", {"removed": count})
        return count

    def pause_all(self) -> int:
        return sum(1 for job in db.list_jobs([DOWNLOADING, QUEUED]) if self.pause(job["id"]))

    def resume_all(self) -> int:
        return sum(1 for job in db.list_jobs([PAUSED]) if self.resume(job["id"]))

    def stats(self) -> dict:
        jobs = db.list_jobs(limit=500)
        counts: dict[str, int] = {}
        for job in jobs:
            counts[job["status"]] = counts.get(job["status"], 0) + 1
        active = sum(counts.get(s, 0) for s in (DOWNLOADING, PROCESSING, ANALYZING, FINALIZING))
        speed = sum(job.get("speed") or 0 for job in jobs if job["status"] == DOWNLOADING)
        return {
            "counts": counts,
            "active": active,
            "queued": counts.get(QUEUED, 0),
            "paused": counts.get(PAUSED, 0),
            "completed": counts.get(COMPLETED, 0),
            "failed": counts.get(FAILED, 0),
            "total_speed": speed,
            "total_speed_human": (human_size(speed) + "/s") if speed else None,
            "concurrency": self._concurrency(),
        }

    def shutdown(self) -> None:
        self._stopping = True
        with self._lock:
            for job_id in list(self._control):
                self._control[job_id] = "pause"


queue = JobQueue()
