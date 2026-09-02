"""ffmpeg discovery and capability probing.

The dashboard must never offer an output format the machine cannot produce.
Rather than assuming a standard build, this module asks the actual binary which
encoders and muxers it has, and the format lists are derived from the answer.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from functools import lru_cache

# Audio output formats the pipeline knows how to request, mapped to the ffmpeg
# encoder that must exist for the format to be offered.
AUDIO_ENCODERS = {
    "m4a": "aac",
    "mp3": "libmp3lame",
    "opus": "libopus",
    "flac": "flac",
    "wav": "pcm_s16le",
    "vorbis": "libvorbis",
}

# Bitrate menus that make sense per format. Lossless formats take no bitrate.
AUDIO_BITRATES = {
    "m4a": [64, 96, 128, 160, 192, 256, 320],
    "mp3": [64, 96, 128, 160, 192, 256, 320],
    "opus": [64, 96, 128, 160, 192, 256],
    "vorbis": [64, 96, 128, 160, 192, 256, 320],
    "flac": [],
    "wav": [],
}

LOSSLESS_AUDIO = {"flac", "wav"}

VIDEO_MUXERS = {"mp4": "mp4", "mkv": "matroska", "webm": "webm"}

_CREATE_NO_WINDOW = 0x08000000 if sys.platform.startswith("win") else 0


@dataclass
class FFmpegInfo:
    """What the installed ffmpeg can actually do."""

    path: str | None = None
    version: str | None = None
    source: str = "missing"          # "path" | "bundled" | "missing"
    encoders: set[str] = field(default_factory=set)
    muxers: set[str] = field(default_factory=set)
    error: str | None = None

    @property
    def available(self) -> bool:
        return bool(self.path)

    def audio_formats(self) -> list[str]:
        """Output audio formats this build can genuinely produce."""
        if not self.available:
            return []
        return [fmt for fmt, enc in AUDIO_ENCODERS.items() if enc in self.encoders]

    def video_containers(self) -> list[str]:
        if not self.available:
            return []
        return [fmt for fmt, mux in VIDEO_MUXERS.items() if mux in self.muxers]

    def to_dict(self) -> dict:
        return {
            "available": self.available,
            "path": self.path,
            "version": self.version,
            "source": self.source,
            "audio_formats": self.audio_formats(),
            "video_containers": self.video_containers(),
            "encoder_count": len(self.encoders),
            "error": self.error,
        }


def _run(args: list[str], timeout: int = 20) -> subprocess.CompletedProcess:
    """Run a process with no shell, no window, and a bounded runtime."""
    return subprocess.run(
        args,
        capture_output=True,
        text=True,
        timeout=timeout,
        shell=False,
        creationflags=_CREATE_NO_WINDOW,
    )


def _locate() -> tuple[str | None, str]:
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path, "path"
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe(), "bundled"
    except Exception:
        return None, "missing"


@lru_cache(maxsize=1)
def probe() -> FFmpegInfo:
    """Locate ffmpeg and read its real capabilities. Cached for the process."""
    path, source = _locate()
    if not path:
        return FFmpegInfo(
            source="missing",
            error="ffmpeg was not found. Install it, or run: pip install imageio-ffmpeg",
        )
    info = FFmpegInfo(path=path, source=source)
    try:
        version_out = _run([path, "-hide_banner", "-version"]).stdout
        first = version_out.splitlines()[0] if version_out else ""
        match = re.search(r"ffmpeg version (\S+)", first)
        info.version = match.group(1) if match else first.strip() or None

        enc = _run([path, "-hide_banner", "-encoders"]).stdout
        for line in enc.splitlines():
            m = re.match(r"^\s*[A-Z.]{6}\s+(\S+)", line)
            if m:
                info.encoders.add(m.group(1))

        mux = _run([path, "-hide_banner", "-muxers"]).stdout
        for line in mux.splitlines():
            m = re.match(r"^\s*[E ]{2}\s+(\S+)", line)
            if m:
                for name in m.group(1).split(","):
                    info.muxers.add(name)
    except (OSError, subprocess.SubprocessError) as exc:
        info.error = f"ffmpeg was found but could not be run: {exc}"
    return info


def ffprobe_path() -> str | None:
    """Path to ffprobe when one sits beside ffmpeg. Optional, used by diagnostics."""
    found = shutil.which("ffprobe")
    if found:
        return found
    info = probe()
    if info.path:
        candidate = re.sub(r"ffmpeg(\.exe)?$", lambda m: "ffprobe" + (m.group(1) or ""), info.path)
        import os

        if candidate != info.path and os.path.exists(candidate):
            return candidate
    return None


def postprocessor_args(
    *,
    sample_rate: str | int | None = None,
    channels: str | int | None = None,
    normalize: bool = False,
) -> list[str]:
    """Build validated ffmpeg arguments for audio shaping.

    Every value is checked against a fixed set here, so nothing from the request
    body reaches the process argument list unexamined.
    """
    args: list[str] = []
    if sample_rate and str(sample_rate).lower() not in ("original", "source", "none"):
        rate = int(sample_rate)
        if rate not in (8000, 16000, 22050, 32000, 44100, 48000, 96000):
            raise ValueError(f"Unsupported sample rate: {rate}")
        args += ["-ar", str(rate)]
    if channels and str(channels).lower() not in ("original", "source", "none"):
        text = str(channels).lower()
        count = {"mono": 1, "stereo": 2, "1": 1, "2": 2}.get(text)
        if count is None:
            raise ValueError(f"Unsupported channel layout: {channels}")
        args += ["-ac", str(count)]
    if normalize:
        # EBU R128 loudness normalisation, single pass.
        args += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"]
    return args


_warm_lock = threading.Lock()


def warm() -> FFmpegInfo:
    """Probe once at startup so the first request is not slowed by it."""
    with _warm_lock:
        return probe()
