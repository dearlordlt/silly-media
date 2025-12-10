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
    from .hunyuan import HunyuanVideoModel

    VideoRegistry.register("hunyuan-video", HunyuanVideoModel)


_register_models()
