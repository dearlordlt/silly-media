"""Base class for LLM text generation models."""

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Generator

if TYPE_CHECKING:
    from .schemas import LLMRequest, LLMResponse


class BaseLLMModel(ABC):
    """Abstract base class for LLM models."""

    model_id: str = ""
    display_name: str = ""
    estimated_vram_gb: float = 10.0

    def __init__(self) -> None:
        self._loaded = False

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    @abstractmethod
    def load(self) -> None:
        """Load model into VRAM."""
        ...

    @abstractmethod
    def unload(self) -> None:
        """Unload model from VRAM."""
        ...

    @abstractmethod
    def generate(self, request: "LLMRequest") -> "LLMResponse":
        """Generate text completion (non-streaming)."""
        ...

    @abstractmethod
    def generate_stream(
        self, request: "LLMRequest"
    ) -> Generator[str, None, None]:
        """Generate text completion with streaming (yields tokens)."""
        ...
