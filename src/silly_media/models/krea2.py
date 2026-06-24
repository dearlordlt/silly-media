"""Krea-2-Turbo model implementation with on-the-fly FP8 quantization."""

import gc
import logging
from typing import TYPE_CHECKING, Any, Callable

import torch
from PIL import Image

from .base import BaseImageModel

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)

# Official gated Krea 2 Turbo checkpoint (requires HF_TOKEN + license acceptance).
BASE_MODEL = "krea/Krea-2-Turbo"

# FP8 (E4M3) weight-only quant identifier for diffusers TorchAoConfig. The 4090 (Ada)
# supports FP8 E4M3 natively. If a torchao/diffusers version rejects this string, the
# fallbacks "float8wo" / "float8_weight_only" select the same scheme.
FP8_QUANT_TYPE = "float8wo_e4m3"


class Krea2TurboModel(BaseImageModel):
    """Krea-2-Turbo (12B single-stream MMDiT) text-to-image model.

    The 8-step distilled ("TDM") checkpoint, so guidance is disabled
    (guidance_scale=0.0). The transformer is quantized to FP8 weight-only at load
    (~24.76GB BF16 -> ~12GB) so it fits the desktop-shared 24GB GPU; the Qwen-Image
    VAE and Qwen3-VL text encoder stay bf16 and are CPU-offloaded between steps.
    """

    model_id = BASE_MODEL
    display_name = "Krea 2 Turbo"
    estimated_vram_gb = 14.0

    # Distilled turbo: few steps, guidance disabled.
    default_steps = 8
    default_cfg = 0.0

    def __init__(self):
        super().__init__()
        self._pipe: Any = None

    def load(self) -> None:
        """Load the Krea-2-Turbo pipeline with FP8-quantized transformer."""
        if self._loaded:
            return

        from diffusers import Krea2Pipeline, TorchAoConfig
        from diffusers.models import Krea2Transformer2DModel

        logger.info(f"Loading {self.display_name} with FP8 ({FP8_QUANT_TYPE}) quantization...")

        # Quantize the 12B transformer to FP8 weight-only as it loads.
        quant_config = TorchAoConfig(FP8_QUANT_TYPE)
        transformer = Krea2Transformer2DModel.from_pretrained(
            BASE_MODEL,
            subfolder="transformer",
            quantization_config=quant_config,
            torch_dtype=torch.bfloat16,
        )

        # Build the pipeline around the quantized transformer; VAE + text encoder bf16.
        self._pipe = Krea2Pipeline.from_pretrained(
            BASE_MODEL,
            transformer=transformer,
            torch_dtype=torch.bfloat16,
        )

        # Keep only the active submodule on GPU; rest stays on CPU.
        # NOTE: do NOT call .to("cuda") when using offload — accelerate manages placement.
        self._pipe.enable_model_cpu_offload()
        self._pipe.vae.enable_tiling()  # trims the Qwen-Image VAE-decode activation peak

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        if self._pipe is not None:
            # With model CPU offload, idle weights already live on CPU and
            # accelerate hooks own device placement — just drop the pipe.
            del self._pipe
            self._pipe = None

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.display_name} unloaded")

    def generate(
        self,
        request: "GenerateRequest",
        progress_callback: Callable | None = None,
    ) -> Image.Image:
        """Generate an image from the request."""
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        # Turbo: default to 8 steps / guidance disabled unless the caller overrides.
        steps = request.num_inference_steps if request.num_inference_steps else self.default_steps
        cfg = request.cfg_scale if request.cfg_scale is not None else self.default_cfg

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={steps}, cfg={cfg} (turbo)"
        )

        # With guidance disabled (cfg=0.0) the negative prompt is ignored by design.
        with torch.inference_mode():
            result = self._pipe(
                prompt=request.prompt,
                negative_prompt=request.negative_prompt or None,
                num_inference_steps=steps,
                guidance_scale=cfg,
                width=request.width,
                height=request.height,
                generator=generator,
                callback_on_step_end=progress_callback,
            )

        return result.images[0]
