"""Ovis-Image-7B model implementation."""

import logging
from typing import TYPE_CHECKING, Any

import torch
from PIL import Image

from .base import BaseImageModel

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)


class OvisImageModel(BaseImageModel):
    """AIDC-AI/Ovis-Image-7B text-to-image model."""

    model_id = "AIDC-AI/Ovis-Image-7B"
    display_name = "Ovis Image 7B"

    def __init__(self):
        super().__init__()
        self._pipe: Any = None

    def load(self) -> None:
        """Load the Ovis-Image pipeline."""
        if self._loaded:
            return

        from diffusers import OvisImagePipeline

        logger.info(f"Loading {self.model_id}...")

        self._pipe = OvisImagePipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
        )
        self._pipe.to("cuda")

        self._loaded = True
        logger.info(f"{self.model_id} loaded successfully")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        if self._pipe is not None:
            self._pipe.to("cpu")
            del self._pipe
            self._pipe = None

        import gc
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.model_id} unloaded")

    def generate(self, request: "GenerateRequest") -> Image.Image:
        """Generate an image from the request."""
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={request.get_inference_steps()}, cfg={request.get_cfg_scale()}"
        )

        result = self._pipe(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt or None,
            num_inference_steps=request.get_inference_steps(),
            true_cfg_scale=request.get_cfg_scale(),
            width=request.width,
            height=request.height,
            generator=generator,
        )

        return result.images[0]
