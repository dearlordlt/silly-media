"""Base classes for image generation models."""

import logging
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

from PIL import Image

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)


class BaseImageModel(ABC):
    """Abstract base class for image generation models."""

    model_id: str  # HuggingFace model ID
    display_name: str  # Human-readable name

    def __init__(self):
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load the model into memory."""
        pass

    @abstractmethod
    def unload(self) -> None:
        """Unload the model from memory."""
        pass

    @abstractmethod
    def generate(self, request: "GenerateRequest") -> Image.Image:
        """Generate an image from the request."""
        pass


class ModelRegistry:
    """Registry for available image generation models."""

    _models: dict[str, type[BaseImageModel]] = {}
    _instances: dict[str, BaseImageModel] = {}

    @classmethod
    def register(cls, name: str, model_class: type[BaseImageModel]) -> None:
        """Register a model class."""
        cls._models[name] = model_class
        logger.info(f"Registered model: {name}")

    @classmethod
    def get_available_models(cls) -> list[str]:
        """Get list of available model names."""
        return list(cls._models.keys())

    @classmethod
    def get_loaded_models(cls) -> list[str]:
        """Get list of currently loaded model names."""
        return [name for name, instance in cls._instances.items() if instance.is_loaded]

    @classmethod
    def get_model(cls, name: str) -> BaseImageModel | None:
        """Get or create a model instance."""
        if name not in cls._models:
            return None

        if name not in cls._instances:
            cls._instances[name] = cls._models[name]()

        return cls._instances[name]

    @classmethod
    def load_model(cls, name: str) -> BaseImageModel:
        """Load a model by name."""
        model = cls.get_model(name)
        if model is None:
            raise ValueError(f"Unknown model: {name}")

        if not model.is_loaded:
            logger.info(f"Loading model: {name}")
            model.load()
            logger.info(f"Model loaded: {name}")

        return model

    @classmethod
    def unload_model(cls, name: str) -> None:
        """Unload a model by name."""
        if name in cls._instances and cls._instances[name].is_loaded:
            logger.info(f"Unloading model: {name}")
            cls._instances[name].unload()

    @classmethod
    def unload_all(cls) -> None:
        """Unload all models."""
        for name in list(cls._instances.keys()):
            cls.unload_model(name)
