"""Schemas for Video generation APIs."""

from datetime import datetime
from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class VideoResolution(str, Enum):
    """Available video resolutions."""

    RES_480P = "480p"
    RES_720P = "720p"


class VideoAspectRatio(str, Enum):
    """Available video aspect ratios."""

    LANDSCAPE_16_9 = "16:9"
    PORTRAIT_9_16 = "9:16"
    SQUARE_1_1 = "1:1"


class VideoGenerateRequest(BaseModel):
    """Base request for video generation."""

    prompt: Annotated[
        str, Field(min_length=1, max_length=2000, description="Text prompt for video generation")
    ]
    resolution: Annotated[
        VideoResolution,
        Field(default=VideoResolution.RES_480P, description="Output video resolution"),
    ] = VideoResolution.RES_480P
    aspect_ratio: Annotated[
        VideoAspectRatio,
        Field(default=VideoAspectRatio.LANDSCAPE_16_9, description="Video aspect ratio"),
    ] = VideoAspectRatio.LANDSCAPE_16_9
    num_frames: Annotated[
        int,
        Field(default=45, ge=25, le=85, description="Number of frames (25-85, ~1-3.5 seconds at 24fps)"),
    ] = 45
    num_inference_steps: Annotated[
        int,
        Field(default=6, ge=1, le=100, description="Number of inference steps (6 for distilled, 50 for standard)"),
    ] = 6
    guidance_scale: Annotated[
        float,
        Field(default=1.0, ge=1.0, le=15.0, description="Guidance scale (1.0 for distilled, 6.0 for standard)"),
    ] = 1.0
    seed: Annotated[
        int,
        Field(default=-1, ge=-1, description="Random seed (-1 for random)"),
    ] = -1
    fps: Annotated[
        int,
        Field(default=24, ge=12, le=30, description="Output video FPS"),
    ] = 24


class T2VRequest(VideoGenerateRequest):
    """Text-to-Video request - generates video from text prompt only."""

    pass


class I2VRequest(VideoGenerateRequest):
    """Image-to-Video request - animates a reference image based on text prompt."""

    image: Annotated[
        str,
        Field(min_length=1, description="Base64 encoded reference image (PNG/JPG)"),
    ]


class VideoJobResponse(BaseModel):
    """Response when starting video generation."""

    job_id: str
    status: str
    estimated_time_seconds: float


class VideoStatusResponse(BaseModel):
    """Response for job status check."""

    job_id: str
    status: Literal["queued", "processing", "completed", "failed"]
    progress: float | None = None
    current_step: int | None = None
    total_steps: int | None = None
    elapsed_seconds: float | None = None
    video_url: str | None = None
    thumbnail_url: str | None = None
    error: str | None = None


class VideoHistoryEntry(BaseModel):
    """Video entry in history list."""

    id: str
    prompt: str
    model: str
    resolution: str
    aspect_ratio: str
    num_frames: int
    duration_seconds: float
    created_at: datetime
    thumbnail_url: str | None = None


class VideoHistoryResponse(BaseModel):
    """Video history list response."""

    videos: list[VideoHistoryEntry]
    total: int


class VideoModelInfo(BaseModel):
    """Information about a video model."""

    id: str
    name: str
    loaded: bool
    supports_t2v: bool
    supports_i2v: bool
    estimated_vram_gb: float


class VideoModelsResponse(BaseModel):
    """List of available video models."""

    models: list[VideoModelInfo]
