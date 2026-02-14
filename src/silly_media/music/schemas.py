"""Schemas for music generation API."""

from enum import Enum
from typing import Annotated, Literal

from pydantic import BaseModel, Field


class MusicModelVariant(str, Enum):
    """Available ACE-Step 1.5 model variants."""

    FAST = "ace-step"
    QUALITY = "ace-step-quality"


class AudioFormat(str, Enum):
    """Output audio formats."""

    WAV = "wav"
    FLAC = "flac"
    MP3 = "mp3"


class MusicGenerateRequest(BaseModel):
    """Request for music generation."""

    # Core content
    caption: Annotated[
        str,
        Field(
            min_length=1,
            max_length=512,
            description="Music description/tags (e.g., 'upbeat pop, catchy melody, female singer')",
        ),
    ]
    lyrics: Annotated[
        str,
        Field(
            default="",
            max_length=4096,
            description="Lyrics with section tags like [Verse], [Chorus], [Bridge]",
        ),
    ] = ""
    instrumental: Annotated[
        bool, Field(default=False, description="Force instrumental (no vocals)")
    ] = False

    # Musical metadata
    bpm: Annotated[
        int | None,
        Field(default=None, ge=30, le=300, description="Tempo in BPM (None for auto)"),
    ] = None
    keyscale: Annotated[
        str,
        Field(
            default="",
            max_length=20,
            description="Musical key (e.g., 'C Major', 'Am')",
        ),
    ] = ""
    timesignature: Annotated[
        str,
        Field(default="", max_length=5, description="Time signature: '2', '3', '4', or '6'"),
    ] = ""
    duration: Annotated[
        float,
        Field(default=30.0, ge=10.0, le=600.0, description="Duration in seconds"),
    ] = 30.0

    # DiT inference settings
    inference_steps: Annotated[
        int | None,
        Field(
            default=None,
            ge=1,
            le=100,
            description="Diffusion steps (None = model default: 20 fast, 40 quality)",
        ),
    ] = None
    guidance_scale: Annotated[
        float,
        Field(default=7.5, ge=0.0, le=50.0, description="Classifier-free guidance scale"),
    ] = 7.5
    seed: Annotated[
        int, Field(default=-1, ge=-1, description="Random seed (-1 for random)")
    ] = -1

    # Output
    audio_format: Annotated[
        AudioFormat, Field(default=AudioFormat.WAV, description="Output audio format")
    ] = AudioFormat.WAV
    batch_size: Annotated[
        int,
        Field(default=1, ge=1, le=4, description="Number of variations to generate"),
    ] = 1

    # Model selection
    model: Annotated[
        MusicModelVariant,
        Field(default=MusicModelVariant.FAST, description="Model variant to use"),
    ] = MusicModelVariant.FAST


class MusicJobResponse(BaseModel):
    """Response when starting music generation."""

    job_id: str
    status: str
    estimated_time_seconds: float


class MusicAudioResult(BaseModel):
    """Single audio result within a job."""

    index: int
    seed: int
    sample_rate: int
    download_url: str


class MusicStatusResponse(BaseModel):
    """Response for music generation job status."""

    job_id: str
    status: Literal["queued", "processing", "completed", "failed"]
    progress: float | None = None
    current_step: int | None = None
    total_steps: int | None = None
    elapsed_seconds: float | None = None
    audios: list[MusicAudioResult] | None = None
    error: str | None = None
