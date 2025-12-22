"""Qwen-Image-Edit model implementation."""

import gc
import logging
from typing import Any, Callable

import torch
from PIL import Image

from .base import BaseImg2ImgModel
from .schemas import Img2ImgRequest

logger = logging.getLogger(__name__)

# Lightning LoRA for faster inference
LIGHTNING_LORA_ID = "lightx2v/Qwen-Image-Lightning"


class QwenImageEditModel(BaseImg2ImgModel):
    """Qwen-Image-Edit-2509-4bit image editing model."""

    model_id = "ovedrive/Qwen-Image-Edit-2509-4bit"
    display_name = "Qwen Image Edit"
    estimated_vram_gb = 20.0

    def __init__(self) -> None:
        super().__init__()
        self._pipe: Any = None
        self._lora_active: bool = False

    def load(self) -> None:
        """Load model into VRAM."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        from diffusers import QwenImageEditPlusPipeline

        self._pipe = QwenImageEditPlusPipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
        )
        # Use CPU offloading to reduce peak VRAM usage during inference
        self._pipe.enable_model_cpu_offload()

        # Load Lightning LoRA as named adapter (not fused - fusing breaks 4-bit models)
        logger.info(f"Loading Lightning LoRA: {LIGHTNING_LORA_ID}")
        self._pipe.load_lora_weights(LIGHTNING_LORA_ID, adapter_name="lightning")
        self._pipe.disable_lora()  # Start with LoRA disabled
        self._lora_active = False

        self._loaded = True
        logger.info(f"{self.display_name} loaded with Lightning LoRA")

    def unload(self) -> None:
        """Unload model from VRAM."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        if self._pipe is not None:
            self._pipe.to("cpu")
            del self._pipe
            self._pipe = None

        self._loaded = False

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        logger.info(f"{self.display_name} unloaded")

    def edit(
        self,
        request: Img2ImgRequest,
        image: Image.Image,
        progress_callback: Callable | None = None,
    ) -> Image.Image:
        """Edit an image based on the prompt.

        Args:
            request: Edit request with prompt and parameters
            image: Input PIL Image to edit
            progress_callback: Optional callback for progress updates

        Returns:
            Edited PIL Image
        """
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        # Ensure image is RGB
        if image.mode != "RGB":
            image = image.convert("RGB")

        # Use provided dimensions or fall back to original image size
        width = request.width if request.width is not None else image.size[0]
        height = request.height if request.height is not None else image.size[1]

        # Setup generator for reproducible results
        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        logger.info(
            f"Editing image: {image.size[0]}x{image.size[1]} -> {width}x{height}, "
            f"steps={request.num_inference_steps}, cfg={request.true_cfg_scale}, "
            f"use_lora={request.use_lora}, prompt={request.prompt[:50]}..."
        )

        # Handle LoRA enable/disable
        # Note: We don't fuse LoRA with 4-bit models - it causes hangs/issues
        # Note: Keep the default scheduler - EulerAncestral is not compatible with this pipeline
        if request.use_lora:
            if not self._lora_active:
                logger.info("Enabling Lightning LoRA")
                self._pipe.set_adapters(["lightning"], adapter_weights=[1.0])
                self._lora_active = True
        else:
            if self._lora_active:
                logger.info("Disabling Lightning LoRA")
                self._pipe.disable_lora()
                self._lora_active = False

        # Build pipeline kwargs
        pipe_kwargs = {
            "image": image,
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or " ",
            "num_inference_steps": request.num_inference_steps,
            "true_cfg_scale": request.true_cfg_scale,
            "generator": generator,
            "width": width,
            "height": height,
        }

        # Add progress callback if supported
        if progress_callback is not None:
            pipe_kwargs["callback_on_step_end"] = progress_callback

        with torch.inference_mode():
            result = self._pipe(**pipe_kwargs)

        return result.images[0]
