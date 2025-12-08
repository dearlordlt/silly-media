"""Schemas for TTS and Actor APIs."""

from datetime import datetime
from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field


class TTSLanguage(str, Enum):
    """Supported TTS languages."""

    EN = "en"
    ES = "es"
    FR = "fr"
    DE = "de"
    IT = "it"
    PT = "pt"
    PL = "pl"
    TR = "tr"
    RU = "ru"
    NL = "nl"
    CS = "cs"
    AR = "ar"
    ZH = "zh-cn"
    JA = "ja"
    HU = "hu"
    KO = "ko"
    HI = "hi"


class TTSRequest(BaseModel):
    """Request schema for TTS generation."""

    text: Annotated[
        str, Field(min_length=1, max_length=10000, description="Text to synthesize")
    ]
    actor: Annotated[
        str, Field(min_length=1, description="Actor name for voice cloning")
    ]
    language: Annotated[
        TTSLanguage, Field(default=TTSLanguage.EN, description="Output language")
    ] = TTSLanguage.EN

    # Generation parameters
    temperature: Annotated[
        float, Field(default=0.65, ge=0.0, le=1.0, description="Sampling temperature")
    ] = 0.65
    speed: Annotated[
        float, Field(default=1.0, ge=0.5, le=2.0, description="Playback speed")
    ] = 1.0
    split_sentences: Annotated[
        bool, Field(default=True, description="Split text into sentences for processing")
    ] = True


class TTSRequestWithAudio(BaseModel):
    """Request schema for TTS with uploaded reference audio."""

    text: Annotated[
        str, Field(min_length=1, max_length=10000, description="Text to synthesize")
    ]
    language: Annotated[
        TTSLanguage, Field(default=TTSLanguage.EN, description="Output language")
    ] = TTSLanguage.EN

    # Generation parameters
    temperature: Annotated[
        float, Field(default=0.65, ge=0.0, le=1.0, description="Sampling temperature")
    ] = 0.65
    speed: Annotated[
        float, Field(default=1.0, ge=0.5, le=2.0, description="Playback speed")
    ] = 1.0
    split_sentences: Annotated[
        bool, Field(default=True, description="Split text into sentences for processing")
    ] = True


# Actor schemas


class ActorCreateRequest(BaseModel):
    """Request to create a new actor (used with form data)."""

    name: Annotated[
        str, Field(min_length=1, max_length=100, description="Display name for the actor")
    ]
    language: TTSLanguage = TTSLanguage.EN
    description: str = ""


class ActorResponse(BaseModel):
    """Actor response schema."""

    id: str
    name: str
    language: str
    description: str | None
    audio_count: int
    created_at: datetime
    updated_at: datetime


class ActorListResponse(BaseModel):
    """List of actors response."""

    actors: list[ActorResponse]
    total: int


class ActorAudioFileResponse(BaseModel):
    """Actor audio file response."""

    id: str
    filename: str
    original_name: str | None
    duration_seconds: float | None
    created_at: datetime


class LanguageInfo(BaseModel):
    """Language info response."""

    code: str
    name: str


class LanguagesResponse(BaseModel):
    """List of supported languages."""

    languages: list[LanguageInfo]


# TTS History schemas


class TTSHistoryEntryResponse(BaseModel):
    """TTS history entry response."""

    id: str
    actor_name: str
    text: str
    language: str
    duration_seconds: float | None
    created_at: datetime


class TTSHistoryResponse(BaseModel):
    """TTS history list response."""

    entries: list[TTSHistoryEntryResponse]
    total: int


# Language display names
LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "it": "Italian",
    "pt": "Portuguese",
    "pl": "Polish",
    "tr": "Turkish",
    "ru": "Russian",
    "nl": "Dutch",
    "cs": "Czech",
    "ar": "Arabic",
    "zh-cn": "Chinese",
    "ja": "Japanese",
    "hu": "Hungarian",
    "ko": "Korean",
    "hi": "Hindi",
}
