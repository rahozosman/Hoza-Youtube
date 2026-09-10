"""Media analysis.

Turns the extractor's raw format list into the stream information the dashboard
shows. Nothing here invents a capability: every quality, codec, framerate and
subtitle track comes from the source, and any figure the source did not report
is marked as an estimate rather than presented as fact.
"""

from __future__ import annotations

import re
import time
from typing import Any

import yt_dlp

from . import db, logs
from .security import ValidationError, redact, validate_media_url

# Raw codec prefix -> the name shown in the interface.
VIDEO_CODEC_NAMES = [
    ("avc1", "AVC"), ("h264", "AVC"), ("hev1", "HEVC"), ("hvc1", "HEVC"),
    ("h265", "HEVC"), ("vp09", "VP9"), ("vp9", "VP9"), ("vp8", "VP8"),
    ("av01", "AV1"), ("theora", "Theora"),
]
AUDIO_CODEC_NAMES = [
    ("mp4a", "AAC"), ("aac", "AAC"), ("opus", "Opus"), ("mp3", "MP3"),
    ("vorbis", "Vorbis"), ("flac", "FLAC"), ("ec-3", "Dolby Digital+"),
    ("ac-3", "Dolby Digital"), ("alac", "ALAC"), ("dts", "DTS"),
]

# Codecs a typical player, editor or phone handles without extra work.
COMPATIBLE_VIDEO = {"AVC"}
COMPATIBLE_AUDIO = {"AAC", "MP3"}


class AnalysisError(Exception):
    """A failure worth showing the user, with a reason and a suggestion."""

    def __init__(self, message: str, *, code: str = "analysis_failed", hint: str | None = None,
                 retryable: bool = True):
        super().__init__(message)
        self.message = message
        self.code = code
        self.hint = hint
        self.retryable = retryable


def _friendly_codec(raw: str | None, table: list[tuple[str, str]]) -> str | None:
    if not raw or raw in ("none", "unknown"):
        return None
    lowered = raw.lower()
    for prefix, name in table:
        if lowered.startswith(prefix):
            return name
    return raw.split(".")[0]


def human_size(value: int | float | None) -> str | None:
    if not value:
        return None
    number = float(value)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if number < 1024 or unit == "TB":
            return f"{number:.1f} {unit}" if unit != "B" else f"{int(number)} B"
        number /= 1024
    return None


def _estimate_bytes(fmt: dict, duration: float | None) -> int | None:
    """Size from bitrate when the source did not report one."""
    rate = fmt.get("tbr") or fmt.get("vbr") or fmt.get("abr")
    if rate and duration:
        return int(float(rate) * 1000 / 8 * float(duration))
    return None


def _is_hdr(fmt: dict) -> bool:
    value = (fmt.get("dynamic_range") or "").upper()
    return bool(value) and value not in ("SDR", "NONE")


def _video_streams(formats: list[dict], duration: float | None) -> list[dict]:
    out: list[dict] = []
    for fmt in formats:
        vcodec = fmt.get("vcodec")
        if not vcodec or vcodec == "none":
            continue
        height = fmt.get("height")
        if not height:
            continue
        protocol = (fmt.get("protocol") or "").lower()
        # Storyboards and image playlists are not video the user can save.
        if fmt.get("ext") in ("mhtml", "3gp") and not fmt.get("tbr"):
            continue
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        estimated = size is None
        if estimated:
            size = _estimate_bytes(fmt, duration)
        codec = _friendly_codec(vcodec, VIDEO_CODEC_NAMES)
        fps = fmt.get("fps")
        muxed = bool(fmt.get("acodec") and fmt.get("acodec") != "none")
        hdr = _is_hdr(fmt)
        label = f"{height}p"
        if fps and fps > 30:
            label += str(int(round(fps)))
        out.append({
            "format_id": str(fmt.get("format_id")),
            "height": height,
            "width": fmt.get("width"),
            "fps": round(fps, 2) if fps else None,
            "codec": codec,
            "codec_raw": vcodec,
            "ext": fmt.get("ext"),
            "container": fmt.get("ext"),
            "hdr": hdr,
            "dynamic_range": fmt.get("dynamic_range"),
            "vbr": fmt.get("vbr") or fmt.get("tbr"),
            "tbr": fmt.get("tbr"),
            "filesize": size,
            "filesize_estimated": estimated and size is not None,
            "filesize_human": human_size(size),
            "protocol": protocol,
            "muxed": muxed,
            "label": label,
            "note": fmt.get("format_note"),
        })
    return out


