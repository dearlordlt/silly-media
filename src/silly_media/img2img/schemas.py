"""Schemas for img2img API requests/responses."""

from typing import Literal

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
    num_inference_steps: int | None = Field(
        default=None,
        ge=1,
        le=100,
        description="Number of inference steps (omit for the model default: qwen-image-edit 20, qwen-image-2.1 40 / 6 turbo)",
    )
    true_cfg_scale: float | None = Field(
        default=None,
        ge=1.0,
        le=20.0,
        description="CFG scale for guidance (omit for the model default: qwen-image-edit 4.0, qwen-image-2.1 1.0 = off)",
    )
    seed: int | None = Field(
        default=None, ge=-1, description="Random seed (-1 or None for random)"
    )
    width: int | None = Field(
        default=None,
        ge=64,
        le=3072,
        description="Output width (default: input width; qwen-image-2.1 ~1MP at the input's aspect). Max is per model",
    )
    height: int | None = Field(
        default=None,
        ge=64,
        le=3072,
        description="Output height (default: input height; qwen-image-2.1 ~1MP at the input's aspect). Max is per model",
    )
    use_lora: bool = Field(
        default=False,
        description="Use the model's speed LoRA (qwen-image-edit: Lightning; qwen-image-2.1: 6-step turbo)",
    )
    reference_images: list[str] | None = Field(
        default=None,
        max_length=9,
        description="Extra base64 reference images (image 2, 3, ... in the prompt); models that support it only",
    )
    transparent: bool = Field(
        default=False,
        description="Return a transparent (RGBA) result (qwen-image-2.1; automatic when the input has alpha)",
    )
    upscale: bool = Field(default=False, description="Upscale the result with an ESRGAN model after editing")
    upscale_factor: float = Field(default=2.0, gt=1.0, le=4.0, description="Upscale factor (1-4], used when upscale is true")
    upscale_model: Literal["clean", "sharp"] = Field(
        default="clean",
        description="clean = Real-ESRGAN x4plus (also removes grain/halftone texture); sharp = 4x-UltraSharp (keeps fine detail)",
    )


class Img2ImgResponse(BaseModel):
    """Response metadata from image editing."""

    model: str
