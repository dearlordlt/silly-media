"""Img2img (image editing) API router."""

import asyncio
import base64
import io
import logging

from fastapi import APIRouter, File, Form, HTTPException, Path, Response, UploadFile
from PIL import Image

from ..img2img import Img2ImgRegistry
from ..img2img.schemas import Img2ImgRequest
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/img2img", tags=["img2img"])


@router.get("/models")
async def list_img2img_models():
    """List available img2img models."""
    return {
        "available": Img2ImgRegistry.get_available_models(),
        "loaded": [
            m
            for m in vram_manager.get_loaded_models()
            if vram_manager.get_model_info(m)
            and vram_manager.get_model_info(m).model_type == ModelType.IMG2IMG
        ],
    }


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
    model: str = Path(..., description="Model name (e.g., 'qwen-image-edit')"),
):
    """Edit an image using the specified model with base64 input.

    Send a base64 encoded image along with an edit prompt to get
    an edited image back.
    """
    # Validate model exists
    available_models = vram_manager.get_available_models(ModelType.IMG2IMG)
    if model not in available_models:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model}' not found. Available: {available_models}",
        )

    # Validate image is provided
    if not request.image:
        raise HTTPException(400, "image field required for JSON request")

    # Decode base64 image
    try:
        image_bytes = base64.b64decode(request.image)
        pil_image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Invalid base64 image")

    try:
        async with vram_manager.acquire_gpu(model) as model_instance:
            logger.info(
                f"Img2img request: model={model}, prompt={request.prompt[:50]}..."
            )

            result_image = await asyncio.to_thread(
                model_instance.edit, request, pil_image
            )

            # Convert to PNG bytes
            buffer = io.BytesIO()
            result_image.save(buffer, format="PNG")
            buffer.seek(0)

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        logger.exception("Img2img edit failed")
        raise HTTPException(status_code=500, detail=f"Edit failed: {e}")


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
    model: str = Path(..., description="Model name (e.g., 'qwen-image-edit')"),
    image: UploadFile = File(..., description="Input image to edit"),
    prompt: str = Form(..., description="Edit instruction"),
    negative_prompt: str = Form(" ", description="Negative prompt"),
    num_inference_steps: int = Form(20, description="Number of inference steps"),
    true_cfg_scale: float = Form(4.0, description="CFG scale"),
    seed: int | None = Form(None, description="Random seed (-1 or None for random)"),
    width: int | None = Form(None, description="Output width (defaults to input image width)"),
    height: int | None = Form(None, description="Output height (defaults to input image height)"),
):
    """Edit an image using the specified model with multipart upload.

    Upload an image file along with an edit prompt to get
    an edited image back.
    """
    # Validate model exists
    available_models = vram_manager.get_available_models(ModelType.IMG2IMG)
    if model not in available_models:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model}' not found. Available: {available_models}",
        )

    # Read and validate image
    contents = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Invalid image file")

    request = Img2ImgRequest(
        prompt=prompt,
        negative_prompt=negative_prompt,
        num_inference_steps=num_inference_steps,
        true_cfg_scale=true_cfg_scale,
        seed=seed,
        width=width,
        height=height,
    )

    try:
        async with vram_manager.acquire_gpu(model) as model_instance:
            logger.info(
                f"Img2img request: model={model}, prompt={request.prompt[:50]}..."
            )

            result_image = await asyncio.to_thread(
                model_instance.edit, request, pil_image
            )

            # Convert to PNG bytes
            buffer = io.BytesIO()
            result_image.save(buffer, format="PNG")
            buffer.seek(0)

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        logger.exception("Img2img edit failed")
        raise HTTPException(status_code=500, detail=f"Edit failed: {e}")
