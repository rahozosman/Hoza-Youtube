"""Filename templates and sanitising.

The template the user writes uses friendly braces, `{title} - {quality}.{ext}`.
yt-dlp uses its own percent syntax, so `to_ytdlp_template` converts between
them. Sanitising happens on the rendered result, never on the template, so a
template cannot smuggle a path separator through a token value.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

DEFAULT_TEMPLATE = "{title} [{quality}].{ext}"

# Friendly token -> yt-dlp field. Only these are accepted.
TOKENS: dict[str, str] = {
    "title": "title",
    "channel": "uploader",
    "uploader": "uploader",
    "id": "id",
    "quality": "height",
    "resolution": "resolution",
    "codec": "vcodec",
    "ext": "ext",
    "date": "upload_date",
    "duration": "duration",
    "fps": "fps",
}

# Windows forbids these device names even with an extension.
RESERVED_NAMES = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}

ILLEGAL_CHARS = r'<>:"/\\|?*'
MAX_COMPONENT = 180


def _strip_emoji(text: str) -> str:
    """Drop pictographs and symbols, keeping letters, marks, numbers and punctuation."""
    out = []
    for ch in text:
        cat = unicodedata.category(ch)
        if cat in ("So", "Sk", "Cs", "Co", "Cn"):
            continue
        out.append(ch)
    return "".join(out)


def sanitize_component(
    name: str,
    *,
    remove_emoji: bool = False,
    max_length: int = MAX_COMPONENT,
    replacement: str = "_",
) -> str:
    """Make one path component safe on Windows, macOS and Linux."""
    if not name:
        return "untitled"
    text = unicodedata.normalize("NFC", str(name))
    if remove_emoji:
        text = _strip_emoji(text)
    # Control characters and path separators first.
    text = "".join(replacement if (ch in ILLEGAL_CHARS or ord(ch) < 32) else ch for ch in text)
    text = text.replace("‮", "").replace("​", "")  # bidi override, zero width
    text = re.sub(rf"{re.escape(replacement)}{{2,}}", replacement, text)
    text = text.strip(" .")
    if not text:
        return "untitled"
    stem, dot, ext = text.rpartition(".")
    base = stem if dot else text
    if base.lower() in RESERVED_NAMES:
        base = f"{base}_file"
        text = f"{base}.{ext}" if dot else base
    if len(text) > max_length:
        if dot and len(ext) < 12:
            keep = max_length - len(ext) - 1
            text = f"{text[:keep].strip(' .')}.{ext}"
        else:
            text = text[:max_length].strip(" .")
    return text or "untitled"


def to_ytdlp_template(template: str) -> str:
    """Convert `{title} [{quality}].{ext}` into yt-dlp's `%(title)s ...` form.

    Unknown tokens are dropped rather than passed through, so a template can
    never inject a yt-dlp field the app did not intend to expose.
    """
    text = template or DEFAULT_TEMPLATE
    # Escape percent signs already in the text so yt-dlp does not read them.
    text = text.replace("%", "%%")

    def replace(match: re.Match[str]) -> str:
        token = match.group(1).strip().lower()
        field = TOKENS.get(token)
        if field is None:
            return ""
        if token == "quality":
            # Render 1080p when a height exists, and "audio" when one does not,
            # so an audio-only download does not end up named "[NA]".
            return "%(height&{}p|audio)s"
        if token == "date":
            return "%(upload_date>%Y-%m-%d)s"
        return f"%({field})s"

    out = re.sub(r"\{([a-zA-Z_]+)\}", replace, text)
    out = re.sub(r"\s{2,}", " ", out).strip()
    if not out:
        out = "%(title)s.%(ext)s"
    if "%(ext)s" not in out:
        out = out + ".%(ext)s"
    return out


def unique_path(path: Path) -> Path:
    """Return `path` if free, else `name (1).ext`, `name (2).ext`, and so on."""
    if not path.exists():
        return path
    stem, ext = path.stem, path.suffix
    parent = path.parent
    for index in range(1, 1000):
        candidate = parent / f"{stem} ({index}){ext}"
        if not candidate.exists():
            return candidate
    raise OSError("Could not find a free filename after 999 attempts.")


def validate_template(template: str) -> tuple[bool, str | None]:
    """Check a user-entered template. Returns (ok, error message)."""
    if not template or not template.strip():
        return False, "The template cannot be empty."
    if any(ch in template for ch in '<>:"|?*'):
        return False, 'The template cannot contain < > : " | ? or *.'
    if "/" in template or "\\" in template:
        return False, "The template cannot contain slashes; it names a file, not a folder."
    if ".." in template:
        return False, "The template cannot contain two dots in a row."
    unknown = [
        token for token in re.findall(r"\{([a-zA-Z_]+)\}", template)
        if token.lower() not in TOKENS
    ]
    if unknown:
        known = ", ".join(f"{{{t}}}" for t in sorted(set(TOKENS)))
        return False, f"Unknown token {{{unknown[0]}}}. Available tokens: {known}."
    if not re.search(r"\{(title|id)\}", template):
        return False, "Include at least {title} or {id} so files have distinct names."
    return True, None
