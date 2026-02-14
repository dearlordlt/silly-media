"""Base class for music generation models."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .schemas import MusicGenerateRequest


class BaseMusicModel(ABC):
    """Abstract base class for music generation models."""

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 8.0
    default_steps: int = 20

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load model into VRAM."""
        ...

    @abstractmethod
    def unload(self) -> None:
        """Unload model from VRAM."""
        ...

    @abstractmethod
    def generate(
        self,
        request: "MusicGenerateRequest",
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[dict]:
        """Generate music from the request.

        Args:
            request: Music generation request.
            progress_callback: Called with (current_step, total_steps).

        Returns:
            List of dicts with keys: path, seed, sample_rate
        """
        ...
