"""Model registry and base classes for image generation models."""

from ..utils import repo_cached
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

# Ovis-Image requires a custom diffusers fork, try to register if available.
# Its weights were dropped locally to reclaim disk, so only offer it when they're
# actually cached (re-download the repo to bring it back).
try:
    from diffusers import OvisImagePipeline  # noqa: F401 - check if available

    from .ovis_image import OvisImageModel

    if repo_cached(OvisImageModel.model_id):
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

# Qwen-Image-2.1 Uncensored (GGUF) needs diffusers main with QwenImage21Pipeline. Its
# weights are a GGUF + partial base repo download, so only offer it once both are
# cached. Also registered as an img2img model (same instance) in img2img/__init__.py.
try:
    from diffusers import QwenImage21Pipeline  # noqa: F401 - check if available

    from .qwen_image21 import QwenImage21Model

    if QwenImage21Model.weights_cached():
        ModelRegistry.register("qwen-image-2.1", QwenImage21Model)
        __all__.append("QwenImage21Model")
except ImportError:
    pass  # QwenImage21Pipeline not available in this diffusers version
