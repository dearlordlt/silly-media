"""Pixel art and icon generation API router."""

import asyncio
import io
import logging
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..progress import progress
from ..schemas import GenerateRequest, PixelArtRequest
from ..utils.image_processing import process_pixel_art
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pixelart", tags=["pixelart"])

# Fixed model for pixel art generation
PIXELART_MODEL = "z-image-turbo"
# Fixed generation size (1024 for best quality)
GENERATION_SIZE = 1024


@router.get("/progress")
async def get_pixelart_progress():
    """Get current pixel art generation progress."""
    return progress.to_dict()


@router.post(
    "/generate",
    responses={
        200: {"content": {"image/png": {}}, "description": "Generated pixel art image"},
        400: {"description": "Invalid request"},
        500: {"description": "Generation failed"},
    },
)
async def generate_pixelart(request: PixelArtRequest):
    """Generate pixel art / icon from text prompt.

    Generates a high-resolution image using Z-Image-Turbo, then:
    1. Optionally removes background using AI (rembg)
    2. Resizes to requested size using nearest-neighbor (keeps pixels sharp)

    Returns PNG with transparency support.
    """
    start_time = time.time()

    # Branching prompt enhancement based on mode
    if request.remove_background:
        # === MODE A: SPRITES (Characters, Items) ===
        # Isometric view, outlines, white background for clean rembg extraction
        enhanced_prompt = (
            f"{request.prompt}, pixel art style, "
            f"thick dark outlines, high contrast, minimalist, "
            f"isometric view, white background, centered, full shot, single object"
        )
    else:
        # === MODE B: TILES (Floors, Walls, Textures) ===
        # Top-down view, no outlines (breaks tiling), seamless pattern
        enhanced_prompt = (
            f"texture of {request.prompt}, pixel art style, "
            f"top down view, flat 2d, seamless pattern, "
            f"filling the frame, edge to edge, no border, no outlines"
        )

    try:
        async with vram_manager.acquire_gpu(PIXELART_MODEL) as model_instance:
            logger.info(
                f"Pixel art request: prompt={request.prompt[:50]}..., "
                f"output_size={request.size}x{request.size}, "
                f"remove_bg={request.remove_background}"
            )

            # Create progress callback
            def progress_callback(pipe, step, timestep, callback_kwargs):
                progress.update(step + 1)
                return callback_kwargs

            # Start progress tracking
            total_steps = request.num_inference_steps
            progress.start(total_steps)

            try:
                # Create a GenerateRequest for the model
                gen_request = GenerateRequest(
                    prompt=enhanced_prompt,
                    negative_prompt=request.negative_prompt,
                    num_inference_steps=request.num_inference_steps,
                    seed=request.seed,
                    width=GENERATION_SIZE,
                    height=GENERATION_SIZE,
                )

                # Generate at full resolution
                image = await asyncio.to_thread(
                    model_instance.generate, gen_request, progress_callback
                )
            finally:
                progress.finish()

            # Post-process: resize and optionally remove background
            processed = await asyncio.to_thread(
                process_pixel_art,
                image,
                size=request.size,
                remove_bg=request.remove_background,
            )

            # Convert to PNG bytes (PNG supports transparency)
            buffer = io.BytesIO()
            processed.save(buffer, format="PNG")
            buffer.seek(0)

            elapsed = time.time() - start_time
            logger.info(
                f"Pixel art generated in {elapsed:.2f}s "
                f"(final size: {request.size}x{request.size})"
            )

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        logger.exception("Pixel art generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
