"""Vision API router."""

import asyncio
import io
import logging

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from PIL import Image

from ..vision import VisionRegistry
from ..vision.schemas import VisionRequest, VisionResponse
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/vision", tags=["vision"])


@router.get("/models")
async def list_vision_models():
    """List available vision models."""
    return {
        "available": VisionRegistry.get_available_models(),
        "loaded": [
            m
            for m in vram_manager.get_loaded_models()
            if vram_manager.get_model_info(m)
            and vram_manager.get_model_info(m).model_type == ModelType.VISION
        ],
    }


@router.post("/analyze", response_model=VisionResponse)
async def analyze_image(request: VisionRequest):
    """Analyze image with base64 input.

    Send a base64 encoded image along with a text query to get
    a text response from the vision model.
    """
    if not request.image:
        raise HTTPException(400, "image field required for JSON request")

    model_name = "qwen3-vl-8b"  # Default/only model for now

    async with vram_manager.acquire_gpu(model_name) as model:
        response = await asyncio.to_thread(model.analyze, request)

    return VisionResponse(response=response, model=model_name)


@router.post("/analyze/upload", response_model=VisionResponse)
async def analyze_image_upload(
    image: UploadFile = File(..., description="Image file to analyze"),
    query: str = Form(..., description="Question about the image"),
    max_tokens: int | None = Form(
        None, description="Max tokens (None = model default)"
    ),
    temperature: float = Form(0.7, description="Sampling temperature"),
):
    """Analyze image with multipart upload.

    Upload an image file along with a text query to get
    a text response from the vision model.
    """
    # Read and validate image
    contents = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        raise HTTPException(400, "Invalid image file")

    model_name = "qwen3-vl-8b"
    request = VisionRequest(query=query, max_tokens=max_tokens, temperature=temperature)

    async with vram_manager.acquire_gpu(model_name) as model:
        response = await asyncio.to_thread(model.analyze, request, pil_image)

    return VisionResponse(response=response, model=model_name)