def _audio_streams(formats: list[dict], duration: float | None) -> list[dict]:
    out: list[dict] = []
    for fmt in formats:
        acodec = fmt.get("acodec")
        if not acodec or acodec == "none":
            continue
        if fmt.get("vcodec") and fmt.get("vcodec") != "none":
            continue  # muxed formats are listed under video
        size = fmt.get("filesize") or fmt.get("filesize_approx")
        estimated = size is None
        if estimated:
            size = _estimate_bytes(fmt, duration)
        abr = fmt.get("abr") or fmt.get("tbr")
        codec = _friendly_codec(acodec, AUDIO_CODEC_NAMES)
        channels = fmt.get("audio_channels")
        out.append({
            "format_id": str(fmt.get("format_id")),
            "abr": round(float(abr), 1) if abr else None,
            "codec": codec,
            "codec_raw": acodec,
            "asr": fmt.get("asr"),
            "channels": channels,
            "channel_label": {1: "Mono", 2: "Stereo"}.get(channels)
                             or (f"{channels} channels" if channels else None),
            "ext": fmt.get("ext"),
            "filesize": size,
            "filesize_estimated": estimated and size is not None,
            "filesize_human": human_size(size),
            "language": fmt.get("language"),
            "protocol": (fmt.get("protocol") or "").lower(),
            "note": fmt.get("format_note"),
            "drc": "drc" in str(fmt.get("format_id", "")).lower(),
        })
    return out


def _subtitle_tracks(info: dict) -> list[dict]:
    tracks: list[dict] = []
    for source, auto in (("subtitles", False), ("automatic_captions", True)):
        entries = info.get(source) or {}
        if not isinstance(entries, dict):
            continue
        for lang, variants in entries.items():
            if not isinstance(variants, list) or not variants:
                continue
            formats = sorted({v.get("ext") for v in variants if v.get("ext")})
            name = next((v.get("name") for v in variants if v.get("name")), None)
            tracks.append({
                "language": lang,
                "name": name or lang,
                "auto_generated": auto,
                "formats": formats,
            })
    # Manual tracks first, then alphabetical.
    tracks.sort(key=lambda t: (t["auto_generated"], t["language"]))
    return tracks


def _ydl_options() -> dict:
    return {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": False,
        "socket_timeout": 20,
        "retries": 2,
    }


def _classify_error(exc: Exception) -> AnalysisError:
    """Turn an extractor exception into a message a person can act on."""
    text = redact(str(exc)).replace("ERROR: ", "").strip()
    lowered = text.lower()
    if "drm" in lowered:
        return AnalysisError(
            "This media is protected by DRM and cannot be downloaded.",
            code="drm_protected",
            hint="Protected media is outside what this app will process.",
            retryable=False,
        )
    if "private" in lowered or "sign in" in lowered or "login" in lowered:
        return AnalysisError(
            "This media is private or needs an account to view.",
            code="requires_auth",
            hint="Only media you can open without signing in can be analysed.",
            retryable=False,
        )
    if "unavailable" in lowered or "removed" in lowered or "deleted" in lowered:
        return AnalysisError(
            "The source says this media is unavailable.",
            code="unavailable",
            hint="It may have been removed or restricted in your region.",
            retryable=False,
        )
    if "unsupported url" in lowered or "no video" in lowered:
        return AnalysisError(
            "This link is not from a source the extractor supports.",
            code="unsupported",
            hint="Paste a direct link to a media page.",
            retryable=False,
        )
    if "timed out" in lowered or "timeout" in lowered or "connection" in lowered:
        return AnalysisError(
            "The source could not be reached.",
            code="network",
            hint="Check your internet connection and try again.",
            retryable=True,
        )
    if "429" in lowered or "too many requests" in lowered:
        return AnalysisError(
            "The source is rate limiting requests right now.",
            code="rate_limited",
            hint="Wait a minute and try again.",
            retryable=True,
        )
    return AnalysisError(
        text[:300] or "Analysis failed for an unknown reason.",
        code="analysis_failed",
        hint="Open the Logs page for the full extractor message.",
        retryable=True,
    )


