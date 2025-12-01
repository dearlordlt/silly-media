"""Base classes for image generation models."""

import asyncio
import logging
import time
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
    _last_used: float = 0  # Timestamp of last model use
    _idle_task: asyncio.Task | None = None
    _idle_timeout: int = 0  # Seconds before unloading (0 = disabled)

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
    def set_idle_timeout(cls, timeout: int) -> None:
        """Set the idle timeout in seconds. 0 = disabled."""
        cls._idle_timeout = timeout
        logger.info(f"Model idle timeout set to {timeout}s (0 = disabled)")

    @classmethod
    def _touch(cls) -> None:
        """Update last used timestamp and restart idle timer."""
        cls._last_used = time.time()
        cls._schedule_idle_check()

    @classmethod
    def _schedule_idle_check(cls) -> None:
        """Schedule an idle check task."""
        if cls._idle_timeout <= 0:
            return

        # Cancel existing task if any
        if cls._idle_task is not None and not cls._idle_task.done():
            cls._idle_task.cancel()

        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                cls._idle_task = loop.create_task(cls._idle_check())
        except RuntimeError:
            # No event loop running yet
            pass

    @classmethod
    async def _idle_check(cls) -> None:
        """Check if models should be unloaded due to idle timeout."""
        await asyncio.sleep(cls._idle_timeout)

        elapsed = time.time() - cls._last_used
        if elapsed >= cls._idle_timeout:
            loaded = cls.get_loaded_models()
            if loaded:
                logger.info(f"Idle timeout ({cls._idle_timeout}s) reached, unloading models...")
                cls.unload_all()
        else:
            # Not enough time passed, reschedule
            remaining = cls._idle_timeout - elapsed
            await asyncio.sleep(remaining)
            await cls._idle_check()

    @classmethod
    def load_model(cls, name: str, auto_unload_others: bool = True) -> BaseImageModel:
        """Load a model by name, optionally unloading others first to free VRAM."""
        model = cls.get_model(name)
        if model is None:
            raise ValueError(f"Unknown model: {name}")

        if not model.is_loaded:
            # Unload other models first to free VRAM
            if auto_unload_others:
                for other_name in cls.get_loaded_models():
                    if other_name != name:
                        logger.info(f"Auto-unloading {other_name} to free VRAM")
                        cls.unload_model(other_name)

            logger.info(f"Loading model: {name}")
            model.load()
            logger.info(f"Model loaded: {name}")

        # Update last used time and schedule idle check
        cls._touch()

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
