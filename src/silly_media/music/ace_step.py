"""ACE-Step music generation models (v1.0 - 3.5B DiT)."""

import gc
import glob
import logging
import random
import uuid
from pathlib import Path
from typing import Callable

import torch

from .base import BaseMusicModel
from .schemas import MusicGenerateRequest

logger = logging.getLogger(__name__)


class AceStepFastModel(BaseMusicModel):
    """ACE-Step v1 Fast - 27-step inference (~1.7s per minute of audio)."""

    model_id = "ace-step-fast"
    display_name = "ACE-Step Fast (27 steps)"
    estimated_vram_gb = 8.0
    default_steps = 27

    def __init__(self) -> None:
        super().__init__()
        self._pipeline = None
        self._music_dir = Path("data/music")
        self._music_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> None:
        if self._loaded:
            return

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        from acestep.pipeline_ace_step import ACEStepPipeline

        logger.info(f"Loading ACE-Step pipeline ({self.display_name})...")
        self._pipeline = ACEStepPipeline(
            checkpoint_dir=None,  # Auto-downloads ACE-Step-v1-3.5B to HF cache
            device_id=0,
            dtype="bfloat16",
            torch_compile=False,
            cpu_offload=False,
        )

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        logger.info("Unloading ACE-Step model...")

        if self._pipeline is not None:
            del self._pipeline
            self._pipeline = None

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        self._loaded = False
        logger.info("ACE-Step model unloaded")

    def generate(
        self,
        request: MusicGenerateRequest,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[dict]:
        """Generate music using ACE-Step pipeline."""
        if not self._loaded or self._pipeline is None:
            raise RuntimeError("Model not loaded")

        steps = request.inference_steps or self.default_steps
        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)

        job_id = str(uuid.uuid4())[:8]
        save_dir = self._music_dir / job_id
        save_dir.mkdir(parents=True, exist_ok=True)

        # ACE-Step v1.0 expects comma-separated tags as the prompt
        # The caption from the user should already be in tag format
        # We append musical metadata as additional tags
        prompt = request.caption
        if request.bpm:
            prompt += f", {request.bpm} bpm"
        if request.keyscale:
            prompt += f", {request.keyscale}"

        # Handle lyrics
        lyrics = request.lyrics or ""
        if request.instrumental and not lyrics:
            lyrics = "[instrumental]"

        logger.info(
            f"Generating music: prompt='{prompt[:100]}', "
            f"duration={request.duration}s, steps={steps}, seed={seed}, "
            f"guidance_scale={request.guidance_scale}"
        )

        # Call the pipeline with all supported parameters
        result = self._pipeline(
            prompt=prompt,
            lyrics=lyrics,
            audio_duration=request.duration,
            infer_step=steps,
            guidance_scale=request.guidance_scale,
            scheduler_type=request.scheduler_type,
            cfg_type="apg",
            omega_scale=request.omega_scale,
            guidance_interval=0.5,
            guidance_interval_decay=0.0,
            min_guidance_scale=3.0,
            manual_seeds=[seed + i for i in range(request.batch_size)],
            use_erg_tag=True,
            use_erg_lyric=True,
            use_erg_diffusion=True,
            format=request.audio_format.value,
            save_path=str(save_dir),
            batch_size=request.batch_size,
        )

        # Collect output audio files
        audios = []
        audio_ext = f".{request.audio_format.value}"
        audio_files = sorted(glob.glob(str(save_dir / f"*{audio_ext}")))

        if not audio_files:
            # Fallback: look for any audio files
            for ext in [".wav", ".flac", ".mp3"]:
                audio_files = sorted(glob.glob(str(save_dir / f"*{ext}")))
                if audio_files:
                    break

        for i, audio_path in enumerate(audio_files):
            audios.append({
                "path": audio_path,
                "index": i,
                "seed": seed + i,
                "sample_rate": 48000,
                "job_id": job_id,
            })

        if not audios:
            raise RuntimeError("No audio files generated")

        logger.info(f"Generated {len(audios)} audio file(s) in {save_dir}")
        return audios


class AceStepQualityModel(AceStepFastModel):
    """ACE-Step v1 Quality - 60-step inference (~3.8s per minute of audio)."""

    model_id = "ace-step-quality"
    display_name = "ACE-Step Quality (60 steps)"
    estimated_vram_gb = 8.0
    default_steps = 60
