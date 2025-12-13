"""HunyuanVideo 1.5 model implementation."""

import base64
import gc
import io
import logging
import random
import uuid
from pathlib import Path
from typing import Any, Callable

import torch
from PIL import Image

from .base import BaseVideoModel
from .schemas import I2VRequest, T2VRequest

logger = logging.getLogger(__name__)


class HunyuanVideoModel(BaseVideoModel):
    """HunyuanVideo 1.5 model supporting both T2V and I2V with official distilled models."""

    # Official distilled model IDs from hunyuanvideo-community (no LoRA needed!)
    # These have distillation baked in for fast 6-step inference
    model_id_t2v = "hunyuanvideo-community/HunyuanVideo-1.5-Diffusers-480p_t2v_distilled"
    model_id_i2v = "hunyuanvideo-community/HunyuanVideo-1.5-Diffusers-480p_i2v_step_distilled"

    model_id = model_id_t2v  # Default for compatibility
    display_name = "HunyuanVideo 1.5 Distilled"
    estimated_vram_gb = 16.0
    default_steps = 6  # Distilled models work best with 6 steps

    def __init__(self) -> None:
        super().__init__()
        self._pipe_t2v: Any = None
        self._pipe_i2v: Any = None
        self._current_mode: str | None = None  # "t2v" or "i2v"
        self._videos_dir = Path("data/videos")
        self._videos_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> None:
        """Load T2V pipeline by default."""
        if self._loaded:
            return
        self._load_t2v()
        self._loaded = True

    def _load_t2v(self) -> None:
        """Load T2V distilled pipeline for fast generation."""
        from diffusers import HunyuanVideo15Pipeline

        # Clear any lingering VRAM before loading
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        # Log current VRAM state
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM before T2V load: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")

        logger.info(f"Loading HunyuanVideo 1.5 T2V distilled pipeline from {self.model_id_t2v}...")
        self._pipe_t2v = HunyuanVideo15Pipeline.from_pretrained(
            self.model_id_t2v,
            torch_dtype=torch.bfloat16,
        )

        # Use sequential CPU offload for lower VRAM (slower but fits in 24GB)
        self._pipe_t2v.enable_sequential_cpu_offload()

        # Enable memory optimizations - critical for VAE decoding
        self._pipe_t2v.vae.enable_tiling()
        self._pipe_t2v.vae.enable_slicing()
        self._current_mode = "t2v"

        # Log VRAM after load
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM after T2V load: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")
        logger.info("HunyuanVideo T2V distilled pipeline loaded")

    def _load_i2v(self) -> None:
        """Load I2V distilled pipeline for image-to-video generation."""
        from diffusers import HunyuanVideo15ImageToVideoPipeline

        # Unload T2V first
        if self._pipe_t2v is not None:
            logger.info("Unloading T2V pipeline to load I2V...")
            del self._pipe_t2v
            self._pipe_t2v = None

        # Clear any lingering VRAM before loading
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        # Log current VRAM state
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM before I2V load: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")

        logger.info(f"Loading HunyuanVideo 1.5 I2V distilled pipeline from {self.model_id_i2v}...")
        self._pipe_i2v = HunyuanVideo15ImageToVideoPipeline.from_pretrained(
            self.model_id_i2v,
            torch_dtype=torch.bfloat16,
        )

        # Use sequential CPU offload for lower VRAM (slower but fits in 24GB)
        self._pipe_i2v.enable_sequential_cpu_offload()
        self._pipe_i2v.vae.enable_tiling()
        self._pipe_i2v.vae.enable_slicing()
        self._current_mode = "i2v"

        # Log VRAM after load
        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(f"VRAM after I2V load: {allocated:.2f}GB allocated, {reserved:.2f}GB reserved")
        logger.info("HunyuanVideo I2V distilled pipeline loaded")

    def _ensure_t2v(self) -> None:
        """Ensure T2V pipeline is loaded."""
        if self._current_mode == "t2v" and self._pipe_t2v is not None:
            return

        # Unload I2V if loaded
        if self._pipe_i2v is not None:
            logger.info("Switching from I2V to T2V pipeline...")
            del self._pipe_i2v
            self._pipe_i2v = None
            torch.cuda.empty_cache()
            gc.collect()

        self._load_t2v()

    def _ensure_i2v(self) -> None:
        """Ensure I2V pipeline is loaded."""
        if self._current_mode == "i2v" and self._pipe_i2v is not None:
            return
        self._load_i2v()

    def unload(self) -> None:
        """Unload all pipelines from VRAM."""
        logger.info("Unloading HunyuanVideo pipelines...")

        if self._pipe_t2v is not None:
            del self._pipe_t2v
            self._pipe_t2v = None

        if self._pipe_i2v is not None:
            del self._pipe_i2v
            self._pipe_i2v = None

        self._current_mode = None
        torch.cuda.empty_cache()
        gc.collect()
        self._loaded = False
        logger.info("HunyuanVideo pipelines unloaded")

    def _get_dimensions(self, resolution: str, aspect_ratio: str) -> tuple[int, int]:
        """Get width/height based on resolution and aspect ratio.

        Returns (width, height) tuple.
        """
        base = 480 if resolution == "480p" else 720

        # Map aspect ratios to multipliers
        if aspect_ratio == "16:9":
            # Landscape: width > height
            width = (base * 16) // 9
            # Round to nearest multiple of 16 for model compatibility
            width = (width // 16) * 16
            height = base
        elif aspect_ratio == "9:16":
            # Portrait: height > width
            width = base
            height = (base * 16) // 9
            height = (height // 16) * 16
        else:  # 1:1
            width = base
            height = base

        return width, height

    def _resize_image_for_resolution(
        self, image: Image.Image, resolution: str
    ) -> Image.Image:
        """Resize image to match target resolution, preserving aspect ratio.

        The shorter side (width or height) is scaled to match the resolution:
        - 480p -> shorter side = 480
        - 720p -> shorter side = 720

        This ensures the image fits the video frame while maintaining aspect ratio.
        """
        target_short_side = 480 if resolution == "480p" else 720

        width, height = image.size

        # Determine which side is shorter
        if width <= height:
            # Width is shorter (portrait or square)
            new_width = target_short_side
            new_height = int(height * (target_short_side / width))
        else:
            # Height is shorter (landscape)
            new_height = target_short_side
            new_width = int(width * (target_short_side / height))

        # Round to multiples of 16 for model compatibility
        new_width = (new_width // 16) * 16
        new_height = (new_height // 16) * 16

        # Only resize if needed
        if width != new_width or height != new_height:
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            logger.info(f"Resized input image from {width}x{height} to {new_width}x{new_height}")

        return image

    def _save_video(
        self, frames: list[Image.Image], fps: int, job_id: str | None = None
    ) -> Path:
        """Save video frames to MP4 and generate thumbnail.

        Args:
            frames: List of PIL Image frames
            fps: Frames per second
            job_id: Optional job ID for filename

        Returns:
            Path to saved video file
        """
        from diffusers.utils import export_to_video

        if job_id is None:
            job_id = str(uuid.uuid4())[:8]

        output_path = self._videos_dir / f"{job_id}.mp4"
        export_to_video(frames, str(output_path), fps=fps)
        logger.info(f"Video saved to {output_path}")

        # Save first frame as thumbnail
        thumbnail_path = self._videos_dir / f"{job_id}_thumb.jpg"
        if frames and isinstance(frames[0], Image.Image):
            frames[0].save(thumbnail_path, "JPEG", quality=85)
            logger.info(f"Thumbnail saved to {thumbnail_path}")

        return output_path

    def generate_t2v(
        self,
        request: T2VRequest,
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        """Generate video from text prompt only.

        Args:
            request: T2V generation request
            progress_callback: Diffusers-style callback for progress updates

        Returns:
            Path to generated video file
        """
        self._ensure_t2v()

        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)
        generator = torch.Generator(device="cuda").manual_seed(seed)

        width, height = self._get_dimensions(
            request.resolution.value, request.aspect_ratio.value
        )

        logger.info(
            f"Generating T2V: {width}x{height}, {request.num_frames} frames, "
            f"{request.num_inference_steps} steps, guidance={request.guidance_scale}, seed={seed}"
        )

        # HunyuanVideo15Pipeline uses a guider object instead of guidance_scale parameter
        if hasattr(self._pipe_t2v, "guider") and self._pipe_t2v.guider is not None:
            self._pipe_t2v.guider = self._pipe_t2v.guider.new(
                guidance_scale=request.guidance_scale
            )

        # Note: HunyuanVideo15Pipeline doesn't support callback_on_step_end
        output = self._pipe_t2v(
            prompt=request.prompt,
            height=height,
            width=width,
            num_frames=request.num_frames,
            num_inference_steps=request.num_inference_steps,
            generator=generator,
        )

        frames = output.frames[0]
        job_id = str(uuid.uuid4())[:8]
        return self._save_video(frames, request.fps, job_id)

    def generate_i2v(
        self,
        request: I2VRequest,
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        """Generate video from image + text prompt.

        Args:
            request: I2V generation request with base64 image
            progress_callback: Diffusers-style callback for progress updates

        Returns:
            Path to generated video file
        """
        self._ensure_i2v()

        # Decode base64 image
        image_bytes = base64.b64decode(request.image)
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Resize image to match target resolution
        image = self._resize_image_for_resolution(image, request.resolution.value)

        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)
        generator = torch.Generator(device="cuda").manual_seed(seed)

        # Get dimensions from the resized image
        width, height = image.size

        logger.info(
            f"Generating I2V: {width}x{height}, {request.num_frames} frames, "
            f"{request.num_inference_steps} steps, guidance={request.guidance_scale}, seed={seed}"
        )

        # HunyuanVideo15ImageToVideoPipeline uses a guider object instead of guidance_scale parameter
        if hasattr(self._pipe_i2v, "guider") and self._pipe_i2v.guider is not None:
            self._pipe_i2v.guider = self._pipe_i2v.guider.new(
                guidance_scale=request.guidance_scale
            )

        # Note: HunyuanVideo15ImageToVideoPipeline doesn't support callback_on_step_end
        output = self._pipe_i2v(
            prompt=request.prompt,
            image=image,
            num_frames=request.num_frames,
            num_inference_steps=request.num_inference_steps,
            generator=generator,
        )

        frames = output.frames[0]
        job_id = str(uuid.uuid4())[:8]
        return self._save_video(frames, request.fps, job_id)
