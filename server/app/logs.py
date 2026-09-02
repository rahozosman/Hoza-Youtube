"""Structured logging into the database.

Every message passes through `security.redact` first, so authorisation headers,
cookies and signed URL parameters never reach a stored record. Log text is also
stripped of newlines, which stops a crafted title from forging a second entry.
"""

from __future__ import annotations

import threading
import time

from . import db
from .security import redact

_trim_lock = threading.Lock()
_since_trim = 0


def log(
    level: str,
    category: str,
    message: str,
    *,
    job_id: str | None = None,
    detail: str | None = None,
) -> None:
    global _since_trim
    if level not in db.LOG_LEVELS:
        level = "info"
    if category not in db.LOG_CATEGORIES:
        category = "system"
    try:
        db.add_log(
            level,
            category,
            redact(message)[:1000],
            job_id=job_id,
            detail=redact(detail)[:4000] if detail else None,
        )
    except Exception:
        # Logging must never break the operation it is describing.
        return
    with _trim_lock:
        _since_trim += 1
        should_trim = _since_trim >= 200
        if should_trim:
            _since_trim = 0
    if should_trim:
        try:
            from . import config

            db.trim_logs(config.load()["advanced"]["log_retention"])
        except Exception:
            pass


def debug(category: str, message: str, **kw) -> None:
    from . import config

    if config.load()["advanced"]["detailed_logs"]:
        log("debug", category, message, **kw)


def info(category: str, message: str, **kw) -> None:
    log("info", category, message, **kw)


def warning(category: str, message: str, **kw) -> None:
    log("warning", category, message, **kw)


def error(category: str, message: str, **kw) -> None:
    log("error", category, message, **kw)


def export_text(rows: list[dict]) -> str:
    """Render log rows as a plain text file for download."""
    lines = []
    for row in reversed(rows):
        stamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(row["ts"]))
        line = f"{stamp}  {row['level'].upper():<7} {row['category']:<9} {row['message']}"
        if row.get("job_id"):
            line += f"  [job {row['job_id']}]"
        lines.append(line)
        if row.get("detail"):
            lines.append(f"    {row['detail']}")
    return "\n".join(lines) + "\n"
