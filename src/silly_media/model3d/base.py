"""Base class for 3D model generation models."""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image

if TYPE_CHECKING:
    from .schemas import Model3DRequest


class BaseModel3D(ABC):
    """Abstract base class for image-to-3D / text-to-3D generation models.

    Implementations load a shape pipeline (and optionally a texture/paint
    pipeline) and turn a single reference image into a textured mesh exported
    as a binary glTF (.glb) file.
    """

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 21.0
    default_steps: int = 30

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        """Check if model is loaded."""
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load the model(s) into VRAM."""
        ...

    @abstractmethod
    def unload(self) -> None:
        """Unload the model(s) from VRAM."""
        ...

    @abstractmethod
    def generate(
        self,
        image: Image.Image,
        request: "Model3DRequest",
    ) -> Path:
        """Generate a textured mesh from a reference image.

        Args:
            image: RGB reference image (background removal handled internally).
            request: Generation parameters (steps, guidance, faces, texture...).

        Returns:
            Path to the generated .glb file.
        """
        ...

    @property
    def supports_texture(self) -> bool:
        """Whether this model can paint a texture onto the mesh."""
        return True
