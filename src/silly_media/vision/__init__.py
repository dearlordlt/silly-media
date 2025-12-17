"""Vision module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseVisionModel


class VisionRegistry:
    """Registry for vision models."""

    _models: dict[str, type["BaseVisionModel"]] = {}
    _instances: dict[str, "BaseVisionModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseVisionModel"]) -> None:
        """Register a vision model class."""
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseVisionModel":
        """Get or create a model instance."""
        if name not in cls._models:
            raise ValueError(f"Unknown vision model: {name}")

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


def _register_models() -> None:
    """Register all vision models."""
    from .qwen3_vl import Qwen3VLModel

    VisionRegistry.register("qwen3-vl-8b", Qwen3VLModel)


_register_models()
