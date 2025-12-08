"""Base classes for audio generation models."""

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Generator

if TYPE_CHECKING:
    from .schemas import TTSRequest

logger = logging.getLogger(__name__)


class BaseAudioModel(ABC):
    """Abstract base class for audio generation models."""

    model_id: str  # Model identifier
    display_name: str  # Human-readable name
    supported_languages: list[str]  # List of supported language codes
    sample_rate: int = 24000  # Output sample rate

    def __init__(self):
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load the model into GPU memory."""
        pass

    @abstractmethod
    def unload(self) -> None:
        """Unload the model from GPU memory."""
        pass

    @abstractmethod
    def synthesize(
        self,
        request: "TTSRequest",
        speaker_wav_paths: list[str],
    ) -> bytes:
        """Synthesize speech from text.

        Args:
            request: TTS generation request with text and parameters
            speaker_wav_paths: List of paths to speaker reference audio files

        Returns:
            WAV audio bytes
        """
        pass

    @abstractmethod
    def synthesize_stream(
        self,
        request: "TTSRequest",
        speaker_wav_paths: list[str],
    ) -> Generator[bytes, None, None]:
        """Synthesize speech with streaming output.

        Args:
            request: TTS generation request with text and parameters
            speaker_wav_paths: List of paths to speaker reference audio files

        Yields:
            WAV audio chunks
        """
        pass
