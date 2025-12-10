"""Base class for video generation models."""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

if TYPE_CHECKING:
    from .schemas import I2VRequest, T2VRequest

# Progress callback type: (step, total_steps) -> None
ProgressCallback = Callable[[int, int], None]


class BaseVideoModel(ABC):
    """Abstract base class for video generation models."""

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 16.0
    default_steps: int = 50

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load the model into VRAM."""
        ...

    @abstractmethod
    def unload(self) -> None:
        """Unload the model from VRAM."""
        ...

    @abstractmethod
    def generate_t2v(
        self,
        request: "T2VRequest",
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        """Generate video from text prompt.

        Args:
            request: T2V generation request
            progress_callback: Diffusers callback for progress updates

        Returns:
            Path to generated video file
        """
        ...

    @abstractmethod
    def generate_i2v(
        self,
        request: "I2VRequest",
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        """Generate video from image + text prompt.

        Args:
            request: I2V generation request
            progress_callback: Diffusers callback for progress updates

        Returns:
            Path to generated video file
        """
        ...

    @property
    def supports_t2v(self) -> bool:
        """Check if model supports text-to-video."""
        return True

    @property
    def supports_i2v(self) -> bool:
        """Check if model supports image-to-video."""
        return True
