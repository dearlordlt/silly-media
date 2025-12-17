"""API routers module."""

from .actors import router as actors_router
from .tts import router as tts_router
from .vision import router as vision_router

__all__ = ["actors_router", "tts_router", "vision_router"]
