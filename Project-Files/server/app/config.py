"""Settings: schema, defaults, bounds and persistence.

This is the single configuration source for both the dashboard and the browser
extension. The extension reads and writes the same values over the HTTP API, so
changing the default quality in one place changes it in the other.

Values are validated against the schema on every write. A hand-edited config
file with an out-of-range number is clamped rather than allowed to break the
runtime.
"""

from __future__ import annotations

import copy
import json
import threading
from pathlib import Path
from typing import Any

from . import ffmpeg as ffmpeg_mod
from . import paths
from .filenames import DEFAULT_TEMPLATE, TOKENS as FILENAME_TOKENS, validate_template

RESOLUTIONS = [144, 240, 360, 480, 576, 720, 1080, 1440, 2160, 4320]
SMART_MODES = ["best", "recommended", "compatibility", "saver", "custom"]
VIDEO_CODEC_PREFS = ["auto", "avc1", "vp9", "av01"]
CONTAINERS = ["mp4", "mkv", "webm"]
AUDIO_FORMATS = ["m4a", "mp3", "opus", "flac", "wav", "vorbis"]
SAMPLE_RATES = ["original", "44100", "48000"]
CHANNEL_MODES = ["original", "stereo", "mono"]
SUBTITLE_MODES = ["off", "download", "embed", "both"]
SUBTITLE_FORMATS = ["srt", "vtt", "ass"]
THEMES = ["dark", "light", "system"]
QUEUE_BEHAVIOUR = ["fifo", "lifo", "smallest-first"]
DUPLICATE_POLICIES = ["rename", "skip", "replace"]

DEFAULTS: dict[str, dict[str, Any]] = {
    "general": {
        "download_dir": str(paths.DEFAULT_DOWNLOAD_DIR),
        "default_media_type": "video",        # video | audio
        "default_quality": 1080,
        "default_preset": "recommended",
        "auto_analyze": True,
        "auto_download": False,
    },
    "video": {
        "default_resolution": 1080,
        "preferred_codec": "auto",
        "container": "mp4",
        "fps_mode": "original",
        "prefer_hdr": False,
    },
    "audio": {
        "format": "m4a",
        "bitrate": 192,
        "sample_rate": "original",
        "channels": "original",
        "normalize": False,
        "prefer_original": True,
    },
    "subtitles": {
        "mode": "off",
        "languages": "en",
        "auto_generated": False,
        "format": "srt",
    },
    "metadata": {
        "preserve_metadata": True,
        "embed_thumbnail": False,
        "embed_chapters": True,
        "preserve_description": False,
    },
    "downloads": {
        "concurrent": 2,
        "queue_behaviour": "fifo",
        "retry_count": 2,
        "auto_retry": True,
        "timeout_seconds": 300,
        "duplicate_policy": "rename",
        "fragment_concurrency": 4,
    },
    "filename": {
        "template": DEFAULT_TEMPLATE,
        "remove_emoji": False,
        "max_length": 180,
        "replacement": "_",
    },
    "network": {
        "servers": [],                # list of {name, url, role, token}
        "github_url": "",             # the built-in GitHub entry; "" = not set
        "health_interval": 30,
        "request_timeout": 15,
        "retry_delay": 3,
        "failover_enabled": True,
        "rate_limit_per_minute": 120,
    },
    "storage": {
        "temp_dir": str(paths.DEFAULT_TEMP_DIR),
        "cleanup_temp": True,
        "cleanup_age_hours": 24,
        "max_storage_gb": 0,          # 0 means no ceiling
    },
    "interface": {
        "theme": "dark",
        "animations": True,
        "compact": False,
        "accent": "violet",
    },
    "advanced": {
        "debug_mode": False,
        "detailed_logs": False,
        "log_retention": 2000,
        "allow_remote_dispatch": True,
    },
}

# path -> (minimum, maximum)
BOUNDS: dict[str, tuple[int, int]] = {
    "downloads.concurrent": (1, 8),
    "downloads.retry_count": (0, 10),
    "downloads.timeout_seconds": (30, 3600),
    "downloads.fragment_concurrency": (1, 16),
    "network.health_interval": (5, 600),
    "network.request_timeout": (3, 120),
    "network.retry_delay": (0, 60),
    "network.rate_limit_per_minute": (10, 6000),
    "storage.cleanup_age_hours": (1, 720),
    "storage.max_storage_gb": (0, 100_000),
    "advanced.log_retention": (100, 100_000),
    "filename.max_length": (40, 250),
    "audio.bitrate": (32, 320),
}

ENUMS: dict[str, list] = {
    "general.default_media_type": ["video", "audio"],
    "general.default_preset": SMART_MODES,
    "general.default_quality": RESOLUTIONS,
    "video.default_resolution": RESOLUTIONS,
    "video.preferred_codec": VIDEO_CODEC_PREFS,
    "video.container": CONTAINERS,
    "video.fps_mode": ["original"],
    "audio.format": AUDIO_FORMATS,
    "audio.sample_rate": SAMPLE_RATES,
    "audio.channels": CHANNEL_MODES,
    "subtitles.mode": SUBTITLE_MODES,
    "subtitles.format": SUBTITLE_FORMATS,
    "downloads.queue_behaviour": QUEUE_BEHAVIOUR,
    "downloads.duplicate_policy": DUPLICATE_POLICIES,
    "interface.theme": THEMES,
}

_lock = threading.RLock()
_cache: dict[str, Any] | None = None


class ConfigError(ValueError):
    pass


