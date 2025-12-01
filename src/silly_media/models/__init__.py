"""Model registry and base classes for image generation models."""

from .base import BaseImageModel, ModelRegistry
from .z_image import ZImageTurboModel

__all__ = ["BaseImageModel", "ModelRegistry", "ZImageTurboModel"]

# Register available models
ModelRegistry.register("z-image-turbo", ZImageTurboModel)

# Ovis-Image requires a custom diffusers fork, try to register if available
try:
    from diffusers import OvisImagePipeline  # noqa: F401 - check if available
    from .ovis_image import OvisImageModel
    ModelRegistry.register("ovis-image-7b", OvisImageModel)
    __all__.append("OvisImageModel")
except ImportError:
    pass  # OvisImagePipeline not available in this diffusers version
