"""3D model generation module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseModel3D


class Model3DRegistry:
    """Registry for 3D model generation backends."""

    _models: dict[str, type["BaseModel3D"]] = {}
    _instances: dict[str, "BaseModel3D"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseModel3D"]) -> None:
        """Register a 3D model class."""
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseModel3D":
        """Get or create a model instance."""
        if name not in cls._models:
            raise ValueError(f"Unknown 3D model: {name}")

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
    """Register all 3D models."""
    from .hunyuan3d import Hunyuan3DModel

    Model3DRegistry.register("hunyuan3d-2", Hunyuan3DModel)


_register_models()
