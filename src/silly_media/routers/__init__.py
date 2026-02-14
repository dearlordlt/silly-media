"""API routers module."""

from .actors import router as actors_router
from .llm import router as llm_router
from .music import router as music_router
from .pixelart import router as pixelart_router
from .tts import router as tts_router
from .vision import router as vision_router

__all__ = [
    "actors_router",
    "llm_router",
    "music_router",
    "pixelart_router",
    "tts_router",
    "vision_router",
]
