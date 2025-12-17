"""Schemas for vision API requests/responses."""

from pydantic import BaseModel, Field


class VisionRequest(BaseModel):
    """Request for vision analysis."""

    image: str | None = Field(
        default=None, description="Base64 encoded image (PNG/JPG)"
    )
    query: str = Field(..., description="Question or instruction about the image")
    max_tokens: int | None = Field(
        default=None, description="Maximum tokens in response (None = model default)"
    )
    temperature: float = Field(default=0.7, description="Sampling temperature")


class VisionResponse(BaseModel):
    """Response from vision analysis."""

    response: str
    model: str
