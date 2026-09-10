"""SQLite persistence for jobs, history and logs.

A local single-user downloader does not need a database server, so this uses
the standard library's sqlite3 with WAL journalling. Connections are per thread
because the download workers run outside the event loop.

Every statement below uses bound parameters. No SQL is ever built by string
concatenation from request data; the only interpolated fragments are column
names chosen from fixed allowlists.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any, Iterable

from . import paths

_local = threading.local()
_init_lock = threading.Lock()
_initialised = False

SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id              TEXT PRIMARY KEY,
    url             TEXT NOT NULL,
    kind            TEXT NOT NULL,
    status          TEXT NOT NULL,
    title           TEXT,
    thumbnail       TEXT,
    uploader        TEXT,
    duration        REAL,
    selection       TEXT NOT NULL,
    format_selector TEXT,
    actual_format   TEXT,
    quality_label   TEXT,
    progress        REAL DEFAULT 0,
    downloaded      INTEGER DEFAULT 0,
    total           INTEGER DEFAULT 0,
    speed           REAL,
    eta             INTEGER,
    filepath        TEXT,
    filename        TEXT,
    filesize        INTEGER,
    server          TEXT,
    remote_id       TEXT,
    error_code      TEXT,
    error           TEXT,
    error_hint      TEXT,
    attempts        INTEGER DEFAULT 0,
    priority        INTEGER DEFAULT 0,
    created_at      REAL NOT NULL,
    started_at      REAL,
    finished_at     REAL,
    processing_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS history (
    id           TEXT PRIMARY KEY,
    job_id       TEXT,
    url          TEXT NOT NULL,
    kind         TEXT NOT NULL,
    title        TEXT,
    thumbnail    TEXT,
    uploader     TEXT,
    quality      TEXT,
    format       TEXT,
    container    TEXT,
    filepath     TEXT,
    filename     TEXT,
    filesize     INTEGER,
    status       TEXT NOT NULL,
    error        TEXT,
    created_at   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_created ON history(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_history_status  ON history(status);
CREATE INDEX IF NOT EXISTS idx_history_kind    ON history(kind);

CREATE TABLE IF NOT EXISTS logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL NOT NULL,
    level      TEXT NOT NULL,
    category   TEXT NOT NULL,
    message    TEXT NOT NULL,
    job_id     TEXT,
    detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts       ON logs(ts DESC);
CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);
CREATE INDEX IF NOT EXISTS idx_logs_level    ON logs(level);

CREATE TABLE IF NOT EXISTS analysis_cache (
    url        TEXT PRIMARY KEY,
    payload    TEXT NOT NULL,
    created_at REAL NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    """Return this thread's connection, creating the schema on first use."""
    global _initialised
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    paths.ensure_dirs()
    conn = sqlite3.connect(str(paths.DB_PATH), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    with _init_lock:
        if not _initialised:
            conn.executescript(SCHEMA)
            conn.commit()
            _initialised = True
    _local.conn = conn
    return conn


def close() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    out = dict(row)
    if out.get("selection"):
        try:
            out["selection"] = json.loads(out["selection"])
        except (TypeError, json.JSONDecodeError):
            out["selection"] = {}
    return out


# --------------------------------------------------------------------------- #
# Jobs
# --------------------------------------------------------------------------- #

JOB_COLUMNS = (
    "id", "url", "kind", "status", "title", "thumbnail", "uploader", "duration",
    "selection", "format_selector", "actual_format", "quality_label", "progress",
    "downloaded", "total", "speed", "eta", "filepath", "filename", "filesize",
    "server", "remote_id", "error_code", "error", "error_hint", "attempts",
    "priority", "created_at", "started_at", "finished_at", "processing_ms",
)


def insert_job(job: dict[str, Any]) -> None:
    record = {key: job.get(key) for key in JOB_COLUMNS}
    record["selection"] = json.dumps(job.get("selection") or {})
    placeholders = ", ".join(f":{c}" for c in JOB_COLUMNS)
    columns = ", ".join(JOB_COLUMNS)
    conn = connect()
    conn.execute(f"INSERT INTO jobs ({columns}) VALUES ({placeholders})", record)
    conn.commit()


def update_job(job_id: str, **fields: Any) -> None:
    if not fields:
        return
    allowed = {k: v for k, v in fields.items() if k in JOB_COLUMNS and k != "id"}
    if not allowed:
        return
    if "selection" in allowed and not isinstance(allowed["selection"], str):
        allowed["selection"] = json.dumps(allowed["selection"])
    assignments = ", ".join(f"{key} = :{key}" for key in allowed)
    allowed["_id"] = job_id
    conn = connect()
    conn.execute(f"UPDATE jobs SET {assignments} WHERE id = :_id", allowed)
    conn.commit()


def get_job(job_id: str) -> dict[str, Any] | None:
    conn = connect()
    row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    return row_to_dict(row)


def list_jobs(statuses: Iterable[str] | None = None, limit: int = 200) -> list[dict]:
    conn = connect()
    if statuses:
        statuses = list(statuses)
        marks = ", ".join("?" for _ in statuses)
        sql = (
            f"SELECT * FROM jobs WHERE status IN ({marks}) "
            "ORDER BY created_at DESC LIMIT ?"
        )
        rows = conn.execute(sql, (*statuses, limit)).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [row_to_dict(r) for r in rows]


def delete_job(job_id: str) -> None:
    conn = connect()
    conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    conn.commit()


def clear_finished_jobs() -> int:
    conn = connect()
    cur = conn.execute(
        "DELETE FROM jobs WHERE status IN ('completed', 'failed', 'cancelled')"
    )
    conn.commit()
    return cur.rowcount


def resettable_jobs() -> list[dict]:
    """Jobs left mid-flight by a crash or restart."""
    return list_jobs(["queued", "analyzing", "downloading", "processing", "finalizing"])


# --------------------------------------------------------------------------- #
# History
# --------------------------------------------------------------------------- #

HISTORY_COLUMNS = (
    "id", "job_id", "url", "kind", "title", "thumbnail", "uploader", "quality",
    "format", "container", "filepath", "filename", "filesize", "status", "error",
    "created_at",
)

HISTORY_SORTS = {
    "newest": "created_at DESC",
    "oldest": "created_at ASC",
    "largest": "filesize DESC",
    "smallest": "filesize ASC",
    "name": "title COLLATE NOCASE ASC",
}


def add_history(entry: dict[str, Any]) -> None:
    record = {key: entry.get(key) for key in HISTORY_COLUMNS}
    placeholders = ", ".join(f":{c}" for c in HISTORY_COLUMNS)
    columns = ", ".join(HISTORY_COLUMNS)
    conn = connect()
    conn.execute(
        f"INSERT OR REPLACE INTO history ({columns}) VALUES ({placeholders})", record
    )
    conn.commit()


def list_history(
    *,
    kind: str | None = None,
    status: str | None = None,
    search: str | None = None,
    sort: str = "newest",
    limit: int = 100,
    offset: int = 0,
) -> tuple[list[dict], int]:
    where: list[str] = []
    params: list[Any] = []
    if kind in ("video", "audio"):
        where.append("kind = ?")
        params.append(kind)
    if status in ("completed", "failed", "cancelled"):
        where.append("status = ?")
        params.append(status)
    if search:
        where.append("(title LIKE ? OR filename LIKE ?)")
        needle = f"%{search}%"
        params.extend([needle, needle])
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    order = HISTORY_SORTS.get(sort, HISTORY_SORTS["newest"])

    conn = connect()
    total = conn.execute(f"SELECT COUNT(*) FROM history {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM history {clause} ORDER BY {order} LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    return [dict(r) for r in rows], total


def delete_history(entry_id: str) -> None:
    conn = connect()
    conn.execute("DELETE FROM history WHERE id = ?", (entry_id,))
    conn.commit()


def clear_history() -> int:
    conn = connect()
    cur = conn.execute("DELETE FROM history")
    conn.commit()
    return cur.rowcount


def history_stats() -> dict[str, Any]:
    conn = connect()
    row = conn.execute(
        "SELECT COUNT(*) AS total, "
        "COALESCE(SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END), 0) AS completed, "
        "COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) AS failed, "
        "COALESCE(SUM(filesize), 0) AS bytes FROM history"
    ).fetchone()
    return dict(row)


# --------------------------------------------------------------------------- #
# Logs
# --------------------------------------------------------------------------- #

LOG_CATEGORIES = ("extension", "api", "worker", "download", "ffmpeg", "network", "error", "system")
LOG_LEVELS = ("debug", "info", "warning", "error")


def add_log(
    level: str, category: str, message: str, *, job_id: str | None = None,
    detail: str | None = None,
) -> None:
    conn = connect()
    conn.execute(
        "INSERT INTO logs (ts, level, category, message, job_id, detail) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (time.time(), level, category, message, job_id, detail),
    )
    conn.commit()


def list_logs(
    *,
    category: str | None = None,
    level: str | None = None,
    search: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> tuple[list[dict], int]:
    where: list[str] = []
    params: list[Any] = []
    if category in LOG_CATEGORIES:
        where.append("category = ?")
        params.append(category)
    if level in LOG_LEVELS:
        where.append("level = ?")
        params.append(level)
    if search:
        where.append("(message LIKE ? OR detail LIKE ?)")
        needle = f"%{search}%"
        params.extend([needle, needle])
    clause = f"WHERE {' AND '.join(where)}" if where else ""
    conn = connect()
    total = conn.execute(f"SELECT COUNT(*) FROM logs {clause}", params).fetchone()[0]
    rows = conn.execute(
        f"SELECT * FROM logs {clause} ORDER BY ts DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    return [dict(r) for r in rows], total


def clear_logs() -> int:
    conn = connect()
    cur = conn.execute("DELETE FROM logs")
    conn.commit()
    return cur.rowcount


def trim_logs(keep: int) -> int:
    """Keep only the newest `keep` records."""
    conn = connect()
    cur = conn.execute(
        "DELETE FROM logs WHERE id NOT IN "
        "(SELECT id FROM logs ORDER BY ts DESC LIMIT ?)",
        (keep,),
    )
    conn.commit()
    return cur.rowcount


# --------------------------------------------------------------------------- #
# Analysis cache
# --------------------------------------------------------------------------- #

def cache_get(url: str, max_age: float = 900) -> dict | None:
    conn = connect()
    row = conn.execute(
        "SELECT payload, created_at FROM analysis_cache WHERE url = ?", (url,)
    ).fetchone()
    if row is None or time.time() - row["created_at"] > max_age:
        return None
    try:
        return json.loads(row["payload"])
    except json.JSONDecodeError:
        return None


def cache_put(url: str, payload: dict) -> None:
    conn = connect()
    conn.execute(
        "INSERT OR REPLACE INTO analysis_cache (url, payload, created_at) VALUES (?, ?, ?)",
        (url, json.dumps(payload), time.time()),
    )
    conn.commit()


def cache_clear() -> int:
    conn = connect()
    cur = conn.execute("DELETE FROM analysis_cache")
    conn.commit()
    return cur.rowcount
