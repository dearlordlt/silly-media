"""Music generation module for Silly Media."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .base import BaseMusicModel


class MusicRegistry:
    """Registry for music generation models."""

    _models: dict[str, type["BaseMusicModel"]] = {}
    _instances: dict[str, "BaseMusicModel"] = {}

    @classmethod
    def register(cls, name: str, model_class: type["BaseMusicModel"]) -> None:
        cls._models[name] = model_class

    @classmethod
    def get_model(cls, name: str) -> "BaseMusicModel":
        if name not in cls._models:
            raise ValueError(f"Unknown music model: {name}")
        if name not in cls._instances:
            cls._instances[name] = cls._models[name]()
        return cls._instances[name]

    @classmethod
    def get_available_models(cls) -> list[str]:
        return list(cls._models.keys())

    @classmethod
    def has_model(cls, name: str) -> bool:
        return name in cls._models


def _register_models() -> None:
    from .ace_step import AceStepSFTModel, AceStepTurboModel

    MusicRegistry.register("ace-step-turbo", AceStepTurboModel)
    MusicRegistry.register("ace-step-sft", AceStepSFTModel)


_register_models()
