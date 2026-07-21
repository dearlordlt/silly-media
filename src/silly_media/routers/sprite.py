"""Non-pixel-art sprite / cutout generation API router.

Sibling to the pixelart router, but for hand-painted / realistic game assets:
the prompt is used verbatim (no pixel-art style injection), downscaling is smooth
(LANCZOS), any image model can be used, and non-square sizes are supported.
"""

import asyncio
import inspect
import io
import logging
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from ..progress import progress
from ..schemas import SpriteRequest
from ..utils.image_processing import process_sprite
from ..vram_manager import vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sprite", tags=["sprite"])


@router.get("/progress")
async def get_sprite_progress():
    """Get current sprite generation progress."""
    return progress.to_dict()


@router.post(
    "/generate",
    responses={
        200: {"content": {"image/png": {}}, "description": "Generated sprite image"},
        400: {"description": "Invalid request"},
        404: {"description": "Model not found"},
        500: {"description": "Generation failed"},
    },
)
async def generate_sprite(request: SpriteRequest):
    """Generate a non-pixel-art sprite / asset from a text prompt.

    Pipeline:
    1. Generate at full resolution with the chosen image model (prompt used as-is)
    2. Optionally remove the background via rembg (transparent cutout)
    3. Optionally smooth-downscale (LANCZOS) so the longest side == output_size

    Returns a PNG (RGBA, transparent if background removal is enabled).
    """
    start_time = time.time()

    try:
        async with vram_manager.acquire_gpu(request.model) as model_instance:
            logger.info(
                f"Sprite request: model={request.model}, "
                f"prompt=****, "
                f"gen_size={request.width}x{request.height}, "
                f"output_size={request.output_size}, remove_bg={request.remove_background}"
            )

            def progress_callback(pipe, step, timestep, callback_kwargs):
                progress.update(step + 1)
                return callback_kwargs

            # Best-effort total for the progress bar (cosmetic).
            total_steps = request.num_inference_steps or (9 if "turbo" in request.model else 30)
            progress.start(total_steps)

            try:
                # SpriteRequest is a GenerateRequest subclass with width/height
                # already resolved and get_inference_steps()/get_cfg_scale()
                # handling None, so pass it straight through (rebuilding a plain
                # GenerateRequest with explicit None values fails validation).
                # Some models (e.g. ovis) don't accept a progress callback.
                gen = model_instance.generate
                if "progress_callback" in inspect.signature(gen).parameters:
                    image = await asyncio.to_thread(gen, request, progress_callback)
                else:
                    image = await asyncio.to_thread(gen, request)
            finally:
                progress.finish()

            processed = await asyncio.to_thread(
                process_sprite,
                image,
                remove_bg=request.remove_background,
                output_size=request.output_size,
            )

            buffer = io.BytesIO()
            processed.save(buffer, format="PNG")
            buffer.seek(0)

            elapsed = time.time() - start_time
            logger.info(f"Sprite generated in {elapsed:.2f}s")

            return Response(content=buffer.getvalue(), media_type="image/png")

    except ValueError as e:
        # Unknown model id from vram_manager._ensure_loaded
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.exception("Sprite generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")
