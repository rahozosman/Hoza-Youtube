"""Request and response models.

Pydantic validates every request body before it reaches application code, which
is where the "validate every parameter" rule is enforced for the API surface.
Field constraints here are deliberately tight: an oversized or malformed body
is rejected at the boundary rather than deeper in the pipeline.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class AnalyzeRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048)
    refresh: bool = False

    @field_validator("url")
    @classmethod
    def strip_url(cls, value: str) -> str:
        return value.strip()


class SelectionRequest(BaseModel):
    """What the user chose in the interface."""

    kind: Literal["video", "audio"] = "video"
    preset: Literal["best", "recommended", "compatibility", "saver", "custom"] = "custom"
    video_format_id: str | None = Field(default=None, max_length=64)
    audio_format_id: str | None = Field(default=None, max_length=64)
    height: int | None = Field(default=None, ge=1, le=8640)
    container: Literal["mp4", "mkv", "webm"] | None = None
    prefer_hdr: bool = False


class JobRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048)
    selection: SelectionRequest | dict[str, Any] = Field(default_factory=SelectionRequest)
    priority: int = Field(default=0, ge=-10, le=10)
    server: str | None = Field(default=None, max_length=64)
    local_only: bool = False
    # Per-download overrides. Absent means "use the saved setting".
    audio_format: str | None = Field(default=None, max_length=16)
    audio_bitrate: int | None = Field(default=None, ge=32, le=320)
    subtitle_mode: Literal["off", "download", "embed", "both"] | None = None


class SettingsUpdate(BaseModel):
    """A partial settings update. Unknown sections and keys are ignored."""

    model_config = {"extra": "allow"}


class ServerEntry(BaseModel):
    name: str = Field(min_length=1, max_length=48)
    url: str = Field(min_length=4, max_length=512)
    role: Literal["api", "worker", "api+worker"] = "api+worker"
    token: str | None = Field(default=None, max_length=256)


class ExtensionPing(BaseModel):
    version: str | None = Field(default=None, max_length=32)
    browser: str | None = Field(default=None, max_length=64)


class HandoffRequest(BaseModel):
    url: str = Field(min_length=3, max_length=2048)
    title: str | None = Field(default=None, max_length=500)
    video_id: str | None = Field(default=None, max_length=64)
    page_url: str | None = Field(default=None, max_length=2048)


class ErrorResponse(BaseModel):
    """The shape every failure uses, so the interface can render it well."""

    error: str
    code: str = "error"
    hint: str | None = None
    retryable: bool = False
