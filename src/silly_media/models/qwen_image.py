"""Qwen-Image-2512 model implementation with GGUF quantization."""

import gc
import logging
from typing import TYPE_CHECKING, Any, Callable

import torch
from PIL import Image

from .base import BaseImageModel

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)

# Model paths
GGUF_REPO = "unsloth/Qwen-Image-2512-GGUF"
GGUF_FILENAME = "qwen-image-2512-Q5_K_M.gguf"
BASE_MODEL = "Qwen/Qwen-Image-2512"
TURBO_LORA_ID = "Wuli-art/Qwen-Image-2512-Turbo-LoRA"
TURBO_LORA_FILENAME = "Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V3.0-bf16.safetensors"


class QwenImage2512Model(BaseImageModel):
    """Qwen-Image-2512 text-to-image model with GGUF quantization.

    Features:
    - GGUF Q5_K_M quantization (~15GB VRAM)
    - Optional Turbo-LoRA for faster inference (4-8 steps instead of 50)
    """

    model_id = BASE_MODEL
    display_name = "Qwen Image 2512"
    estimated_vram_gb = 15.0

    # Default settings (no LoRA)
    default_steps = 50
    default_cfg = 4.0  # true_cfg_scale

    # Turbo-LoRA settings
    turbo_default_steps = 6
    turbo_default_cfg = 1.0

    def __init__(self):
        super().__init__()
        self._pipe: Any = None
        self._lora_loaded: bool = False
        self._lora_active: bool = False

    def load(self) -> None:
        """Load the Qwen-Image-2512 pipeline with GGUF quantization."""
        if self._loaded:
            return

        from diffusers import QwenImagePipeline, GGUFQuantizationConfig
        from diffusers.models import QwenImageTransformer2DModel
        from huggingface_hub import hf_hub_download

        logger.info(f"Loading {self.display_name} with GGUF Q5_K_M quantization...")

        # Download GGUF file
        gguf_path = hf_hub_download(
            repo_id=GGUF_REPO,
            filename=GGUF_FILENAME,
        )
        logger.info(f"GGUF file path: {gguf_path}")

        # Load transformer with GGUF quantization
        # Must specify config to point to the base model's transformer config
        gguf_config = GGUFQuantizationConfig(compute_dtype=torch.bfloat16)

        transformer = QwenImageTransformer2DModel.from_single_file(
            gguf_path,
            quantization_config=gguf_config,
            torch_dtype=torch.bfloat16,
            config=BASE_MODEL,
            subfolder="transformer",
        )

        # Create pipeline with quantized transformer
        self._pipe = QwenImagePipeline.from_pretrained(
            BASE_MODEL,
            transformer=transformer,
            torch_dtype=torch.bfloat16,
        )

        # Use CPU offloading for efficient VRAM usage
        self._pipe.enable_model_cpu_offload()

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def _load_turbo_lora(self) -> None:
        """Lazy-load Turbo LoRA weights."""
        if self._lora_loaded:
            return

        from huggingface_hub import hf_hub_download

        logger.info(f"Loading Turbo LoRA: {TURBO_LORA_ID}")

        # Download LoRA file
        lora_path = hf_hub_download(
            repo_id=TURBO_LORA_ID,
            filename=TURBO_LORA_FILENAME,
        )

        self._pipe.load_lora_weights(lora_path, adapter_name="turbo")
        self._pipe.disable_lora()  # Start disabled
        self._lora_loaded = True
        self._lora_active = False
        logger.info("Turbo LoRA loaded (inactive)")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        if self._pipe is not None:
            self._pipe.to("cpu")
            del self._pipe
            self._pipe = None

        self._lora_loaded = False
        self._lora_active = False
        self._loaded = False

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        logger.info(f"{self.display_name} unloaded")

    def generate(
        self,
        request: "GenerateRequest",
        progress_callback: Callable | None = None,
    ) -> Image.Image:
        """Generate an image from the request."""
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        # Handle LoRA based on request.use_lora
        use_lora = getattr(request, "use_lora", False)

        if use_lora:
            # Lazy-load LoRA if not already loaded
            self._load_turbo_lora()

            if not self._lora_active:
                logger.info("Activating Turbo LoRA")
                self._pipe.set_adapters(["turbo"], adapter_weights=[1.0])
                self._lora_active = True

            # Use turbo defaults
            steps = request.num_inference_steps or self.turbo_default_steps
            cfg = request.cfg_scale if request.cfg_scale is not None else self.turbo_default_cfg
        else:
            if self._lora_active:
                logger.info("Deactivating Turbo LoRA")
                self._pipe.disable_lora()
                self._lora_active = False

            # Use standard defaults
            steps = request.num_inference_steps or self.default_steps
            cfg = request.cfg_scale if request.cfg_scale is not None else self.default_cfg

        # Setup generator for reproducibility
        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={steps}, cfg={cfg}, use_lora={use_lora}"
        )

        # Build kwargs
        pipe_kwargs = {
            "prompt": request.prompt,
            "negative_prompt": request.negative_prompt or None,
            "num_inference_steps": steps,
            "true_cfg_scale": cfg,
            "width": request.width,
            "height": request.height,
            "generator": generator,
        }

        if progress_callback is not None:
            pipe_kwargs["callback_on_step_end"] = progress_callback

        with torch.inference_mode():
            result = self._pipe(**pipe_kwargs)

        return result.images[0]
