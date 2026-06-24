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


class Krea2TurboModel(BaseImageModel):
    """Krea-2-Turbo (12B single-stream MMDiT) text-to-image model.

    The 8-step distilled ("TDM") checkpoint, so guidance is disabled
    (guidance_scale=0.0). The 12B transformer is quantized to FP8 weight-only at load
    (~24.76GB BF16 -> ~12GB). To fit the desktop-shared 24GB GPU, generate() never keeps
    the transformer and the bf16 Qwen3-VL text encoder on the GPU at the same time: it
    encodes the prompt with the text encoder on GPU (transformer parked on CPU), then
    moves the transformer back to GPU to denoise (text encoder parked on CPU).
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
        from torchao.quantization import Float8WeightOnlyConfig
        from transformers import AutoConfig, Qwen2TokenizerFast, Qwen3VLModel

        logger.info(f"Loading {self.display_name} with FP8 (E4M3) weight-only quantization...")

        # Quantize the 12B transformer to FP8 weight-only as it loads. diffusers'
        # TorchAoConfig takes a torchao AOBaseConfig instance (not a string).
        quant_config = TorchAoConfig(Float8WeightOnlyConfig())
        transformer = Krea2Transformer2DModel.from_pretrained(
            BASE_MODEL,
            subfolder="transformer",
            quantization_config=quant_config,
            torch_dtype=torch.bfloat16,
        )

        # Build the Qwen3-VL text encoder ourselves so we can patch its config.
        # transformers 4.57.x doesn't migrate the new `rope_parameters` RoPE schema to the
        # legacy `rope_scaling` for Qwen3-VL's nested text_config, so the rotary embedding
        # crashes on `config.rope_scaling.get(...)`. Backfill rope_scaling first.
        te_config = AutoConfig.from_pretrained(BASE_MODEL, subfolder="text_encoder")
        for name in (None, "text_config", "vision_config"):
            cfg = te_config if name is None else getattr(te_config, name, None)
            if cfg is None:
                continue
            rope_params = getattr(cfg, "rope_parameters", None)
            if rope_params and getattr(cfg, "rope_scaling", None) is None:
                cfg.rope_scaling = dict(rope_params)
        text_encoder = Qwen3VLModel.from_pretrained(
            BASE_MODEL,
            subfolder="text_encoder",
            config=te_config,
            torch_dtype=torch.bfloat16,
        )

        # Build the tokenizer ourselves too. The repo only ships the fast `tokenizer.json`
        # (no vocab.json/merges.txt), and its tokenizer_config stores `extra_special_tokens`
        # as a list, which transformers 4.57.x's slow Qwen2Tokenizer can't consume. Force
        # the fast tokenizer and drop the malformed field (the special tokens still come
        # from tokenizer.json, so nothing is lost).
        tokenizer = Qwen2TokenizerFast.from_pretrained(
            BASE_MODEL,
            subfolder="tokenizer",
            extra_special_tokens={},
        )

        # The repo's model_index declares the slow `Qwen2Tokenizer`, but it ships only the fast
        # tokenizer files — so diffusers' class check rejects our (correct, functional) fast
        # tokenizer. Bypass that one check for the tokenizer while assembling; the passed
        # object is still used as-is.
        from diffusers.pipelines import pipeline_utils as _pu

        _orig_check = getattr(_pu, "maybe_raise_or_warn", None)

        def _skip_tokenizer_check(*args, **kwargs):
            name = kwargs.get("name", args[5] if len(args) > 5 else None)
            if name == "tokenizer":
                return
            return _orig_check(*args, **kwargs)

        try:
            if _orig_check is not None:
                _pu.maybe_raise_or_warn = _skip_tokenizer_check
            # Build the pipeline around the quantized transformer + patched text encoder/tokenizer.
            self._pipe = Krea2Pipeline.from_pretrained(
                BASE_MODEL,
                transformer=transformer,
                text_encoder=text_encoder,
                tokenizer=tokenizer,
                torch_dtype=torch.bfloat16,
            )
        finally:
            if _orig_check is not None:
                _pu.maybe_raise_or_warn = _orig_check

        # VRAM strategy for the desktop-shared 24GB GPU: the FP8 transformer (~12GB) and the
        # bf16 text encoder (~9GB) must never sit on the GPU at once. accelerate's offload
        # can't relocate the torchao FP8 transformer's Float8Tensor storage, so generate()
        # manages placement manually (encode with text encoder on GPU / transformer on CPU,
        # then denoise with transformer on GPU / text encoder on CPU). The small VAE stays
        # resident on GPU. Modules load on CPU; generate() moves them as needed.
        self._pipe.vae.enable_tiling()  # trims the Qwen-Image VAE-decode activation peak
        self._pipe.vae.to("cuda")
        self._pipe.text_encoder.to("cpu")
        self._pipe.transformer.to("cpu")

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

        pipe = self._pipe
        device = torch.device("cuda")

        # Phase 1 — encode the prompt with the text encoder on GPU while the transformer is
        # parked on CPU, so the two large modules never coexist on the shared 24GB card.
        # (With guidance disabled (cfg=0.0) the negative prompt is ignored, so we only encode
        # the positive prompt.)
        pipe.transformer.to("cpu")
        torch.cuda.empty_cache()
        pipe.text_encoder.to(device)
        with torch.inference_mode():
            prompt_embeds, prompt_embeds_mask = pipe.encode_prompt(
                prompt=request.prompt,
                device=device,
                num_images_per_prompt=1,
                max_sequence_length=512,
            )
        pipe.text_encoder.to("cpu")
        torch.cuda.empty_cache()

        # Phase 2 — denoise with the transformer back on GPU using the precomputed embeddings.
        # Detach the (CPU) text encoder so the pipeline's execution device resolves to CUDA;
        # the prompt_embeds path never touches text_encoder, so this is safe.
        pipe.transformer.to(device)
        saved_text_encoder = pipe.text_encoder
        pipe.text_encoder = None
        try:
            with torch.inference_mode():
                result = pipe(
                    prompt_embeds=prompt_embeds,
                    prompt_embeds_mask=prompt_embeds_mask,
                    num_inference_steps=steps,
                    guidance_scale=cfg,
                    width=request.width,
                    height=request.height,
                    generator=generator,
                    callback_on_step_end=progress_callback,
                )
        finally:
            pipe.text_encoder = saved_text_encoder

        return result.images[0]
