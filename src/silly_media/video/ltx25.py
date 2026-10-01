"""LTX-2.5 Distilled video model (GGUF-quantized) with synchronized audio."""

import base64
import gc
import importlib
import io
import logging
import random
import uuid
from pathlib import Path
from typing import Any, Callable

import torch
from PIL import Image

from ..utils import drop_tree_cache, repo_cached
from .base import BaseVideoModel
from .schemas import I2VRequest, T2VRequest

logger = logging.getLogger(__name__)

GGUF_REPO = "Abiray/LTX-2.5-Distilled-GGUF"
# Q5_K_M after the offload-chain fix freed ~6GB (Q4_K_M audio had audible warble).
GGUF_FILENAME = "LTX-2.5-Distilled-Q5_K_M.gguf"  # 18.1GB file, ~15.6GB resident
BASE_MODEL = "Lightricks/LTX-2.5-Diffusers"  # gated: accept the license on HF first

# The distilled checkpoint was trained against this fixed 8-step sigma schedule
# (diffusers.pipelines.ltx2.utils.DISTILLED_SIGMA_VALUES, inlined so importing this
# module never requires diffusers). Step counts from the request are ignored.
DISTILLED_SIGMAS = [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875]

# VRAM ceiling on the desktop-shared 24GB card, expressed as a latent-token budget
# (tokens = W/32 x H/32 x ((frames-1)/8+1)) so 720p requests shrink to a shorter
# clip instead of crashing. Measured with the fixed offload chain on Q4 (13.5GB
# resident): 12.2k tokens peaked at 16.9GB; activations run ~0.24MB/token. With
# Q5_K_M (~15.6GB resident, +1.5GB VAE during i2v) 14k keeps peaks near ~21GB
# worst-case. 480p still reaches the full 241 frames (12.2k); 720p caps at ~4.7s.
MAX_LATENT_TOKENS = 14000

# The stock model_cpu_offload_seq is text_encoder->connectors->duration_head->
# transformer->vae->..., and a component is only evicted from the GPU when its
# SUCCESSOR in the chain runs. duration_head is parameterless and never invoked
# (we always pass num_frames), so its hook never fires and the 6.3GB connectors
# sat on the GPU through the whole denoise — and in i2v the VAE lingered too after
# encoding the conditioning image. Chain the heavy components directly in execution
# order (transformer's pre-hook evicts connectors; vae's evicts the transformer
# before decode) and park duration_head at the end where it can't block an eviction.
OFFLOAD_SEQ = "text_encoder->connectors->transformer->vae->audio_vae->vocoder->duration_head"


def _patch_ltx2_gguf_key_mapping() -> None:
    """Fix diffusers' LTX2 single-file conversion for LTX-2.5 checkpoints.

    The stock convert_ltx2_transformer_to_diffusers predates LTX-2.5's prompt-AdaLN
    modules: checkpoint keys `(audio_)prompt_adaln_single.*` are left unmapped, so the
    model's `(audio_)prompt_adaln.*` params stay on the meta device and from_single_file
    crashes in dispatch_model ("Cannot copy out of meta tensor"). Pre-rename them before
    the stock conversion runs; the single replace also covers audio_prompt_adaln_single,
    which contains the substring. Harmless once upstream learns the mapping (the renamed
    keys no longer match its "adaln_single" special-case).
    """
    from diffusers.loaders import single_file_model

    entry = single_file_model.SINGLE_FILE_LOADABLE_CLASSES.get("LTX2VideoTransformer3DModel")
    if entry is None or getattr(entry["checkpoint_mapping_fn"], "_ltx25_prompt_adaln_patch", False):
        return
    orig = entry["checkpoint_mapping_fn"]

    def patched(checkpoint, **kwargs):
        for key in list(checkpoint.keys()):
            if "prompt_adaln_single." in key:
                checkpoint[key.replace("prompt_adaln_single.", "prompt_adaln.")] = checkpoint.pop(key)
        return orig(checkpoint, **kwargs)

    patched._ltx25_prompt_adaln_patch = True
    entry["checkpoint_mapping_fn"] = patched


