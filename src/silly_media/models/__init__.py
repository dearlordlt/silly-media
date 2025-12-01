"""Model registry and base classes for image generation models."""

from .base import BaseImageModel, ModelRegistry
from .ovis_image import OvisImageModel

__all__ = ["BaseImageModel", "ModelRegistry", "OvisImageModel"]

# Register available models
ModelRegistry.register("ovis-image-7b", OvisImageModel)
