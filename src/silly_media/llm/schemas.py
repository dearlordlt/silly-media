"""Schemas for LLM text generation API."""

from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field


class MessageRole(str, Enum):
    """Chat message roles."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"


class ChatMessage(BaseModel):
    """Single chat message."""

    role: MessageRole
    content: str


class LLMRequest(BaseModel):
    """Request for LLM text generation.

    Provide either 'messages' (chat format) or 'prompt' (raw text).
    """

    # Input: either messages (chat) OR prompt (raw completion)
    messages: list[ChatMessage] | None = Field(
        default=None,
        description="Chat messages (alternative to prompt)",
    )
    prompt: str | None = Field(
        default=None,
        description="Raw prompt text (alternative to messages)",
    )

    # Generation parameters - creative writing defaults
    temperature: Annotated[float, Field(ge=0.0, le=2.0)] = 0.8
    top_p: Annotated[float, Field(ge=0.0, le=1.0)] = 0.9
    top_k: Annotated[int, Field(ge=1, le=100)] = 50
    max_tokens: Annotated[int, Field(ge=1, le=32768)] = 32768
    repetition_penalty: Annotated[float, Field(ge=1.0, le=2.0)] = 1.1
    min_p: Annotated[float | None, Field(ge=0.0, le=1.0)] = None
    seed: int | None = Field(
        default=None,
        description="Random seed (-1 or None for random)",
    )

    # Optional system prompt (used with prompt, ignored with messages)
    system_prompt: str | None = Field(
        default=None,
        description="System prompt (only used with 'prompt' input)",
    )

    # Thinking mode (Qwen3 specific)
    enable_thinking: bool = Field(
        default=False,
        description="Enable Qwen3 thinking mode",
    )


class LLMResponse(BaseModel):
    """Response from LLM text generation."""

    text: str
    model: str
    input_tokens: int
    output_tokens: int
    generation_time_seconds: float
    seed: int | None = None


class StreamChunk(BaseModel):
    """Single streaming chunk for SSE."""

    delta: str  # New text token(s)
    finish_reason: str | None = None  # "stop", "length", or None