class LTX25VideoModel(BaseVideoModel):
    """LTX-2.5 Distilled (22B DiT) T2V/I2V model producing video with synced audio.

    Fits the desktop-shared 24GB GPU via three tricks:
    - the transformer is the Q4_K_M GGUF (15.7GB resident vs ~44GB bf16),
    - the Gemma 4 12B text encoder is quantized to NF4 (~7GB vs ~25GB bf16, which
      would never fit) — 4-bit rather than 8-bit because bnb 8-bit modules can't
      change device, which the offload hooks require,
    - enable_model_cpu_offload keeps only one component on the GPU at a time.
    T2V and I2V share every component: the I2V pipeline is a from_pipe() view over
    the T2V one, so mode switches never reload the GGUF.
    """

    model_id = BASE_MODEL
    display_name = "LTX-2.5 Distilled (GGUF)"
    estimated_vram_gb = 20.0  # measured: ~20.4GB process peak during 480p denoise
    default_steps = len(DISTILLED_SIGMAS)  # fixed schedule; request steps are ignored

    def __init__(self) -> None:
        super().__init__()
        self._pipe_t2v: Any = None
        self._pipe_i2v: Any = None
        self._armed: Any = None  # pipeline whose CPU-offload hooks are active
        self._videos_dir = Path("data/videos")
        self._videos_dir.mkdir(parents=True, exist_ok=True)

    @classmethod
    def weights_cached(cls) -> bool:
        """True when both the GGUF file and the base repo snapshot are on disk."""
        from huggingface_hub import try_to_load_from_cache

        gguf = try_to_load_from_cache(GGUF_REPO, GGUF_FILENAME)
        return isinstance(gguf, str) and repo_cached(BASE_MODEL)

    def load(self) -> None:
        if self._loaded:
            return

        from diffusers import DiffusionPipeline, GGUFQuantizationConfig, LTX2Pipeline
        from diffusers.models import LTX2VideoTransformer3DModel
        from huggingface_hub import hf_hub_download
        from transformers import BitsAndBytesConfig

        gc.collect()
        torch.cuda.empty_cache()

        # Same gated-repo gotcha as krea2: diffusers' shard loader hits the network on
        # every load even when fully cached, and a token that fell off the authorized
        # list turns that into a 403 that also clobbers refs/main. Load offline once
        # the weights are on disk.
        local_only = self.weights_cached()
        if local_only:
            logger.info(f"{BASE_MODEL} + GGUF found in local HF cache; loading offline")

        logger.info(f"Loading {self.display_name} ({GGUF_FILENAME})...")
        _patch_ltx2_gguf_key_mapping()
        gguf_path = hf_hub_download(GGUF_REPO, GGUF_FILENAME, local_files_only=local_only)
        transformer = LTX2VideoTransformer3DModel.from_single_file(
            gguf_path,
            quantization_config=GGUFQuantizationConfig(compute_dtype=torch.bfloat16),
            torch_dtype=torch.bfloat16,
            config=BASE_MODEL,  # only fetches the transformer's config.json, not weights
            subfolder="transformer",
            local_files_only=local_only,
        )

        # Resolve the text encoder class from the repo's model_index instead of
        # hardcoding it — the repo is gated, so the exact Gemma 4 class name couldn't
        # be pinned down at development time.
        pipe_config = DiffusionPipeline.load_config(BASE_MODEL, local_files_only=local_only)
        te_lib, te_class_name = pipe_config["text_encoder"]
        te_cls = getattr(importlib.import_module(te_lib), te_class_name)
        logger.info(f"Loading text encoder {te_class_name} in NF4...")
        text_encoder = te_cls.from_pretrained(
            BASE_MODEL,
            subfolder="text_encoder",
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
            ),
            dtype=torch.bfloat16,
            local_files_only=local_only,
        )

        # The bootstrap intentionally skips ~48GB of non-component folders
        # (transformer_full, latent_upsampler, distillation lora), but hub's snapshot
        # completeness check compares the cached tree *listing* against disk and
        # refuses local_files_only loads over those gaps. Drop the cached listing —
        # read_tree_cache returning None makes the check a no-op, and every component
        # the pipeline actually needs is on disk.
        if local_only:
            drop_tree_cache(BASE_MODEL)

        # Components passed in are excluded from the snapshot download, so this pulls
        # only the small parts (VAEs, vocoder, connectors, scheduler, tokenizer) — not
        # the ~44GB bf16 transformer folders. prompt_enhancer would be a second ~25GB
        # Gemma; skip it when the repo declares one.
        extra: dict[str, Any] = {}
        if "prompt_enhancer" in pipe_config:
            extra["prompt_enhancer"] = None
        self._pipe_t2v = LTX2Pipeline.from_pretrained(
            BASE_MODEL,
            transformer=transformer,
            text_encoder=text_encoder,
            torch_dtype=torch.bfloat16,
            local_files_only=local_only,
            **extra,
        )
        self._pipe_t2v.vae.enable_tiling()
        self._arm("t2v")

        if torch.cuda.is_available():
            allocated = torch.cuda.memory_allocated() / 1e9
            logger.info(f"VRAM after LTX-2.5 load: {allocated:.2f}GB allocated")
        self._loaded = True
        logger.info(f"{self.display_name} loaded")

    def _arm(self, mode: str) -> None:
        """Point the CPU-offload hooks at the requested pipeline (components shared)."""
        if mode == "i2v" and self._pipe_i2v is None:
            from diffusers import LTX2ImageToVideoPipeline

            # Not from_pipe(): it unconditionally dtype-casts the new pipeline
            # (default fp32), which is unsupported for the GGUF-quantized
            # transformer. Direct construction shares the components as-is.
            self._pipe_i2v = LTX2ImageToVideoPipeline(**self._pipe_t2v.components)

        target = self._pipe_t2v if mode == "t2v" else self._pipe_i2v
        if self._armed is target:
            return
        if self._armed is not None:
            self._armed.remove_all_hooks()
        target.model_cpu_offload_seq = OFFLOAD_SEQ
        target.enable_model_cpu_offload()
        self._armed = target
        logger.info(f"LTX-2.5 offload hooks armed for {mode}")

    def unload(self) -> None:
        logger.info(f"Unloading {self.display_name}...")
        for attr in ("_pipe_i2v", "_pipe_t2v"):
            pipe = getattr(self, attr)
            if pipe is not None:
                pipe.remove_all_hooks()
                setattr(self, attr, None)
        self._armed = None
        gc.collect()
        torch.cuda.empty_cache()
        torch.cuda.synchronize()
        self._loaded = False
        logger.info(f"{self.display_name} unloaded")

    @staticmethod
    def _snap_frames(n: int) -> int:
        """Frame counts must be 8k+1 (video VAE temporal compression is 8x)."""
        return max(9, ((n - 1) // 8) * 8 + 1)

    @staticmethod
    def _clamp_frames_to_vram(width: int, height: int, num_frames: int) -> int:
        """Shrink the clip if width x height x frames exceeds the VRAM token budget."""
        tokens_per_frame = (width // 32) * (height // 32)
        max_latent_frames = max(2, MAX_LATENT_TOKENS // tokens_per_frame)
        max_frames = (max_latent_frames - 1) * 8 + 1
        if num_frames > max_frames:
            logger.warning(
                f"Clamping {num_frames} frames to {max_frames} at {width}x{height} "
                f"(VRAM budget of {MAX_LATENT_TOKENS} latent tokens)"
            )
            return max_frames
        return num_frames

    def _get_dimensions(self, resolution: str, aspect_ratio: str) -> tuple[int, int]:
        """Width/height for resolution + aspect ratio, in the /32 grid the VAE needs."""
        base = 480 if resolution == "480p" else 736  # 736 = 720p rounded to /32

        if aspect_ratio == "16:9":
            width = ((base * 16) // 9 // 32) * 32
            height = base
        elif aspect_ratio == "9:16":
            width = base
            height = ((base * 16) // 9 // 32) * 32
        else:  # 1:1
            width = base
            height = base

        return width, height

    def _resize_image_for_resolution(self, image: Image.Image, resolution: str) -> Image.Image:
        """Scale so the short side matches the resolution, center-cropped to the /32 grid.

        Scale preserves the exact aspect ratio; the crop trims at most 31px per axis
        to land on the VAE's /32 grid — no squeeze, unlike snapping each axis
        independently (which distorted by up to ~3%).
        """
        target_short_side = 480 if resolution == "480p" else 736
        width, height = image.size

        scale = target_short_side / min(width, height)
        new_width = max(32, round(width * scale))
        new_height = max(32, round(height * scale))
        image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)

        crop_width = (new_width // 32) * 32
        crop_height = (new_height // 32) * 32
        left = (new_width - crop_width) // 2
        top = (new_height - crop_height) // 2
        image = image.crop((left, top, left + crop_width, top + crop_height))

        if (width, height) != (crop_width, crop_height):
            logger.info(
                f"Resized input image from {width}x{height} to {crop_width}x{crop_height} "
                f"(aspect preserved, center-cropped to /32)"
            )
        return image

    def _run(
        self,
        mode: str,
        call_kwargs: dict[str, Any],
        request: T2VRequest | I2VRequest,
        progress_callback: Callable | None,
    ) -> Path:
        self._arm(mode)

        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)
        num_frames = self._snap_frames(request.num_frames)
        num_frames = self._clamp_frames_to_vram(
            call_kwargs["width"], call_kwargs["height"], num_frames
        )
        logger.info(
            f"Generating {mode.upper()}: {call_kwargs.get('width')}x{call_kwargs.get('height')}, "
            f"{num_frames} frames @ {request.fps}fps, distilled {len(DISTILLED_SIGMAS)}-step "
            f"schedule, seed={seed}"
        )

        def _log_component_state(tag: str) -> None:
            if not torch.cuda.is_available():
                return
            devs = {}
            for comp in ("text_encoder", "transformer", "vae", "audio_vae", "connectors",
                         "duration_head", "vocoder"):
                mod = getattr(self._armed, comp, None)
                if mod is not None:
                    try:
                        p = list(mod.parameters())
                        size_gb = sum(x.numel() * x.element_size() for x in p) / 1e9
                        devs[comp] = f"{p[0].device.type}:{size_gb:.1f}GB"
                    except (StopIteration, IndexError):
                        pass
            logger.info(
                f"{tag} VRAM allocated={torch.cuda.memory_allocated()/1e9:.2f}GB {devs}"
            )

        _log_component_state("pre-call")

        try:
            with torch.inference_mode():
                # Distilled recipe: fixed sigmas, every guidance mode off. The __call__
                # defaults are the FULL model's (stg_scale=1.0, modality_scale=3.0, ...)
                # and each enabled mode adds a whole extra transformer pass per step —
                # leaving them on tripled step time and activation VRAM.
                output = self._armed(
                    **call_kwargs,
                    num_frames=num_frames,
                    frame_rate=float(request.fps),
                    sigmas=DISTILLED_SIGMAS,
                    guidance_scale=1.0,
                    audio_guidance_scale=1.0,
                    stg_scale=0.0,
                    audio_stg_scale=0.0,
                    modality_scale=1.0,
                    audio_modality_scale=1.0,
                    generator=torch.Generator(device="cuda").manual_seed(seed),
                    output_type="pil",
                    callback_on_step_end=progress_callback,
                )
        except Exception:
            _log_component_state("at-failure")
            raise

        job_id = str(uuid.uuid4())[:8]
        audio = output.audio if getattr(request, "audio", True) else None
        return self._save_video_with_audio(output.frames[0], audio, request.fps, job_id)

    def generate_t2v(
        self,
        request: T2VRequest,
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        width, height = self._get_dimensions(request.resolution.value, request.aspect_ratio.value)
        return self._run(
            "t2v",
            {"prompt": request.prompt, "width": width, "height": height},
            request,
            progress_callback,
        )

    def generate_i2v(
        self,
        request: I2VRequest,
        progress_callback: Callable[[Any, int, Any, dict], dict] | None = None,
    ) -> Path:
        image = Image.open(io.BytesIO(base64.b64decode(request.image))).convert("RGB")
        image = self._resize_image_for_resolution(image, request.resolution.value)
        width, height = image.size
        return self._run(
            "i2v",
            {"prompt": request.prompt, "image": image, "width": width, "height": height},
            request,
            progress_callback,
        )

    def _save_video_with_audio(
        self, frames: list[Image.Image], audio: Any, fps: int, job_id: str
    ) -> Path:
        """Mux frames + generated audio into an mp4, plus a first-frame thumbnail."""
        from diffusers.utils.export_utils import encode_video

        output_path = self._videos_dir / f"{job_id}.mp4"

        waveform = None
        if audio is not None and isinstance(audio, torch.Tensor):
            waveform = audio[0] if audio.ndim == 3 else audio  # -> [channels, samples]
            waveform = waveform.detach().float().cpu()

        encode_video(
            frames,
            fps=fps,
            output_path=str(output_path),
            audio=waveform,
            audio_sample_rate=int(self._pipe_t2v.vocoder.config.output_sampling_rate),
        )
        logger.info(f"Video saved to {output_path}")

        thumbnail_path = self._videos_dir / f"{job_id}_thumb.jpg"
        if frames and isinstance(frames[0], Image.Image):
            frames[0].save(thumbnail_path, "JPEG", quality=85)

        return output_path
