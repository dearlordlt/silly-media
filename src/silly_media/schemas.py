from enum import Enum
from typing import Annotated

from pydantic import BaseModel, Field, model_validator

from .config import settings


class AspectRatio(str, Enum):
    """Common aspect ratios for image generation."""

    SQUARE = "1:1"
    PORTRAIT_4_5 = "4:5"
    PORTRAIT_3_4 = "3:4"
    PORTRAIT_2_3 = "2:3"
    PORTRAIT_9_16 = "9:16"
    LANDSCAPE_5_4 = "5:4"
    LANDSCAPE_4_3 = "4:3"
    LANDSCAPE_3_2 = "3:2"
    LANDSCAPE_16_9 = "16:9"
    LANDSCAPE_21_9 = "21:9"


# Map aspect ratios to (width, height) multipliers
ASPECT_RATIO_MAP: dict[AspectRatio, tuple[int, int]] = {
    AspectRatio.SQUARE: (1, 1),
    AspectRatio.PORTRAIT_4_5: (4, 5),
    AspectRatio.PORTRAIT_3_4: (3, 4),
    AspectRatio.PORTRAIT_2_3: (2, 3),
    AspectRatio.PORTRAIT_9_16: (9, 16),
    AspectRatio.LANDSCAPE_5_4: (5, 4),
    AspectRatio.LANDSCAPE_4_3: (4, 3),
    AspectRatio.LANDSCAPE_3_2: (3, 2),
    AspectRatio.LANDSCAPE_16_9: (16, 9),
    AspectRatio.LANDSCAPE_21_9: (21, 9),
}


def calculate_dimensions(
    aspect_ratio: AspectRatio,
    base_size: int = 1024,
) -> tuple[int, int]:
    """Calculate width and height from aspect ratio, maintaining approximately base_size total pixels."""
    w_ratio, h_ratio = ASPECT_RATIO_MAP[aspect_ratio]
    # Calculate dimensions that maintain the aspect ratio and approximate the base_size area
    # For a 1:1 ratio at 1024, we get 1024x1024 = 1M pixels
    # We want to maintain similar pixel count for other ratios
    target_pixels = base_size * base_size
    ratio = w_ratio / h_ratio
    # height = sqrt(target_pixels / ratio), width = height * ratio
    height = int((target_pixels / ratio) ** 0.5)
    width = int(height * ratio)
    # Round to nearest 64 for model compatibility
    width = (width // 64) * 64
    height = (height // 64) * 64
    return width, height


class GenerateRequest(BaseModel):
    """Request schema for image generation."""

    prompt: Annotated[str, Field(min_length=1, max_length=4096, description="Text prompt for generation")]
    negative_prompt: Annotated[str, Field(default="", max_length=2048, description="Negative prompt")] = ""
    num_inference_steps: Annotated[
        int, Field(default=None, ge=1, le=100, description="Number of denoising steps")
    ] = None
    cfg_scale: Annotated[
        float, Field(default=None, ge=1.0, le=20.0, description="Classifier-free guidance scale")
    ] = None
    seed: Annotated[int | None, Field(default=None, ge=-1, description="Random seed (-1 or omit for random)")] = None

    # Flexible sizing options - use ONE of these approaches:
    # Option 1: Explicit dimensions
    width: Annotated[int | None, Field(default=None, ge=64, le=2048, description="Image width in pixels")] = None
    height: Annotated[int | None, Field(default=None, ge=64, le=2048, description="Image height in pixels")] = None

    # Option 2: Aspect ratio with base size
    aspect_ratio: Annotated[AspectRatio | None, Field(default=None, description="Aspect ratio preset")] = None
    base_size: Annotated[
        int, Field(default=1024, ge=256, le=2048, description="Base size for aspect ratio calculation")
    ] = 1024

    @model_validator(mode="after")
    def resolve_dimensions(self) -> "GenerateRequest":
        """Resolve final width/height from the provided options."""
        # If explicit dimensions provided, use them
        if self.width is not None and self.height is not None:
            # Round to nearest 64
            self.width = (self.width // 64) * 64
            self.height = (self.height // 64) * 64
            return self

        # If aspect ratio provided, calculate dimensions
        if self.aspect_ratio is not None:
            self.width, self.height = calculate_dimensions(self.aspect_ratio, self.base_size)
            return self

        # If only one dimension provided, default the other
        if self.width is not None:
            self.width = (self.width // 64) * 64
            self.height = self.width  # Default to square
            return self
        if self.height is not None:
            self.height = (self.height // 64) * 64
            self.width = self.height  # Default to square
            return self

        # Use defaults
        self.width = settings.default_width
        self.height = settings.default_height
        return self

    def get_inference_steps(self) -> int:
        return self.num_inference_steps or settings.default_inference_steps

    def get_cfg_scale(self) -> float:
        return self.cfg_scale or settings.default_cfg_scale


class HealthResponse(BaseModel):
    """Health check response."""

    status: str
    models_loaded: list[str]
    available_models: list[str]


class ErrorResponse(BaseModel):
    """Error response schema."""

    error: str
    detail: str | None = None
