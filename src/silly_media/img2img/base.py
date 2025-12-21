"""Base class for img2img (image editing) models."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Callable

from PIL import Image

if TYPE_CHECKING:
    from .schemas import Img2ImgRequest


class BaseImg2ImgModel(ABC):
    """Abstract base class for image editing models."""

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 20.0

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
    def edit(
        self,
        request: "Img2ImgRequest",
        image: Image.Image,
        progress_callback: Callable | None = None,
    ) -> Image.Image:
        """Edit an image based on the prompt.

        Args:
            request: Edit request with prompt and parameters
            image: Input PIL Image to edit
            progress_callback: Optional callback for progress updates

        Returns:
            Edited PIL Image
        """
        ...
