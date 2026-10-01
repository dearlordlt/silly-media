"""Img2img module for Silly Media."""

from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .base import BaseImg2ImgModel


class Img2ImgRegistry:
    """Registry for img2img models."""

    # A class, or any factory returning the instance (lets a model shared with the
    # image registry hand back that same instance).
    _models: dict[str, Callable[[], "BaseImg2ImgModel"]] = {}
    _instances: dict[str, "BaseImg2ImgModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: Callable[[], "BaseImg2ImgModel"]) -> None:
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

    # Qwen-Image-2.1 does text-to-image and editing with one pipeline: reuse the image
    # registry's instance so the VRAM manager sees a single model under both types.
    from ..models import ModelRegistry

    if "qwen-image-2.1" in ModelRegistry.get_available_models():
        Img2ImgRegistry.register("qwen-image-2.1", lambda: ModelRegistry.get_model("qwen-image-2.1"))


_register_models()
