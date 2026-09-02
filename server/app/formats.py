"""Quality presets and format selection.

Two responsibilities:

1. Resolve a preset such as "Recommended" into the concrete streams it will
   actually fetch, so the dashboard can show the real resolution, codec and
   size before anything is downloaded. A preset never silently substitutes a
   different quality at download time.
2. Build the extractor's format selector from format identifiers that were
   verified against a fresh analysis. Selector strings are assembled here from
   validated pieces, never taken from the request body.
"""

from __future__ import annotations

from typing import Any

from .analyzer import COMPATIBLE_AUDIO, COMPATIBLE_VIDEO, human_size

PRESETS = ("best", "recommended", "compatibility", "saver", "custom")

# Ceiling used by Recommended: past this, size grows faster than perceived value
# on an ordinary screen.
RECOMMENDED_MAX_HEIGHT = 1080
SAVER_TARGET_HEIGHT = 480


class SelectionError(ValueError):
    """The requested combination cannot be produced from this media."""


def _score_video(stream: dict, *, prefer_codec: str | None = None) -> tuple:
    """Rank video streams of the same height. Higher is better."""
    codec = stream.get("codec") or ""
    preferred = 1 if (prefer_codec and codec.lower() == prefer_codec.lower()) else 0
    # A direct file reports its size and resumes cleanly; a segmented stream does not.
    direct = 1 if stream.get("protocol", "").startswith("http") else 0
    return (preferred, direct, stream.get("fps") or 0, stream.get("tbr") or 0)


def _best_video_at(streams: list[dict], height: int, *, prefer_codec: str | None = None,
                   hdr: bool | None = None) -> dict | None:
    candidates = [s for s in streams if s["height"] == height]
    if hdr is True:
        hdr_only = [s for s in candidates if s["hdr"]]
        candidates = hdr_only or candidates
    elif hdr is False:
        sdr_only = [s for s in candidates if not s["hdr"]]
        candidates = sdr_only or candidates
    if not candidates:
        return None
    return max(candidates, key=lambda s: _score_video(s, prefer_codec=prefer_codec))


def _best_audio(streams: list[dict], *, prefer_codec: str | None = None,
                max_abr: float | None = None) -> dict | None:
    candidates = [s for s in streams if not s.get("drc")] or streams
    if not candidates:
        return None
    if max_abr is not None:
        limited = [s for s in candidates if (s["abr"] or 0) <= max_abr]
        candidates = limited or candidates
    if prefer_codec:
        preferred = [s for s in candidates if (s["codec"] or "").lower() == prefer_codec.lower()]
        candidates = preferred or candidates
    return max(candidates, key=lambda s: (s["abr"] or 0, 1 if s["ext"] == "m4a" else 0))


def available_heights(analysis: dict) -> list[int]:
    return sorted({s["height"] for s in analysis.get("video", [])}, reverse=True)


def resolve_preset(analysis: dict, preset: str, *, prefer_hdr: bool = False,
                   prefer_codec: str | None = None) -> dict | None:
    """Resolve a preset against real streams. Returns None when impossible."""
    video = analysis.get("video") or []
    audio = analysis.get("audio") or []
    heights = available_heights(analysis)

    if preset == "audio" or (not video and audio):
        chosen_audio = _best_audio(audio)
        if not chosen_audio:
            return None
        return {"video": None, "audio": chosen_audio, "reason": "Best available audio"}

    if not heights:
        return None

    if preset == "best":
        height = heights[0]
        chosen_video = _best_video_at(video, height, hdr=True if prefer_hdr else None)
        chosen_audio = _best_audio(audio)
        reason = f"Highest available quality, {height}p"
    elif preset == "recommended":
        capped = [h for h in heights if h <= RECOMMENDED_MAX_HEIGHT]
        height = capped[0] if capped else heights[-1]
        chosen_video = (
            _best_video_at(video, height, prefer_codec="AVC", hdr=False)
            or _best_video_at(video, height)
        )
        chosen_audio = _best_audio(audio, max_abr=192)
        reason = f"Balanced quality and size at {height}p"
    elif preset == "compatibility":
        compatible_heights = [
            h for h in heights
            if any(s["height"] == h and s["codec"] in COMPATIBLE_VIDEO for s in video)
        ]
        if not compatible_heights:
            return None
        height = compatible_heights[0]
        chosen_video = _best_video_at(video, height, prefer_codec="AVC", hdr=False)
        chosen_audio = (
            _best_audio(audio, prefer_codec="AAC")
            or _best_audio(audio)
        )
        reason = f"AVC video and AAC audio at {height}p, for the widest player support"
    elif preset == "saver":
        at_or_above = [h for h in heights if h >= SAVER_TARGET_HEIGHT]
        height = at_or_above[-1] if at_or_above else heights[0]
        candidates = [s for s in video if s["height"] == height]
        chosen_video = min(candidates, key=lambda s: s.get("tbr") or 1e9) if candidates else None
        chosen_audio = _best_audio(audio, max_abr=128)
        reason = f"Smallest files at {height}p"
    else:
        return None

    if not chosen_video:
        return None
    return {"video": chosen_video, "audio": chosen_audio, "reason": reason}


