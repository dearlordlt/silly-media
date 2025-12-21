"""Img2img module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseImg2ImgModel


class Img2ImgRegistry:
    """Registry for img2img models."""

    _models: dict[str, type["BaseImg2ImgModel"]] = {}
    _instances: dict[str, "BaseImg2ImgModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseImg2ImgModel"]) -> None:
        """Register an img2img model class."""
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseImg2ImgModel":
        """Get or create a model instance."""
        if name not in cls._models:
            raise ValueError(f"Unknown img2img model: {name}")

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
    """Register all img2img models."""
    from .qwen_edit import QwenImageEditModel

    Img2ImgRegistry.register("qwen-image-edit", QwenImageEditModel)


_register_models()
