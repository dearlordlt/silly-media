"""Z-Image-Turbo model implementation."""

import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

import torch
from PIL import Image

from ..config import settings
from ..loras import LoraStackMixin
from .base import BaseImageModel

if TYPE_CHECKING:
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)


class ZImageLoraMixin(LoraStackMixin):
    """Stacked user LoRAs for the Z-Image pipelines (legacy flat data/loras dir).

    Files are handed to diffusers by path so its ZImageLoraLoaderMixin converts
    Civitai/ComfyUI-style checkpoints (diffusion_model.*.lora_A) itself.
    """

    lora_family = "z-image"

    def _load_user_lora(self, path: Path, adapter: str) -> None:
        self._pipe.load_lora_weights(str(path), adapter_name=adapter)


class ZImageTurboModel(ZImageLoraMixin, BaseImageModel):
    """Tongyi-MAI/Z-Image-Turbo text-to-image model.

    Fast turbo model with only 8-9 inference steps needed.
    Supports bilingual text rendering (English/Chinese).
    """

    model_id = "Tongyi-MAI/Z-Image-Turbo"
    display_name = "Z-Image Turbo"

    # Turbo model uses fixed low step count and no guidance
    default_steps = 9
    default_cfg = 0.0  # Turbo models use guidance_scale=0
    # Stock turbo ignores request cfg_scale entirely; fine-tune subclasses that
    # support guidance (e.g. PM at cfg 1.5) opt in by flipping this.
    honor_cfg = False

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
        # Keep only the active submodule on GPU; rest stays on CPU.
        # Frees ~12-16GB during VAE decode so we survive desktop GPU contention.
        # NOTE: do NOT call .to("cuda") when using offload — accelerate manages placement.
        self._pipe.enable_model_cpu_offload()
        self._pipe.vae.enable_tiling()  # keep tiling; trims the VAE-decode activation peak

        self._loaded = True
        logger.info(f"{self.model_id} loaded successfully")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        if self._pipe is not None:
            # With model CPU offload, idle weights already live on CPU and
            # accelerate hooks own device placement — just drop the pipe.
            del self._pipe
            self._pipe = None
        self._reset_lora_state()

        # Aggressive CUDA cleanup
        import gc
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.model_id} unloaded")

    def generate(self, request: "GenerateRequest", progress_callback: Callable | None = None) -> Image.Image:
        """Generate an image from the request."""
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        self._sync_loras(request.loras)

        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        # Turbo model: use its optimal settings
        # Override steps if user didn't specify (turbo works best with 9)
        steps = request.num_inference_steps if request.num_inference_steps else self.default_steps
        cfg = self.default_cfg
        if self.honor_cfg and request.cfg_scale is not None:
            cfg = request.cfg_scale

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={steps}, cfg={cfg} (turbo)"
        )

        result = self._pipe(
            prompt=self._prompt_with_triggers(request.prompt),
            negative_prompt=request.negative_prompt or None,
            num_inference_steps=steps,
            guidance_scale=cfg,
            width=request.width,
            height=request.height,
            generator=generator,
            callback_on_step_end=progress_callback,
        )

        return result.images[0]


class ZImageModel(ZImageLoraMixin, BaseImageModel):
    """Tongyi-MAI/Z-Image text-to-image model.

    Standard model with full Classifier-Free Guidance support.
    Requires 28-50 steps for optimal quality (default: 30).
    Supports negative prompts and CFG scale 3.0-5.0 (default: 4.0).
    """

    model_id = "Tongyi-MAI/Z-Image"
    display_name = "Z-Image"

    # Standard model with full CFG
    default_steps = 30
    default_cfg = 4.0  # Middle of recommended 3.0-5.0 range

    def __init__(self):
        super().__init__()
        self._pipe: Any = None

    def load(self) -> None:
        """Load the Z-Image pipeline."""
        if self._loaded:
            return

        from diffusers import ZImagePipeline

        logger.info(f"Loading {self.model_id}...")

        self._pipe = ZImagePipeline.from_pretrained(
            self.model_id,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        )
        # Keep only the active submodule on GPU; rest stays on CPU.
        # Frees ~12-16GB during VAE decode so we survive desktop GPU contention.
        # NOTE: do NOT call .to("cuda") when using offload — accelerate manages placement.
        self._pipe.enable_model_cpu_offload()
        self._pipe.vae.enable_tiling()  # keep tiling; trims the VAE-decode activation peak

        self._loaded = True
        logger.info(f"{self.model_id} loaded successfully")

    def unload(self) -> None:
        """Unload the model from memory."""
        if not self._loaded:
            return

        if self._pipe is not None:
            # With model CPU offload, idle weights already live on CPU and
            # accelerate hooks own device placement — just drop the pipe.
            del self._pipe
            self._pipe = None
        self._reset_lora_state()

        # Aggressive CUDA cleanup
        import gc
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.model_id} unloaded")

    def generate(self, request: "GenerateRequest", progress_callback: Callable | None = None) -> Image.Image:
        """Generate an image from the request."""
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        self._sync_loras(request.loras)

        generator = None
        if request.seed is not None and request.seed >= 0:
            generator = torch.Generator(device="cuda").manual_seed(request.seed)

        # Use standard model settings with full CFG support
        steps = request.num_inference_steps if request.num_inference_steps else self.default_steps
        cfg = request.cfg_scale if request.cfg_scale is not None else self.default_cfg

        logger.info(
            f"Generating image: {request.width}x{request.height}, "
            f"steps={steps}, cfg={cfg}"
        )

        result = self._pipe(
            prompt=self._prompt_with_triggers(request.prompt),
            negative_prompt=request.negative_prompt or None,
            num_inference_steps=steps,
            guidance_scale=cfg,
            width=request.width,
            height=request.height,
            generator=generator,
            callback_on_step_end=progress_callback,
        )

        return result.images[0]


class ZImageTurboPMModel(ZImageTurboModel):
    """PornMaster V3.5 fine-tune of Z-Image-Turbo (civitai model 2270401).

    The Civitai checkpoint is a transformer-only single file; text encoder,
    VAE, and scheduler are reused from the stock Z-Image-Turbo repo. Runs
    turbo-style (9 steps, guidance off) but honors cfg_scale if the request
    sets one — the author recommends up to cfg 1.5 with negative prompts.
    """

    model_id = "civitai/PornMaster-Z-Image-Turbo-V3.5"
    display_name = "Z-Image Turbo PM"
    checkpoint_file = "z-image-turbo-pm.safetensors"

    honor_cfg = True

    @classmethod
    def checkpoint_path(cls) -> Path:
        return Path(settings.checkpoint_dir) / cls.checkpoint_file

    def load(self) -> None:
        """Load the stock Z-Image-Turbo pipeline with the PM transformer swapped in."""
        if self._loaded:
            return

        from diffusers import ZImagePipeline, ZImageTransformer2DModel

        path = self.checkpoint_path()
        if not path.is_file():
            raise RuntimeError(
                f"Checkpoint not found: {path} — download it to data/checkpoints first"
            )

        logger.info(f"Loading {self.display_name} from {path}...")

        transformer = ZImageTransformer2DModel.from_single_file(
            str(path), torch_dtype=torch.bfloat16
        )
        self._pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            transformer=transformer,
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=False,
        )
        # Same VRAM strategy as the stock models: offload idle submodules.
        self._pipe.enable_model_cpu_offload()
        self._pipe.vae.enable_tiling()

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")
