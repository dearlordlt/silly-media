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


class Img2ImgResponse(BaseModel):
    """Response metadata from image editing."""

    model: str
