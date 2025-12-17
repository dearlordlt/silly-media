"""Base class for vision/VLM models."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from PIL import Image

if TYPE_CHECKING:
    from .schemas import VisionRequest


class BaseVisionModel(ABC):
    """Abstract base class for vision models."""

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 18.0

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        """Check if model is loaded."""
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
    def analyze(
        self, request: "VisionRequest", image: Image.Image | None = None
    ) -> str:
        """Analyze image and return text response.

        Args:
            request: Vision request with query and optional base64 image
            image: Optional PIL Image (used for multipart uploads)

        Returns:
            Text response from the model
        """
        ...
