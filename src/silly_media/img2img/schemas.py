"""Schemas for img2img API requests/responses."""

from pydantic import BaseModel, Field


class Img2ImgRequest(BaseModel):
    """Request for image editing."""

    image: str | None = Field(
        default=None, description="Base64 encoded image (PNG/JPG)"
    )
    prompt: str = Field(..., description="Edit instruction for the image")
    negative_prompt: str = Field(
        default=" ", description="Negative prompt (model requires non-empty)"
    )
    num_inference_steps: int = Field(
        default=20, ge=1, le=100, description="Number of inference steps"
    )
    true_cfg_scale: float = Field(
        default=4.0, ge=1.0, le=20.0, description="CFG scale for guidance"
    )
    seed: int | None = Field(
        default=None, ge=-1, description="Random seed (-1 or None for random)"
    )


class Img2ImgResponse(BaseModel):
    """Response metadata from image editing."""

    model: str