def describe(resolved: dict, *, container: str = "mp4") -> dict:
    """Human summary of what a resolved selection will produce."""
    video = resolved.get("video")
    audio = resolved.get("audio")
    size = 0
    estimated = False
    for stream in (video, audio):
        if stream and stream.get("filesize"):
            size += stream["filesize"]
            estimated = estimated or stream.get("filesize_estimated", False)
        elif stream:
            estimated = True
    parts: list[str] = []
    if video:
        parts.append(f"{video['height']}p")
        if video.get("fps"):
            parts.append(f"{int(round(video['fps']))} FPS")
        if video.get("codec"):
            parts.append(video["codec"])
        if video.get("hdr"):
            parts.append(video.get("dynamic_range") or "HDR")
    if audio and audio.get("codec"):
        descriptor = audio["codec"]
        if audio.get("abr"):
            descriptor += f" {int(audio['abr'])} kbps"
        parts.append(descriptor)
    if video:
        parts.append((container or "mp4").upper())
    else:
        parts.append(((audio or {}).get("ext") or "audio").upper())
    return {
        "summary": " / ".join(p for p in parts if p),
        "size": size or None,
        "size_human": human_size(size) if size else None,
        "size_estimated": estimated,
        "reason": resolved.get("reason"),
        "video": video,
        "audio": audio,
    }


def preset_options(analysis: dict, *, prefer_hdr: bool = False) -> list[dict]:
    """Every preset that this media can genuinely satisfy, with real figures."""
    labels = {
        "best": "Best Quality",
        "recommended": "Recommended",
        "compatibility": "Best Compatibility",
        "saver": "Data Saver",
    }
    out: list[dict] = []
    for preset in ("best", "recommended", "compatibility", "saver"):
        resolved = resolve_preset(analysis, preset, prefer_hdr=prefer_hdr)
        if not resolved:
            continue
        described = describe(resolved)
        out.append({
            "id": preset,
            "label": labels[preset],
            "summary": described["summary"],
            "reason": described["reason"],
            "size": described["size"],
            "size_human": described["size_human"],
            "size_estimated": described["size_estimated"],
            "video_format_id": (resolved["video"] or {}).get("format_id"),
            "audio_format_id": (resolved["audio"] or {}).get("format_id"),
            "height": (resolved["video"] or {}).get("height"),
        })
    return out