def extract(url: str) -> dict:
    """Run the extractor. Raises AnalysisError on any failure."""
    try:
        with yt_dlp.YoutubeDL(_ydl_options()) as ydl:
            info = ydl.extract_info(url, download=False)
    except yt_dlp.utils.DownloadError as exc:
        raise _classify_error(exc) from exc
    except Exception as exc:  # noqa: BLE001 - extractor raises many types
        raise _classify_error(exc) from exc
    if info is None:
        raise AnalysisError("The extractor returned nothing for that link.")
    if info.get("_type") == "playlist":
        entries = [e for e in (info.get("entries") or []) if e]
        if not entries:
            raise AnalysisError(
                "That link is a playlist with no playable entries.",
                code="empty_playlist",
                retryable=False,
            )
        info = entries[0]
    return info


def analyze(raw_url: str, *, use_cache: bool = True) -> dict:
    """Validate, extract and normalise. This is what the API returns."""
    started = time.perf_counter()
    try:
        url = validate_media_url(raw_url)
    except ValidationError as exc:
        raise AnalysisError(exc.message, code="invalid_url", hint=exc.hint, retryable=False) from exc

    if use_cache:
        cached = db.cache_get(url)
        if cached:
            cached["cached"] = True
            return cached

    info = extract(url)
    duration = info.get("duration")

    live_status = info.get("live_status")
    if info.get("is_live") or live_status == "is_live":
        raise AnalysisError(
            "This is a live stream, which has no fixed end to download.",
            code="is_live",
            hint="Wait until the stream ends and a recording is published.",
            retryable=False,
        )

    formats = [f for f in (info.get("formats") or []) if isinstance(f, dict)]
    if any(f.get("has_drm") for f in formats):
        raise AnalysisError(
            "This media is protected by DRM and cannot be downloaded.",
            code="drm_protected",
            hint="Protected media is outside what this app will process.",
            retryable=False,
        )

    video = _video_streams(formats, duration)
    audio = _audio_streams(formats, duration)
    if not video and not audio:
        raise AnalysisError(
            "No downloadable media was found at that link.",
            code="no_formats",
            hint="The page may not expose a media file the extractor can read.",
            retryable=False,
        )

    description = info.get("description") or ""
    payload = {
        "id": info.get("id"),
        "url": url,
        "webpage_url": info.get("webpage_url") or url,
        "title": info.get("title") or "Untitled",
        "uploader": info.get("uploader") or info.get("channel"),
        "channel_url": info.get("channel_url") or info.get("uploader_url"),
        "duration": duration,
        "duration_string": info.get("duration_string"),
        "thumbnail": info.get("thumbnail"),
        "upload_date": info.get("upload_date"),
        "view_count": info.get("view_count"),
        "like_count": info.get("like_count"),
        "description": description[:600] + ("..." if len(description) > 600 else ""),
        "extractor": info.get("extractor_key") or info.get("extractor"),
        "live_status": live_status,
        "was_live": bool(info.get("was_live")),
        "chapters": len(info.get("chapters") or []),
        "video": sorted(video, key=lambda s: (s["height"], s["fps"] or 0, s["tbr"] or 0), reverse=True),
        "audio": sorted(audio, key=lambda s: (s["abr"] or 0), reverse=True),
        "subtitles": _subtitle_tracks(info),
        "has_video": bool(video),
        "has_audio": bool(audio),
        "analysed_ms": int((time.perf_counter() - started) * 1000),
        "cached": False,
    }
    db.cache_put(url, payload)
    logs.info(
        "api",
        f"Analysed {payload['title']}",
        detail=f"{len(video)} video streams, {len(audio)} audio streams, "
               f"{len(payload['subtitles'])} subtitle tracks",
    )
    return payload
