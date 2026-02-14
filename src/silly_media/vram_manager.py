"""Unified VRAM management across all model types."""

import asyncio
import gc
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any, Protocol

import torch

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


class ModelType(Enum):
    """Types of models for VRAM tracking."""

    IMAGE = "image"
    AUDIO = "audio"
    VIDEO = "video"
    VISION = "vision"
    IMG2IMG = "img2img"
    LLM = "llm"
    MUSIC = "music"


class Loadable(Protocol):
    """Protocol for models that can be loaded/unloaded."""

    def load(self) -> None: ...
    def unload(self) -> None: ...
    @property
    def is_loaded(self) -> bool: ...


@dataclass
class ModelInfo:
    """Metadata about a registered model."""

    name: str
    model_type: ModelType
    estimated_vram_gb: float
    instance: Any  # The actual model instance

    @property
    def is_loaded(self) -> bool:
        return self.instance.is_loaded


class VRAMManager:
    """Singleton VRAM coordinator for all GPU-based models.

    Ensures mutual exclusion for GPU access and automatic cleanup
    when switching between model types.
    """

    _instance: "VRAMManager | None" = None

    # VRAM estimates (GB) - defaults for known models
    VRAM_ESTIMATES = {
        "z-image": 22.0,
        "z-image-turbo": 22.0,
        "ovis-image-7b": 20.0,
        "qwen-image-2512": 15.0,  # GGUF Q5_K_M quantization
        "xtts-v2": 2.0,
        "demucs": 2.0,
        "maya": 16.0,
        "qwen3-vl-8b": 18.0,
        "qwen-image-edit": 20.0,
        "huihui-qwen3-4b": 10.0,
        "ace-step-turbo": 8.0,
        "ace-step-sft": 8.0,
    }

    def __new__(cls) -> "VRAMManager":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return

        self._lock = asyncio.Lock()  # Mutex for GPU operations
        self._models: dict[str, ModelInfo] = {}
        self._current_loaded: str | None = None
        self._idle_task: asyncio.Task | None = None
        self._last_used: float = 0
        self._idle_timeout: int = 300
        self._total_vram_gb: float = 24.0  # RTX 4090
        self._in_use: bool = False  # Track if GPU is currently in use
        self._initialized = True
        logger.info("VRAMManager initialized")

    def register(
        self,
        name: str,
        model_type: ModelType,
        instance: Loadable,
        estimated_vram_gb: float | None = None,
    ) -> None:
        """Register a model with the VRAM manager."""
        vram = estimated_vram_gb or self.VRAM_ESTIMATES.get(name, 10.0)
        self._models[name] = ModelInfo(
            name=name,
            model_type=model_type,
            estimated_vram_gb=vram,
            instance=instance,
        )
        logger.info(f"Registered model: {name} ({model_type.value}, ~{vram}GB VRAM)")

    def unregister(self, name: str) -> None:
        """Remove a model from the manager."""
        if name in self._models:
            if self._models[name].is_loaded:
                self._unload_model_sync(name)
            del self._models[name]
            logger.info(f"Unregistered model: {name}")

    @asynccontextmanager
    async def acquire_gpu(self, model_name: str):
        """Context manager for exclusive GPU access.

        Usage:
            async with vram_manager.acquire_gpu("z-image-turbo") as model:
                result = model.generate(request)
        """
        async with self._lock:
            self._in_use = True  # Mark as in use to prevent idle unload
            self._touch()  # Touch at start to reset idle timer
            model = await self._ensure_loaded(model_name)
            try:
                yield model
            finally:
                self._in_use = False
                self._touch()

    async def _ensure_loaded(self, name: str) -> Loadable:
        """Ensure the requested model is loaded, unloading others first."""
        if name not in self._models:
            raise ValueError(f"Unknown model: {name}")

        model_info = self._models[name]

        # If already loaded, return it
        if model_info.is_loaded and self._current_loaded == name:
            logger.debug(f"Model {name} already loaded")
            return model_info.instance

        # Unload ALL currently loaded models first
        await self._unload_all()

        # Clear VRAM aggressively
        self._clear_vram()

        # Load the requested model
        logger.info(f"Loading model: {name} (~{model_info.estimated_vram_gb}GB VRAM)")

        # Run load in thread pool to avoid blocking event loop
        await asyncio.to_thread(model_info.instance.load)

        self._current_loaded = name

        logger.info(f"Model {name} loaded successfully")
        return model_info.instance

    async def _unload_all(self) -> None:
        """Unload all loaded models."""
        loaded_models = [name for name, info in self._models.items() if info.is_loaded]
        if not loaded_models:
            logger.info("No models to unload")
            return

        logger.info(f"Unloading {len(loaded_models)} models: {loaded_models}")

        # Log VRAM before unloading
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM before unload: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")

        for name, info in self._models.items():
            if info.is_loaded:
                logger.info(f"Unloading model: {name}")
                await asyncio.to_thread(info.instance.unload)
                # Clear after each unload
                gc.collect()
                torch.cuda.empty_cache()

        self._current_loaded = None

        # Log VRAM after unloading
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM after unload: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")

    def _unload_model_sync(self, name: str) -> None:
        """Synchronous unload for cleanup scenarios."""
        if name in self._models and self._models[name].is_loaded:
            logger.info(f"Unloading model (sync): {name}")
            self._models[name].instance.unload()
            if self._current_loaded == name:
                self._current_loaded = None

    def _clear_vram(self) -> None:
        """Aggressively clear VRAM."""
        # Multiple gc passes help clear circular references
        gc.collect()
        gc.collect()
        gc.collect()

        if torch.cuda.is_available():
            # Clear PyTorch's CUDA cache
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

            # Try to reset peak memory stats
            torch.cuda.reset_peak_memory_stats()

            # Reset accumulated memory (requires PyTorch 2.0+)
            try:
                torch.cuda.reset_accumulated_memory_stats()
            except AttributeError:
                pass  # Not available in older PyTorch versions

            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            free = (torch.cuda.get_device_properties(0).total_memory / 1e9) - reserved
            logger.info(
                f"VRAM after clear: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved, "
                f"~{free:.2f}GB free"
            )

    def _touch(self) -> None:
        """Update last-used timestamp and schedule idle check."""
        self._last_used = time.time()
        self._schedule_idle_check()

    def _schedule_idle_check(self) -> None:
        """Schedule idle timeout check."""
        if self._idle_timeout <= 0:
            return

        if self._idle_task is not None and not self._idle_task.done():
            self._idle_task.cancel()

        try:
            loop = asyncio.get_running_loop()
            self._idle_task = loop.create_task(self._idle_check())
            logger.debug(f"Scheduled idle check in {self._idle_timeout}s")
        except RuntimeError:
            # No event loop running
            logger.debug("No event loop running, idle check will be scheduled later")

    async def _idle_check(self) -> None:
        """Unload models after idle timeout."""
        try:
            logger.info(f"Idle timer started: will unload in {self._idle_timeout}s if no activity")

            while True:
                elapsed = time.time() - self._last_used
                remaining = self._idle_timeout - elapsed

                if remaining <= 0:
                    # Don't unload if GPU is currently in use
                    if self._in_use:
                        logger.debug("Idle timeout reached but GPU is in use, skipping unload")
                        # Reset timer and continue waiting
                        self._last_used = time.time()
                        await asyncio.sleep(self._idle_timeout)
                        continue

                    loaded = self.get_loaded_models()
                    if loaded:
                        logger.info(
                            f"Idle timeout ({self._idle_timeout}s) reached, unloading: {loaded}"
                        )
                        async with self._lock:
                            await self._unload_all()
                            self._clear_vram()
                        logger.info("All models unloaded due to idle timeout")
                    return

                logger.debug(f"Idle timer: {elapsed:.0f}s elapsed, sleeping {remaining:.0f}s")
                await asyncio.sleep(remaining)

        except asyncio.CancelledError:
            logger.debug("Idle timer cancelled (new activity)")

    def get_loaded_models(self) -> list[str]:
        """Get list of currently loaded model names."""
        return [name for name, info in self._models.items() if info.is_loaded]

    def get_available_models(self, model_type: ModelType | None = None) -> list[str]:
        """Get list of available models, optionally filtered by type."""
        if model_type is None:
            return list(self._models.keys())
        return [name for name, info in self._models.items() if info.model_type == model_type]

    def get_model_info(self, name: str) -> ModelInfo | None:
        """Get info about a specific model."""
        return self._models.get(name)

    def set_idle_timeout(self, timeout: int) -> None:
        """Set idle timeout in seconds (0 = disabled)."""
        self._idle_timeout = timeout
        logger.info(f"Idle timeout set to {timeout}s (0 = disabled)")

    def shutdown(self) -> None:
        """Synchronous shutdown - unload all models."""
        logger.info("VRAMManager shutting down...")

        # Cancel idle task
        if self._idle_task is not None and not self._idle_task.done():
            self._idle_task.cancel()

        # Unload all models
        for name, info in self._models.items():
            if info.is_loaded:
                self._unload_model_sync(name)

        self._clear_vram()
        logger.info("VRAMManager shutdown complete")


# Global singleton instance
vram_manager = VRAMManager()
