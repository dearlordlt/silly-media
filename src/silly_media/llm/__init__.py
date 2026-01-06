"""LLM module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseLLMModel


class LLMRegistry:
    """Registry for LLM models."""

    _models: dict[str, type["BaseLLMModel"]] = {}
    _instances: dict[str, "BaseLLMModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseLLMModel"]) -> None:
        """Register an LLM model class."""
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseLLMModel":
        """Get or create a model instance."""
        if name not in cls._models:
            raise ValueError(f"Unknown LLM model: {name}")

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
    """Register all LLM models."""
    from .huihui_qwen import HuihuiQwen3Model

    LLMRegistry.register("huihui-qwen3-4b", HuihuiQwen3Model)


_register_models()
