"""Model registry and base classes for image generation models."""

from .base import BaseImageModel, ModelRegistry
from .z_image import ZImageModel, ZImageTurboModel, ZImageTurboPMModel

__all__ = ["BaseImageModel", "ModelRegistry", "ZImageModel", "ZImageTurboModel", "ZImageTurboPMModel"]

# Register available models
ModelRegistry.register("z-image", ZImageModel)
ModelRegistry.register("z-image-turbo", ZImageTurboModel)

# PM fine-tune loads from a local single-file checkpoint; only offer it when
# the file is actually present (drop it in data/checkpoints and restart).
if ZImageTurboPMModel.checkpoint_path().is_file():
    ModelRegistry.register("z-image-turbo-pm", ZImageTurboPMModel)

# Qwen-Image-2512 with GGUF support
try:
    from diffusers import GGUFQuantizationConfig  # noqa: F401 - check if available

    from .qwen_image import QwenImage2512Model

    ModelRegistry.register("qwen-image-2512", QwenImage2512Model)
    __all__.append("QwenImage2512Model")
except ImportError:
    pass  # GGUF support not available in this diffusers version

# Ovis-Image requires a custom diffusers fork, try to register if available
try:
    from diffusers import OvisImagePipeline  # noqa: F401 - check if available

    from .ovis_image import OvisImageModel

    ModelRegistry.register("ovis-image-7b", OvisImageModel)
    __all__.append("OvisImageModel")
except ImportError:
    pass  # OvisImagePipeline not available in this diffusers version

# Krea-2-Turbo requires a recent diffusers (Krea2Pipeline), try to register if available
try:
    from diffusers import Krea2Pipeline  # noqa: F401 - check if available

    from .krea2 import Krea2TurboModel

    ModelRegistry.register("krea-2-turbo", Krea2TurboModel)
    __all__.append("Krea2TurboModel")
except ImportError:
    pass  # Krea2Pipeline not available in this diffusers version
