"""Qwen-Image-2.1 (Uncensored, GGUF) — text-to-image and image editing in one model."""

import gc
import logging
import math
from typing import TYPE_CHECKING, Any, Callable

import torch
from PIL import Image

from ..utils import drop_tree_cache, repo_cached
from .base import BaseImageModel

if TYPE_CHECKING:
    from ..img2img.schemas import Img2ImgRequest
    from ..schemas import GenerateRequest

logger = logging.getLogger(__name__)

GGUF_REPO = "abenzerps/Qwen-Image-2.1-Uncensored-GGUF"
GGUF_FILENAME = "qwen-image-2.1-UC-Q8_0.gguf"  # 7.6GB; the 7B DiT is small enough for Q8
BASE_MODEL = "Qwen/Qwen-Image-2.1"  # text encoder, processor, VAE, scheduler (not the bf16 transformer)

# Viggle few-step distillation, applied unmerged at runtime (merging into bf16/GGUF
# drops part of the update). Needs its own scheduler config: the base one's
# shift_terminal=0.02 wrecks the last turbo step.
TURBO_REPO = "Viggle/Qwen-Image-2.1-viggle-turbo"
TURBO_LORA_FILENAME = "Qwen-Image-2.1-viggle-turbo-v0.3-6step-lora-r256.safetensors"

# Raw sigma nodes from the turbo model card; the pipeline applies its
# resolution-dependent shift on top, so they're passed as-is at every size. Step
# counts change only at the high-noise end, keeping 0.875/0.75/0.5/0.25.
TURBO_SIGMAS = {
    5: [1.0, 0.875, 0.75, 0.5, 0.25],
    6: [1.0, 0.9375, 0.875, 0.75, 0.5, 0.25],
    7: [1.0, 0.9583, 0.9167, 0.875, 0.75, 0.5, 0.25],
}
# 9-step hybrid: 7 turbo steps, then the base model finishes the last two.
HYBRID_SIGMAS = [1.0, 0.9583, 0.9167, 0.875, 0.75, 0.5, 0.25, 1 / 6, 1 / 12]
HYBRID_TURBO_STEPS = 7

# Official RGBA prompt format from the model card.
TRANSPARENT_TEMPLATE = (
    "This is an RGBA image with transparency. {prompt} "
    "The image has alpha channel and the background is transparent."
)

# Edits ignore the t2i RGBA template (it tends to erase the subject too); this plain
# instruction is what reliably turns a photo into a cutout. Added for transparent=True
# edits of opaque inputs whose prompt doesn't already ask for transparency. RGBA
# inputs keep their alpha without it.
EDIT_TRANSPARENT_SUFFIX = "Make the background transparent."

EDIT_DEFAULT_AREA = 1024 * 1024  # edits default to ~1MP at the primary image's aspect


def _dequantize_gguf_non_linear(model: torch.nn.Module) -> int:
    """Turn GGUF-packed params outside Linear layers into plain bf16 tensors.

    This GGUF stores the norm weights (txt_in.text_norm, every block's norm_q/norm_k)
    as BF16, and diffusers' GGUF loader keeps BF16 tensors as raw-byte GGUFParameters
    that only its GGUF Linear layers know how to dequantize. In a norm they'd be used
    as-is: twice as long (bytes, not values) and garbage. Returns how many were fixed.
    """
    from diffusers.quantizers.gguf.utils import GGUFParameter, dequantize_gguf_tensor

    fixed = 0
    for module in model.modules():
        if isinstance(module, torch.nn.Linear):
            continue
        for name, param in list(module.named_parameters(recurse=False)):
            if isinstance(param, GGUFParameter):
                value = dequantize_gguf_tensor(param).to(torch.bfloat16)
                setattr(module, name, torch.nn.Parameter(value, requires_grad=False))
                fixed += 1
    return fixed


def _patch_vision_patch_embed(text_encoder: Any) -> None:
    """Replace Qwen3-VL's patch-embed Conv3d with the equivalent matmul.

    Its kernel equals its stride, so it's a plain linear map over each flattened
    patch, but cuDNN has no usable bf16 Conv3d kernel for the shape and falls back to
    one that costs tens of seconds per edit condition image. The matmul gives the
    same result in about a millisecond (fix from Viggle's turbo demo Space).
    """
    patch_embed = text_encoder.model.visual.patch_embed
    proj = patch_embed.proj

    def forward(hidden_states):
        weight = proj.weight.reshape(proj.weight.shape[0], -1)
        out = hidden_states.to(weight.dtype).flatten(1) @ weight.T
        return out + proj.bias if proj.bias is not None else out

    patch_embed.forward = forward