def audio_options(analysis: dict) -> list[dict]:
    """Audio quality tiers this media genuinely offers."""
    audio = analysis.get("audio") or []
    if not audio:
        return []
    ranked = sorted(audio, key=lambda s: (s["abr"] or 0), reverse=True)
    tiers: list[dict] = []
    seen: set[str] = set()

    def add(label: str, stream: dict | None, note: str) -> None:
        if not stream or stream["format_id"] in seen:
            return
        seen.add(stream["format_id"])
        tiers.append({
            "id": label.lower().replace(" ", "-"),
            "label": label,
            "note": note,
            "format_id": stream["format_id"],
            "abr": stream["abr"],
            "codec": stream["codec"],
            "asr": stream["asr"],
            "channels": stream["channels"],
            "channel_label": stream["channel_label"],
            "ext": stream["ext"],
            "size": stream["filesize"],
            "size_human": stream["filesize_human"],
            "size_estimated": stream["filesize_estimated"],
        })

    add("Best Audio", ranked[0], "Highest bitrate the source offers")
    high = _best_audio(audio, max_abr=192)
    add("High Quality", high, "Up to 192 kbps")
    medium = _best_audio(audio, max_abr=128)
    add("Medium Quality", medium, "Up to 128 kbps")
    saver = min(ranked, key=lambda s: s["abr"] or 1e9)
    add("Data Saver", saver, "Smallest file")
    return tiers


def _verify(format_id: str | None, streams: list[dict], what: str) -> dict | None:
    """Confirm a requested identifier exists in this analysis."""
    if not format_id:
        return None
    for stream in streams:
        if stream["format_id"] == str(format_id):
            return stream
    raise SelectionError(
        f"The requested {what} is no longer offered for this media. "
        "Analyse the link again to refresh the list."
    )


def build_selection(analysis: dict, request: dict) -> dict:
    """Validate a download request against the analysis and resolve it.

    Returns a dictionary carrying the extractor's format selector plus the
    concrete streams, so the job record can state exactly what was asked for.
    """
    kind = request.get("kind", "video")
    if kind not in ("video", "audio"):
        raise SelectionError("Choose either video or audio.")
    preset = request.get("preset", "custom")
    if preset not in PRESETS:
        raise SelectionError(f"Unknown preset: {preset}")

    video_streams = analysis.get("video") or []
    audio_streams = analysis.get("audio") or []

    if kind == "audio":
        stream = _verify(request.get("audio_format_id"), audio_streams, "audio track")
        if stream is None:
            stream = _best_audio(audio_streams)
        if stream is None:
            raise SelectionError("This media has no separate audio track to download.")
        return {
            "kind": "audio",
            "preset": preset,
            "selector": f"{stream['format_id']}/bestaudio/best",
            "video": None,
            "audio": stream,
            "quality_label": f"{int(stream['abr'])} kbps" if stream.get("abr") else "Audio",
            "summary": describe({"video": None, "audio": stream})["summary"],
        }

    if preset != "custom":
        resolved = resolve_preset(
            analysis, preset,
            prefer_hdr=bool(request.get("prefer_hdr")),
        )
        if not resolved:
            raise SelectionError(
                f"The {preset} preset cannot be satisfied by this media. "
                "Choose a quality from the list instead."
            )
        video, audio = resolved["video"], resolved["audio"]
    else:
        video = _verify(request.get("video_format_id"), video_streams, "video quality")
        audio = _verify(request.get("audio_format_id"), audio_streams, "audio track")
        if video is None:
            height = request.get("height")
            if height:
                video = _best_video_at(video_streams, int(height))
            if video is None:
                raise SelectionError("Choose a video quality from the list.")
        if audio is None and not video.get("muxed"):
            audio = _best_audio(audio_streams)

    if video.get("muxed"):
        selector = video["format_id"]
    elif audio:
        selector = f"{video['format_id']}+{audio['format_id']}"
    else:
        selector = video["format_id"]

    label = f"{video['height']}p"
    if video.get("fps") and video["fps"] > 30:
        label += str(int(round(video["fps"])))
    if video.get("hdr"):
        label += " HDR"

    return {
        "kind": "video",
        "preset": preset,
        "selector": selector,
        "video": video,
        "audio": audio,
        "quality_label": label,
        "summary": describe({"video": video, "audio": audio},
                            container=request.get("container") or "mp4")["summary"],
    }


def merge_needed(selection: dict) -> bool:
    """True when the chosen streams have to be joined by ffmpeg."""
    video = selection.get("video")
    return bool(video and not video.get("muxed") and selection.get("audio"))
