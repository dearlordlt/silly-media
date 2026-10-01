"""Img2img (image editing) API router."""

import asyncio
import base64
import inspect
import io
import logging

from fastapi import APIRouter, File, Form, HTTPException, Path, Response, UploadFile
from PIL import Image
from pydantic import ValidationError

from ..img2img import Img2ImgRegistry
from ..img2img.schemas import Img2ImgRequest
from ..progress import img2img_progress
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)


def make_progress_callback(total_steps: int):
    """Create a progress callback for diffusers pipeline."""
    def callback(pipe, step_index, timestep, callback_kwargs):
        img2img_progress.update(step_index + 1)
        return callback_kwargs
    return callback

router = APIRouter(prefix="/img2img", tags=["img2img"])


@router.get("/progress")
async def get_img2img_progress():
    """Get current img2img edit progress."""
    return img2img_progress.to_dict()


@router.get("/models")
async def list_img2img_models():
    """List available img2img models."""
    return {
        "available": Img2ImgRegistry.get_available_models(),
        "loaded": [
            m
            for m in vram_manager.get_loaded_models()
            if vram_manager.get_model_info(m)
            and vram_manager.get_model_info(m).has_type(ModelType.IMG2IMG)
        ],
    }


def _open_image(data: bytes, keep_alpha: bool) -> Image.Image:
    """Decode an input image; keep alpha only for models that read it."""
    image = Image.open(io.BytesIO(data))
    if keep_alpha and (image.mode in ("RGBA", "LA", "PA") or "transparency" in image.info):
        return image.convert("RGBA")
    return image.convert("RGB")


def _resolve_model(model: str):
    """Validate the model name and return its (not necessarily loaded) instance."""
    available_models = vram_manager.get_available_models(ModelType.IMG2IMG)
    if model not in available_models:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model}' not found. Available: {available_models}",
        )
    return vram_manager.get_model_info(model).instance


def _validate_request(model: str, instance, request: Img2ImgRequest, n_references: int) -> None:
    max_side = getattr(instance, "max_side", 2048)
    for side in (request.width, request.height):
        if side is not None and side > max_side:
            raise HTTPException(400, f"Model '{model}' supports output sides up to {max_side}px")
    if n_references:
        if "reference_images" not in inspect.signature(instance.edit).parameters:
            raise HTTPException(400, f"Model '{model}' does not support reference_images")
        limit = getattr(instance, "max_reference_images", 9)
        if n_references > limit:
            raise HTTPException(400, f"Model '{model}' accepts up to {limit} reference images")


async def _run_edit(
    model: str,
    request: Img2ImgRequest,
    pil_image: Image.Image,
    reference_images: list[Image.Image],
) -> Response:
    try:
        async with vram_manager.acquire_gpu(model) as model_instance:
            logger.info(
                f"Img2img request: model={model}, prompt=****, references={len(reference_images)}"
            )

            # Setup progress tracking (models with turbo/hybrid schedules report
            # their real step count)
            if hasattr(model_instance, "progress_total"):
                total_steps = model_instance.progress_total(request)
            else:
                total_steps = request.num_inference_steps or getattr(model_instance, "default_steps", 20)
            img2img_progress.start(total_steps)
            progress_callback = make_progress_callback(total_steps)

            extra = {"reference_images": reference_images} if reference_images else {}
            try:
                result_image = await asyncio.to_thread(
                    model_instance.edit, request, pil_image, progress_callback, **extra
                )
            finally:
                img2img_progress.finish()

            # Convert to PNG bytes
            buffer = io.BytesIO()
            result_image.save(buffer, format="PNG")
            buffer.seek(0)

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        logger.exception("Img2img edit failed")
        raise HTTPException(status_code=500, detail=f"Edit failed: {e}")


@router.post(
    "/edit/{model}",
    responses={
        200: {"content": {"image/png": {}}, "description": "Edited image"},
        400: {"description": "Invalid request"},
        404: {"description": "Model not found"},
        500: {"description": "Edit failed"},
    },
)
async def edit_image(
    request: Img2ImgRequest,
    model: str = Path(..., description="Model name (e.g., 'qwen-image-edit', 'qwen-image-2.1')"),
):
    """Edit an image using the specified model with base64 input.

    Send a base64 encoded image along with an edit prompt to get
    an edited image back. Models that support it also take extra
    `reference_images` (image 2, 3, ... in the prompt).
    """
    instance = _resolve_model(model)

    # Validate image is provided
    if not request.image:
        raise HTTPException(400, "image field required for JSON request")

    references = request.reference_images or []
    _validate_request(model, instance, request, len(references))

    # Decode base64 images
    keep_alpha = getattr(instance, "supports_alpha_input", False)
    try:
        pil_image = _open_image(base64.b64decode(request.image), keep_alpha)
    except Exception:
        raise HTTPException(400, "Invalid base64 image")
    reference_images = []
    for i, data in enumerate(references, start=2):
        try:
            reference_images.append(_open_image(base64.b64decode(data), keep_alpha))
        except Exception:
            raise HTTPException(400, f"Invalid base64 reference image (image {i})")

    return await _run_edit(model, request, pil_image, reference_images)


@router.post(
    "/edit/{model}/upload",
    responses={
        200: {"content": {"image/png": {}}, "description": "Edited image"},
        400: {"description": "Invalid request"},
        404: {"description": "Model not found"},
        500: {"description": "Edit failed"},
    },
)
async def edit_image_upload(
    model: str = Path(..., description="Model name (e.g., 'qwen-image-edit', 'qwen-image-2.1')"),
    image: UploadFile = File(..., description="Input image to edit"),
    prompt: str = Form(..., description="Edit instruction"),
    negative_prompt: str = Form(" ", description="Negative prompt"),
    num_inference_steps: int | None = Form(None, description="Number of inference steps (omit for model default)"),
    true_cfg_scale: float | None = Form(None, description="CFG scale (omit for model default)"),
    seed: int | None = Form(None, description="Random seed (-1 or None for random)"),
    width: int | None = Form(None, description="Output width (defaults to input image width)"),
    height: int | None = Form(None, description="Output height (defaults to input image height)"),
    use_lora: bool = Form(False, description="Use the model's speed LoRA"),
    transparent: bool = Form(False, description="Return a transparent (RGBA) result (qwen-image-2.1)"),
    reference_images: list[UploadFile] | None = File(
        None, description="Extra reference images (image 2, 3, ...); models that support it only"
    ),
):
    """Edit an image using the specified model with multipart upload.

    Upload an image file along with an edit prompt to get
    an edited image back.
    """
    instance = _resolve_model(model)

    try:
        request = Img2ImgRequest(
            prompt=prompt,
            negative_prompt=negative_prompt,
            num_inference_steps=num_inference_steps,
            true_cfg_scale=true_cfg_scale,
            seed=seed,
            width=width,
            height=height,
            use_lora=use_lora,
            transparent=transparent,
        )
    except ValidationError as e:
        raise HTTPException(422, e.errors(include_url=False, include_context=False, include_input=False))

    references = reference_images or []
    _validate_request(model, instance, request, len(references))

    # Read and validate images
    keep_alpha = getattr(instance, "supports_alpha_input", False)
    try:
        pil_image = _open_image(await image.read(), keep_alpha)
    except Exception:
        raise HTTPException(400, "Invalid image file")
    ref_images = []
    for i, upload in enumerate(references, start=2):
        try:
            ref_images.append(_open_image(await upload.read(), keep_alpha))
        except Exception:
            raise HTTPException(400, f"Invalid reference image file (image {i})")

    return await _run_edit(model, request, pil_image, ref_images)