def _dims_for_aspect(aspect: float, area: int = EDIT_DEFAULT_AREA, multiple: int = 32) -> tuple[int, int]:
    width = math.sqrt(area * aspect)
    height = width / aspect
    return (
        max(multiple, round(width / multiple) * multiple),
        max(multiple, round(height / multiple) * multiple),
    )


def _has_alpha(image: Image.Image) -> bool:
    if image.mode not in ("RGBA", "LA", "PA") and "transparency" not in image.info:
        return False
    return image.convert("RGBA").getchannel("A").getextrema()[0] < 255


class QwenImage21Model(BaseImageModel):
    """Qwen-Image-2.1 Uncensored: 7B single-stream DiT + Qwen3-VL-8B text encoder.

    One pipeline serves both /generate (text-to-image) and /img2img/edit (up to 10
    condition images), registered under the same name in both registries so the
    VRAM manager never reloads when switching between them.

    Memory: Q8_0 GGUF transformer (~7.6GB) + NF4 text encoder (~6GB, vision tower
    kept in bf16) under model CPU offload, so only one sits on the GPU at a time.
    """

    model_id = BASE_MODEL
    display_name = "Qwen Image 2.1 Uncensored"
    estimated_vram_gb = 10.0

    default_steps = 40
    default_cfg = 1.0  # trained to sample without guidance; >1 enables true CFG
    turbo_default_steps = 6
    max_side = 3072  # edit output cap; 2K presets reach ~2.7-3K on the long side

    supports_transparency = True
    supports_alpha_input = True
    supports_reference_images = True
    max_reference_images = 9  # plus the primary image = the model's 10-image limit

    def __init__(self):
        super().__init__()
        self._pipe: Any = None
        self._base_scheduler: Any = None
        self._turbo_scheduler: Any = None
        self._lora_loaded = False
        self._lora_active = False

    @classmethod
    def weights_cached(cls) -> bool:
        """True when both the GGUF file and the base repo snapshot are on disk."""
        from huggingface_hub import try_to_load_from_cache

        gguf = try_to_load_from_cache(GGUF_REPO, GGUF_FILENAME)
        return isinstance(gguf, str) and repo_cached(BASE_MODEL)

    def load(self) -> None:
        if self._loaded:
            return

        from diffusers import GGUFQuantizationConfig, QwenImage21Pipeline
        from diffusers.models import QwenImage21Transformer2DModel
        from huggingface_hub import hf_hub_download
        from transformers import BitsAndBytesConfig, Qwen3VLForConditionalGeneration

        local_only = self.weights_cached()
        logger.info(f"Loading {self.display_name} ({GGUF_FILENAME}, local_only={local_only})...")

        gguf_path = hf_hub_download(GGUF_REPO, GGUF_FILENAME, local_files_only=local_only)
        transformer = QwenImage21Transformer2DModel.from_single_file(
            gguf_path,
            quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            torch_dtype=torch.bfloat16,
            config=BASE_MODEL,  # only the transformer's config.json, not its weights
            subfolder="transformer",
            local_files_only=local_only,
        )
        fixed = _dequantize_gguf_non_linear(transformer)
        logger.info(f"Dequantized {fixed} GGUF norm weights to bf16")

        # NF4 rather than 8-bit: bnb 8-bit modules can't change device, which the
        # offload hooks need. The vision tower stays bf16 (small, and it encodes the
        # edit condition images); lm_head is listed because a custom skip list
        # replaces the default one.
        text_encoder = Qwen3VLForConditionalGeneration.from_pretrained(
            BASE_MODEL,
            subfolder="text_encoder",
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                llm_int8_skip_modules=["visual", "lm_head"],
            ),
            dtype=torch.bfloat16,
            local_files_only=local_only,
        )

        # Only the component folders were downloaded (the 14GB bf16 transformer is
        # replaced by the GGUF); drop the cached tree listing so hub's completeness
        # check doesn't refuse the offline load over the missing folder.
        if local_only:
            drop_tree_cache(BASE_MODEL)

        self._pipe = QwenImage21Pipeline.from_pretrained(
            BASE_MODEL,
            transformer=transformer,
            text_encoder=text_encoder,
            dtype=torch.bfloat16,
            local_files_only=local_only,
        )
        # A full 2K decode needs >17GB, so tiling stays on, but the VAE's default
        # 256px tiles (16x16 latents, 64px overlap) leave visible seams and magenta
        # streaks (also in the alpha channel) at any size above 256px. 1024px tiles
        # with 256px overlap remove them; a 1K image decodes in a single tile.
        self._pipe.vae.enable_tiling(
            tile_sample_min_height=1024,
            tile_sample_min_width=1024,
            tile_sample_stride_height=768,
            tile_sample_stride_width=768,
        )
        self._pipe.enable_model_cpu_offload()
        self._base_scheduler = self._pipe.scheduler
        _patch_vision_patch_embed(text_encoder)

        self._loaded = True
        logger.info(f"{self.display_name} loaded")

    def _load_turbo(self) -> None:
        """Lazy-load the turbo LoRA (inactive) and its scheduler."""
        if self._lora_loaded:
            return

        from diffusers import FlowMatchEulerDiscreteScheduler
        from huggingface_hub import hf_hub_download

        logger.info(f"Loading turbo LoRA: {TURBO_REPO}")
        lora_path = hf_hub_download(TURBO_REPO, TURBO_LORA_FILENAME)
        self._pipe.load_lora_weights(lora_path, adapter_name="turbo")
        self._pipe.disable_lora()
        self._turbo_scheduler = FlowMatchEulerDiscreteScheduler.from_pretrained(
            TURBO_REPO, subfolder="scheduler"
        )
        self._lora_loaded = True
        self._lora_active = False
        logger.info("Turbo LoRA loaded (inactive)")

    def _set_turbo(self, on: bool) -> None:
        if on:
            self._load_turbo()
            if not self._lora_active:
                # set_adapters only selects the adapter; it doesn't undo disable_lora().
                self._pipe.set_adapters(["turbo"], adapter_weights=[1.0])
                self._pipe.enable_lora()
                self._lora_active = True
            self._pipe.scheduler = self._turbo_scheduler
        else:
            if self._lora_active:
                self._pipe.disable_lora()
                self._lora_active = False
            self._pipe.scheduler = self._base_scheduler

    def unload(self) -> None:
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")
        if self._pipe is not None:
            self._pipe.remove_all_hooks()
            del self._pipe
            self._pipe = None
        self._base_scheduler = None
        self._turbo_scheduler = None
        self._lora_loaded = False
        self._lora_active = False
        self._loaded = False

        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        logger.info(f"{self.display_name} unloaded")

    def resolve_steps(self, steps: int | None, use_lora: bool) -> int:
        """Effective step count (turbo snaps to its published schedules)."""
        if not use_lora:
            return steps or self.default_steps
        steps = steps or self.turbo_default_steps
        if steps >= 8:
            return len(HYBRID_SIGMAS)
        return min(max(steps, 5), 7)

    def progress_total(self, request: Any) -> int:
        """Real step count for the progress bar, for either request type."""
        return self.resolve_steps(request.num_inference_steps, getattr(request, "use_lora", False))

    def _run(
        self,
        *,
        prompt: str,
        negative_prompt: str | None,
        images: list[Image.Image] | None,
        width: int,
        height: int,
        steps: int | None,
        cfg: float | None,
        use_lora: bool,
        transparent: bool,
        seed: int | None,
        progress_callback: Callable | None,
        wrap_transparent: bool = True,
    ) -> Image.Image:
        if not self._loaded or self._pipe is None:
            raise RuntimeError("Model not loaded")

        self._set_turbo(use_lora)
        steps = self.resolve_steps(steps, use_lora)
        hybrid = use_lora and steps == len(HYBRID_SIGMAS)

        kwargs: dict[str, Any] = {
            "prompt": TRANSPARENT_TEMPLATE.format(prompt=prompt) if transparent and wrap_transparent else prompt,
            "width": width,
            "height": height,
            "num_inference_steps": steps,
        }
        if images:
            kwargs["image"] = images

        if use_lora:
            # Turbo is distilled for no CFG and no negative prompt.
            cfg = 1.0
            kwargs["sigmas"] = HYBRID_SIGMAS if hybrid else TURBO_SIGMAS[steps]
        else:
            cfg = self.default_cfg if cfg is None else cfg
            if cfg > 1.0:
                # The pipeline silently skips CFG without a negative prompt.
                kwargs["negative_prompt"] = negative_prompt or " "
        kwargs["true_cfg_scale"] = cfg

        if seed is not None and seed >= 0:
            kwargs["generator"] = torch.Generator(device="cuda").manual_seed(seed)

        transformer = self._pipe.transformer
        orig_forward = transformer.forward
        reextract = [False]
        if hybrid:
            # The prefix (text + condition image) K/V are cached on step 0 and came
            # from the turbo weights, so the first base-model step re-extracts them.
            def forward(*args, kv_cache_mode=None, **kw):
                if reextract[0] and kv_cache_mode == "cached":
                    kv_cache_mode, reextract[0] = "extract", False
                return orig_forward(*args, kv_cache_mode=kv_cache_mode, **kw)

            transformer.forward = forward

        def on_step_end(pipe, step, timestep, callback_kwargs):
            if hybrid and step == HYBRID_TURBO_STEPS - 1:
                pipe.disable_lora()
                reextract[0] = True
            if progress_callback is not None:
                return progress_callback(pipe, step, timestep, callback_kwargs)
            return callback_kwargs

        kwargs["callback_on_step_end"] = on_step_end

        logger.info(
            f"Qwen-Image-2.1: {width}x{height}, steps={steps}{' (hybrid)' if hybrid else ''}, "
            f"cfg={cfg}, turbo={use_lora}, transparent={transparent}, "
            f"condition_images={len(images) if images else 0}"
        )
        try:
            # Not torch.inference_mode(): the offload hooks move weights to the GPU
            # inside the call, which would turn them into inference tensors, and peft
            # then can't toggle requires_grad when the turbo adapter is switched (the
            # hybrid does that mid-call). The pipeline already runs under no_grad.
            image = self._pipe(**kwargs).images[0]
        finally:
            if hybrid:
                transformer.forward = orig_forward
                self._pipe.enable_lora()

        # The VAE always decodes RGBA. Keep alpha only when asked, so every other
        # caller still gets the plain RGB image other models return.
        if transparent:
            return image.convert("RGBA")
        if image.mode == "RGBA":
            background = Image.new("RGB", image.size, (255, 255, 255))
            background.paste(image, mask=image.getchannel("A"))
            return background
        return image.convert("RGB")

    def generate(
        self,
        request: "GenerateRequest",
        progress_callback: Callable | None = None,
    ) -> Image.Image:
        return self._run(
            prompt=request.prompt,
            negative_prompt=request.negative_prompt,
            images=None,
            width=request.width,
            height=request.height,
            steps=request.num_inference_steps,
            cfg=request.cfg_scale,
            use_lora=request.use_lora,
            transparent=getattr(request, "transparent", False),
            seed=request.seed,
            progress_callback=progress_callback,
        )

    def edit(
        self,
        request: "Img2ImgRequest",
        image: Image.Image,
        progress_callback: Callable | None = None,
        reference_images: list[Image.Image] | None = None,
    ) -> Image.Image:
        """Edit `image` (= "image 1" in the prompt); references become image 2, 3, ..."""
        images = [image, *(reference_images or [])]

        # Without explicit sizes the pipeline follows the LAST condition image's
        # aspect; pin the output to the primary image instead (~1MP).
        if request.width and request.height:
            width, height = request.width, request.height
        else:
            aspect = image.size[0] / image.size[1]
            if request.width:
                width, height = request.width, round(request.width / aspect)
            elif request.height:
                width, height = round(request.height * aspect), request.height
            else:
                width, height = _dims_for_aspect(aspect)
        width, height = max(32, width // 32 * 32), max(32, height // 32 * 32)

        input_alpha = _has_alpha(image)
        prompt = request.prompt
        if request.transparent and not input_alpha and "transparent" not in prompt.lower():
            prompt = f"{prompt.rstrip()} {EDIT_TRANSPARENT_SUFFIX}"

        return self._run(
            prompt=prompt,
            negative_prompt=request.negative_prompt.strip() or None,
            images=images,
            width=width,
            height=height,
            steps=request.num_inference_steps,
            cfg=request.true_cfg_scale,
            use_lora=request.use_lora,
            transparent=request.transparent or input_alpha,
            seed=request.seed,
            progress_callback=progress_callback,
            wrap_transparent=False,
        )
