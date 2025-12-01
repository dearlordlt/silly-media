"""Z-Image-Turbo model implementation."""

import logging
from typing import TYPE_CHECKING, Any

import torch
from PIL import Image

from .base import BaseImageModel

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)


class ZImageTurboModel(BaseImageModel):
    """Tongyi-MAI/Z-Image-Turbo text-to-image model.

    Fast turbo model with only 8-9 inference steps needed.
    Supports bilingual text rendering (English/Chinese).
    """

    model_id = "Tongyi-MAI/Z-Image-Turbo"
    display_name = "Z-Image Turbo"

    # Turbo model uses fixed low step count and no guidance
    default_steps = 9
    default_cfg = 0.0  # Turbo models use guidance_scale=0

    def __init__(self):
        super().__init__()
        self._pipe: Any = None

    def load(self) -> None:
        """Load the Z-Image-Turbo pipeline."""
        if self._loaded:
            return

        from diffusers import ZImagePipeline

        logger.info(f"Loading {self.model_id}...")

        self._pipe = ZImagePipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        )
        self._pipe.to("cuda")

        self._loaded = True
        logger.info(f"{self.model_id} loaded successfully")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        if self._pipe is not None:
            # Move to CPU first to release CUDA memory
            self._pipe.to("cpu")
            del self._pipe
            self._pipe = None

        # Aggressive CUDA cleanup
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

        # Turbo model: use its optimal settings
        # Override steps if user didn't specify (turbo works best with 9)
        steps = request.num_inference_steps if request.num_inference_steps else self.default_steps

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={steps}, cfg={self.default_cfg} (turbo)"
        )

        result = self._pipe(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt or None,
            num_inference_steps=steps,
            guidance_scale=self.default_cfg,  # Turbo needs 0.0
            width=request.width,
            height=request.height,
            generator=generator,
        )

        return result.images[0]
