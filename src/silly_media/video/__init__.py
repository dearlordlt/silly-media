"""Video generation module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseVideoModel


class VideoRegistry:
    """Registry for video generation models."""

    _models: dict[str, type["BaseVideoModel"]] = {}
    _instances: dict[str, "BaseVideoModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseVideoModel"]) -> None:
        """Register a video model class."""
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseVideoModel":
        """Get or create a model instance."""
        if name not in cls._models:
            raise ValueError(f"Unknown video model: {name}")

        if name not in cls._instances:
            cls._instances[name] = cls._models[name]()

        return cls._instances[name]

    @classmethod
    def get_available_models(cls) -> list[str]:
        """Get list of registered model names."""
        return list(cls._models.keys())

    @classmethod
    def has_model(cls, name: str) -> bool:
        """Check if a model is registered."""
        return name in cls._models


# Import and register models after class definition to avoid circular imports
def _register_models() -> None:
    """Register all video models."""
    from ..utils import repo_cached
    from .hunyuan import HunyuanVideoModel

    # The distilled T2V/I2V weights (~88GB) were dropped locally to reclaim disk, so
    # only offer the model when at least one of them is cached — otherwise a single
    # /video request would trigger a huge download. Re-download to bring it back.
    if repo_cached(HunyuanVideoModel.model_id_t2v) or repo_cached(HunyuanVideoModel.model_id_i2v):
        VideoRegistry.register("hunyuan-video", HunyuanVideoModel)


_register_models()
