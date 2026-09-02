"""The download pipeline.

Runs one job: fetch the chosen streams, merge or convert them with ffmpeg when
the selection requires it, attach subtitles and metadata, and land a finished
file inside the approved download folder.

Progress comes from the extractor's own hooks. Nothing here reports a
percentage it did not measure.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import yt_dlp

from . import config, ffmpeg as ffmpeg_mod, filenames, logs
from .analyzer import _classify_error
from .security import ValidationError, contain, redact


class CancelSignal(Exception):
    """Raised inside a hook to stop a running download for good."""


class PauseSignal(Exception):
    """Raised inside a hook to stop a download but keep its partial file."""


@dataclass
class Progress:
    status: str = "queued"
    percent: float = 0.0
    downloaded: int = 0
    total: int = 0
    speed: float | None = None
    eta: int | None = None
    detail: str | None = None


ProgressCallback = Callable[[Progress], None]
ControlCallback = Callable[[], str]      # returns "run" | "pause" | "cancel"


def _apply_control(control: ControlCallback | None) -> None:
    if control is None:
        return
    state = control()
    if state == "cancel":
        raise CancelSignal()
    if state == "pause":
        raise PauseSignal()


def _audio_postprocessors(cfg: dict, selection: dict) -> tuple[list[dict], list[str]]:
    """Build the audio conversion chain, or none when the source already fits."""
    audio_cfg = cfg["audio"]
    target = audio_cfg["format"]
    info = ffmpeg_mod.probe()
    available = info.audio_formats()
    if available and target not in available:
        raise ValidationError(
            f"This ffmpeg build cannot produce {target}. Available: {', '.join(available)}."
        )

    source_ext = (selection.get("audio") or {}).get("ext")
    needs_shaping = bool(
        audio_cfg["sample_rate"] != "original"
        or audio_cfg["channels"] != "original"
        or audio_cfg["normalize"]
    )
    # Preserve the original when it already matches and no shaping was asked for.
    if audio_cfg["prefer_original"] and source_ext == target and not needs_shaping:
        return [], []

    processor: dict[str, Any] = {
        "key": "FFmpegExtractAudio",
        "preferredcodec": target,
        "nopostoverwrites": False,
    }
    if target not in ffmpeg_mod.LOSSLESS_AUDIO:
        processor["preferredquality"] = str(audio_cfg["bitrate"])
    args = ffmpeg_mod.postprocessor_args(
        sample_rate=audio_cfg["sample_rate"],
        channels=audio_cfg["channels"],
        normalize=audio_cfg["normalize"],
    )
    return [processor], args


def build_options(
    cfg: dict,
    selection: dict,
    *,
    outtmpl: str,
    progress_hook: Callable,
    postprocessor_hook: Callable,
    resume: bool = False,
) -> dict:
    """Assemble extractor options. Every value here comes from validated config."""
    info = ffmpeg_mod.probe()
    kind = selection["kind"]
    subtitle_cfg = cfg["subtitles"]
    metadata_cfg = cfg["metadata"]

    options: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": selection["selector"],
        "outtmpl": outtmpl,
        "paths": {"temp": str(config.temp_dir())},
        "windowsfilenames": True,
        "restrictfilenames": False,
        # `trim_file_name` is deliberately not set: it trims against the whole
        # absolute path, so a deep download folder silently eats the title.
        # `_target_path` bounds the basename instead, which is the right place.
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "retries": cfg["downloads"]["retry_count"],
        "fragment_retries": cfg["downloads"]["retry_count"] + 3,
        "concurrent_fragment_downloads": cfg["downloads"]["fragment_concurrency"],
        "socket_timeout": min(cfg["downloads"]["timeout_seconds"], 120),
        "continuedl": True,
        "overwrites": cfg["downloads"]["duplicate_policy"] == "replace",
        "noprogress": True,
        "postprocessors": [],
    }
    if info.available:
        options["ffmpeg_location"] = info.path

    postprocessors: list[dict] = []

    if kind == "audio":
        if not info.available:
            raise ValidationError(
                "Audio conversion needs ffmpeg, which was not found on this machine."
            )
        audio_pps, pp_args = _audio_postprocessors(cfg, selection)
        postprocessors.extend(audio_pps)
        if pp_args:
            options["postprocessor_args"] = {"extractaudio": pp_args}
    else:
        container = cfg["video"]["container"]
        containers = info.video_containers()
        if containers and container not in containers:
            raise ValidationError(
                f"This ffmpeg build cannot write {container}. "
                f"Available: {', '.join(containers)}."
            )
        # Only ask for a merge when two streams actually have to be joined.
        video = selection.get("video") or {}
        if selection.get("audio") and not video.get("muxed"):
            options["merge_output_format"] = container
        # Subtitles
        if subtitle_cfg["mode"] != "off":
            languages = [
                lang.strip() for lang in subtitle_cfg["languages"].split(",") if lang.strip()
            ] or ["en"]
            options["subtitleslangs"] = languages
            options["writesubtitles"] = True
            options["writeautomaticsub"] = bool(subtitle_cfg["auto_generated"])
            options["subtitlesformat"] = subtitle_cfg["format"]
            if subtitle_cfg["mode"] in ("download", "both"):
                postprocessors.append({
                    "key": "FFmpegSubtitlesConvertor",
                    "format": subtitle_cfg["format"],
                })
            if subtitle_cfg["mode"] in ("embed", "both"):
                if container == "mp4" and subtitle_cfg["format"] == "ass":
                    raise ValidationError("MP4 cannot carry ASS subtitles. Choose SRT, or use MKV.")
                postprocessors.append({"key": "FFmpegEmbedSubtitle"})

    # Metadata applies to both kinds.
    if metadata_cfg["preserve_metadata"] and info.available:
        postprocessors.append({
            "key": "FFmpegMetadata",
            "add_metadata": True,
            "add_chapters": bool(metadata_cfg["embed_chapters"]),
            "add_infojson": False,
        })
    if metadata_cfg["embed_thumbnail"] and info.available:
        options["writethumbnail"] = True
        postprocessors.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})

    options["postprocessors"] = postprocessors
    if resume:
        options["continuedl"] = True
    return options


def _target_path(ydl: yt_dlp.YoutubeDL, info: dict, cfg: dict) -> Path:
    """Compute the final path and apply the duplicate policy."""
    raw = ydl.prepare_filename(info)
    path = Path(raw)
    directory = config.download_dir()
    # Keep the whole path inside the platform limit. Intermediate files carry a
    # format suffix such as ".f299", so leave room for it rather than producing
    # a name that only fails once merging starts.
    ceiling = 255 if sys.platform.startswith("win") else 4096
    budget = max(48, ceiling - len(str(directory)) - len(os.sep) - 16)
    safe_name = filenames.sanitize_component(
        path.name,
        remove_emoji=cfg["filename"]["remove_emoji"],
        max_length=min(cfg["filename"]["max_length"], budget),
        replacement=cfg["filename"]["replacement"],
    )
    target = directory / safe_name
    # Refuse anything that would land outside the approved folders.
    target = contain(target, config.download_dir(), config.temp_dir())
    policy = cfg["downloads"]["duplicate_policy"]
    if target.exists() and policy == "rename":
        target = filenames.unique_path(target)
    return target


def run(
    url: str,
    selection: dict,
    *,
    on_progress: ProgressCallback,
    control: ControlCallback | None = None,
    resume: bool = False,
) -> dict:
    """Execute one download. Returns a result dictionary or raises.

    Raises CancelSignal, PauseSignal, ValidationError, or AnalysisError.
    """
    cfg = config.load()
    started = time.time()
    state = {"filepath": None, "processing_started": None, "processing_ms": 0}

    def progress_hook(event: dict) -> None:
        _apply_control(control)
        status = event.get("status")
        if status == "downloading":
            total = event.get("total_bytes") or event.get("total_bytes_estimate") or 0
            done = event.get("downloaded_bytes") or 0
            on_progress(Progress(
                status="downloading",
                percent=min(99.0, done * 100.0 / total) if total else 0.0,
                downloaded=done,
                total=total,
                speed=event.get("speed"),
                eta=event.get("eta"),
            ))
        elif status == "finished":
            state["filepath"] = event.get("filename") or state["filepath"]
            on_progress(Progress(
                status="processing",
                percent=99.0,
                downloaded=event.get("downloaded_bytes") or 0,
                total=event.get("total_bytes") or 0,
                detail="Preparing file",
            ))

    def postprocessor_hook(event: dict) -> None:
        _apply_control(control)
        name = event.get("postprocessor", "")
        if event.get("status") == "started":
            if state["processing_started"] is None:
                state["processing_started"] = time.perf_counter()
            readable = {
                "Merger": "Merging video and audio",
                "FFmpegExtractAudio": "Converting audio",
                "FFmpegMetadata": "Writing metadata",
                "EmbedThumbnail": "Embedding thumbnail",
                "FFmpegEmbedSubtitle": "Embedding subtitles",
                "FFmpegSubtitlesConvertor": "Converting subtitles",
                "MoveFiles": "Finalising",
            }.get(name, f"Processing with {name}")
            on_progress(Progress(status="processing", percent=99.0, detail=readable))
        elif event.get("status") == "finished":
            data = event.get("info_dict") or {}
            path = data.get("filepath") or data.get("_filename")
            if path:
                state["filepath"] = path

    # A fresh extraction is required: signed media URLs expire, and the target
    # filename depends on the metadata the extractor returns.
    probe_options = {
        "quiet": True, "no_warnings": True, "noplaylist": True,
        "skip_download": True, "format": selection["selector"],
        "socket_timeout": 20,
    }
    try:
        with yt_dlp.YoutubeDL(probe_options) as ydl:
            info = ydl.extract_info(url, download=False)
            if info and info.get("_type") == "playlist":
                entries = [e for e in (info.get("entries") or []) if e]
                info = entries[0] if entries else info
    except Exception as exc:  # noqa: BLE001
        raise _classify_error(exc) from exc
    if not info:
        raise ValidationError("The source returned no media for that link.")

    template = filenames.to_ytdlp_template(cfg["filename"]["template"])
    with yt_dlp.YoutubeDL({**probe_options, "outtmpl": template}) as naming:
        planned = _target_path(naming, info, cfg)

    if planned.exists() and cfg["downloads"]["duplicate_policy"] == "skip":
        logs.info("download", f"Skipped, file already exists: {planned.name}")
        return {
            "filepath": str(planned),
            "filename": planned.name,
            "filesize": planned.stat().st_size,
            "skipped": True,
            "actual_format": selection["selector"],
            "processing_ms": 0,
            "elapsed": 0,
        }

    # An exact output template avoids a second guess at the filename.
    outtmpl = str(planned.with_suffix("")) + ".%(ext)s"
    options = build_options(
        cfg, selection,
        outtmpl=outtmpl,
        progress_hook=progress_hook,
        postprocessor_hook=postprocessor_hook,
        resume=resume,
    )

    on_progress(Progress(status="downloading", percent=0.0, detail="Starting"))
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            result = ydl.extract_info(url, download=True)
            if result and result.get("_type") == "playlist":
                entries = [e for e in (result.get("entries") or []) if e]
                result = entries[0] if entries else result
            requested = (result or {}).get("requested_downloads") or []
            if requested and requested[0].get("filepath"):
                state["filepath"] = requested[0]["filepath"]
            actual = ", ".join(
                str(f.get("format_id")) for f in (result or {}).get("requested_formats", [])
            ) or (result or {}).get("format_id") or selection["selector"]
    except (CancelSignal, PauseSignal):
        raise
    except yt_dlp.utils.DownloadError as exc:
        raise _classify_error(exc) from exc
    except Exception as exc:  # noqa: BLE001
        raise _classify_error(exc) from exc

    _apply_control(control)

    final = Path(state["filepath"]) if state["filepath"] else planned
    if not final.exists():
        # Post-processing may have changed the extension.
        matches = sorted(
            planned.parent.glob(planned.stem + ".*"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        matches = [m for m in matches if m.suffix not in (".part", ".ytdl", ".temp")]
        if matches:
            final = matches[0]
    if not final.exists():
        raise ValidationError(
            "The download finished but the output file could not be found."
        )
    final = contain(final, config.download_dir(), config.temp_dir())

    processing_ms = 0
    if state["processing_started"] is not None:
        processing_ms = int((time.perf_counter() - state["processing_started"]) * 1000)

    on_progress(Progress(
        status="completed", percent=100.0,
        downloaded=final.stat().st_size, total=final.stat().st_size,
    ))
    return {
        "filepath": str(final),
        "filename": final.name,
        "filesize": final.stat().st_size,
        "skipped": False,
        "actual_format": actual,
        "processing_ms": processing_ms,
        "elapsed": time.time() - started,
    }


def cleanup_partials(older_than_hours: float = 0) -> int:
    """Remove leftover partial and intermediate files from the temp folder."""
    removed = 0
    cutoff = time.time() - older_than_hours * 3600
    temp = config.temp_dir()
    patterns = ("*.part", "*.ytdl", "*.temp", "*.f*.mp4", "*.f*.webm", "*.f*.m4a")
    for pattern in patterns:
        for path in temp.glob(pattern):
            try:
                if older_than_hours and path.stat().st_mtime > cutoff:
                    continue
                path.unlink()
                removed += 1
            except OSError:
                continue
    return removed


def cleanup_job_leftovers(target: str | os.PathLike) -> int:
    """Remove the intermediate streams a specific job left behind."""
    removed = 0
    path = Path(target)
    stem = path.stem
    for directory in {path.parent, config.temp_dir()}:
        if not directory.exists():
            continue
        for leftover in directory.glob(f"{stem}*"):
            if leftover == path:
                continue
            if leftover.suffix in (".part", ".ytdl", ".temp") or ".f" in leftover.stem[len(stem):]:
                try:
                    leftover.unlink()
                    removed += 1
                except OSError:
                    continue
    return removed


def disk_guard() -> tuple[bool, str | None]:
    """Refuse to start when the download volume is nearly full."""
    try:
        usage = shutil.disk_usage(str(config.download_dir()))
    except OSError as exc:
        return True, f"Free space could not be read: {redact(str(exc))}"
    if usage.free < 512 * 1024 * 1024:
        return False, "Less than 512 MB free on the download volume."
    cap_gb = config.load()["storage"]["max_storage_gb"]
    if cap_gb:
        used = sum(
            f.stat().st_size for f in config.download_dir().rglob("*") if f.is_file()
        )
        if used >= cap_gb * 1024**3:
            return False, f"The {cap_gb} GB storage ceiling for the download folder is reached."
    return True, None