def _coerce(path: str, value: Any, fallback: Any) -> Any:
    """Coerce and clamp one value against the schema."""
    if isinstance(fallback, bool):
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on")
        return bool(value)
    if isinstance(fallback, int) and not isinstance(fallback, bool):
        try:
            number = int(float(value))
        except (TypeError, ValueError):
            return fallback
        allowed = ENUMS.get(path)
        if allowed and number not in allowed:
            return fallback
        low, high = BOUNDS.get(path, (None, None))
        if low is not None:
            number = max(low, min(high, number))
        return number
    if isinstance(fallback, list):
        return value if isinstance(value, list) else fallback
    # string
    if value is None:
        return fallback
    text = str(value)
    allowed = ENUMS.get(path)
    if allowed and text not in [str(a) for a in allowed]:
        return fallback
    return text


def merge(stored: Any) -> dict[str, Any]:
    """Deep-merge stored values over the defaults, dropping unknown keys."""
    out = copy.deepcopy(DEFAULTS)
    if not isinstance(stored, dict):
        return out
    for section, fields in DEFAULTS.items():
        incoming = stored.get(section)
        if not isinstance(incoming, dict):
            continue
        for key, fallback in fields.items():
            if key not in incoming:
                continue
            out[section][key] = _coerce(f"{section}.{key}", incoming[key], fallback)
    return out


def load() -> dict[str, Any]:
    """Return the current settings, reading from disk once and caching."""
    global _cache
    with _lock:
        if _cache is not None:
            return copy.deepcopy(_cache)
        stored: Any = {}
        if paths.CONFIG_PATH.exists():
            try:
                stored = json.loads(paths.CONFIG_PATH.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                stored = {}
        _cache = merge(stored)
        return copy.deepcopy(_cache)


def save(partial: dict[str, Any]) -> dict[str, Any]:
    """Apply a partial update, validate it, persist, and return the result."""
    global _cache
    with _lock:
        current = load()
        for section, fields in partial.items():
            if section not in DEFAULTS or not isinstance(fields, dict):
                continue
            for key, value in fields.items():
                if key not in DEFAULTS[section]:
                    continue
                current[section][key] = _coerce(
                    f"{section}.{key}", value, DEFAULTS[section][key]
                )
        _validate(current)
        paths.ensure_dirs()
        tmp = paths.CONFIG_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(current, indent=2), "utf-8")
        tmp.replace(paths.CONFIG_PATH)
        _cache = current
        return copy.deepcopy(current)


def _validate(cfg: dict[str, Any]) -> None:
    """Reject a configuration that would break at download time."""
    ok, error = validate_template(cfg["filename"]["template"])
    if not ok:
        raise ConfigError(f"Filename template: {error}")

    info = ffmpeg_mod.probe()
    if info.available:
        available_audio = info.audio_formats()
        if available_audio and cfg["audio"]["format"] not in available_audio:
            raise ConfigError(
                f"This ffmpeg build cannot produce {cfg['audio']['format']}. "
                f"Available: {', '.join(available_audio)}."
            )
        containers = info.video_containers()
        if containers and cfg["video"]["container"] not in containers:
            raise ConfigError(
                f"This ffmpeg build cannot write {cfg['video']['container']}. "
                f"Available: {', '.join(containers)}."
            )

    for key in ("download_dir",):
        directory = Path(cfg["general"][key]).expanduser()
        try:
            directory.mkdir(parents=True, exist_ok=True)
            probe_file = directory / ".hoza-write-test"
            probe_file.write_text("ok", "utf-8")
            probe_file.unlink()
        except OSError as exc:
            raise ConfigError(f"Cannot write to the download folder: {exc}") from exc

    temp = Path(cfg["storage"]["temp_dir"]).expanduser()
    try:
        temp.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise ConfigError(f"Cannot create the temporary folder: {exc}") from exc

    for server in cfg["network"]["servers"]:
        if not isinstance(server, dict) or not server.get("url"):
            raise ConfigError("Every configured server needs a url.")


def reset() -> dict[str, Any]:
    """Restore defaults, keeping the download folder the user chose."""
    global _cache
    with _lock:
        keep = load()["general"]["download_dir"]
        _cache = copy.deepcopy(DEFAULTS)
        _cache["general"]["download_dir"] = keep
        paths.ensure_dirs()
        paths.CONFIG_PATH.write_text(json.dumps(_cache, indent=2), "utf-8")
        return copy.deepcopy(_cache)


def download_dir() -> Path:
    directory = Path(load()["general"]["download_dir"]).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def temp_dir() -> Path:
    directory = Path(load()["storage"]["temp_dir"]).expanduser()
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def schema() -> dict[str, Any]:
    """Describe the settings surface so the dashboard can render real controls.

    Option lists that depend on the machine, such as audio formats, are filtered
    by what ffmpeg on this machine can actually produce.
    """
    info = ffmpeg_mod.probe()
    audio_formats = info.audio_formats() or []
    containers = info.video_containers() or ["mp4"]
    return {
        "defaults": DEFAULTS,
        "bounds": {k: list(v) for k, v in BOUNDS.items()},
        "options": {
            "resolutions": RESOLUTIONS,
            "presets": SMART_MODES,
            "video_codecs": VIDEO_CODEC_PREFS,
            "containers": containers,
            "audio_formats": audio_formats,
            "audio_bitrates": ffmpeg_mod.AUDIO_BITRATES,
            "lossless_audio": sorted(ffmpeg_mod.LOSSLESS_AUDIO),
            "sample_rates": SAMPLE_RATES,
            "channels": CHANNEL_MODES,
            "subtitle_modes": SUBTITLE_MODES,
            "subtitle_formats": SUBTITLE_FORMATS,
            "themes": THEMES,
            "queue_behaviour": QUEUE_BEHAVIOUR,
            "duplicate_policies": DUPLICATE_POLICIES,
            "filename_tokens": sorted(f"{{{token}}}" for token in FILENAME_TOKENS),
        },
        "capabilities": info.to_dict(),
    }
