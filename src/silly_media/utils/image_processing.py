"""Image processing utilities for pixel art generation."""

import logging

from PIL import Image
from rembg import new_session, remove

logger = logging.getLogger(__name__)

# Pre-load rembg session at module load (runs on CPU)
# 'isnet-anime' is optimized for 2D/sprite art
_rembg_session = None


def _get_rembg_session():
    """Lazy-load rembg session on first use."""
    global _rembg_session
    if _rembg_session is None:
        # u2net is more general-purpose and works better for AI-generated images
        # isnet-anime was too aggressive and removed subjects along with backgrounds
        logger.info("Loading rembg session (u2net model)...")
        _rembg_session = new_session("u2net")
        logger.info("rembg session loaded")
    return _rembg_session


def resize_nearest_neighbor(image: Image.Image, size: int) -> Image.Image:
    """Resize image using nearest neighbor interpolation.

    Maintains sharp pixel edges, ideal for pixel art.

    Args:
        image: Input PIL Image
        size: Target size (square output)

    Returns:
        Resized PIL Image
    """
    return image.resize((size, size), Image.Resampling.NEAREST)


def remove_background(image: Image.Image) -> Image.Image:
    """Remove background using rembg AI model.

    Uses isnet-anime model (optimized for 2D/sprite art) running on CPU.

    Args:
        image: Input PIL Image

    Returns:
        PIL Image with RGBA mode and transparent background
    """
    session = _get_rembg_session()
    # alpha_matting=False is faster and better for hard pixel edges
    return remove(image, session=session, alpha_matting=False)


def process_pixel_art(
    image: Image.Image,
    size: int = 32,
    remove_bg: bool = True,
) -> Image.Image:
    """Full pixel art processing pipeline.

    1. Optionally remove background (before resize for better detection)
    2. Resize to target size using nearest neighbor

    Args:
        image: Input PIL Image (1024x1024 from model)
        size: Target output size (square)
        remove_bg: Whether to remove background

    Returns:
        Processed PIL Image (PNG-ready with transparency if enabled)
    """
    result = image

    # Step 1: Background removal (before resize for better subject detection)
    if remove_bg:
        logger.info("Removing background with rembg (u2net)...")
        result = remove_background(result)

    # Step 2: Resize with nearest neighbor
    logger.info(f"Resizing to {size}x{size} with nearest neighbor...")
    result = resize_nearest_neighbor(result, size)

    # Ensure RGBA for consistent output format
    if result.mode != "RGBA":
        result = result.convert("RGBA")

    return result
