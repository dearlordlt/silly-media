"""ACE-Step 1.5 music generation models."""

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


class AceStepTurboModel(BaseMusicModel):
    """ACE-Step 1.5 Turbo - fast 8-step inference."""

    model_id = "ace-step-turbo"
    display_name = "ACE-Step 1.5 Turbo"
    estimated_vram_gb = 8.0
    default_steps = 8

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

        logger.info("Loading ACE-Step pipeline (Turbo)...")
        self._pipeline = ACEStepPipeline(
            checkpoint_dir=None,  # Auto-downloads to HF cache
            device_id=0,
            dtype="bfloat16",
            torch_compile=False,
            cpu_offload=False,
        )

        self._loaded = True
        logger.info("ACE-Step Turbo loaded successfully")

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

        # Build prompt from caption + musical metadata
        prompt = request.caption
        if request.bpm:
            prompt = f"bpm: {request.bpm}, {prompt}"
        if request.keyscale:
            prompt = f"key: {request.keyscale}, {prompt}"

        # Handle lyrics
        lyrics = request.lyrics
        if request.instrumental and not lyrics:
            lyrics = "[Instrumental]"

        logger.info(
            f"Generating music: prompt='{prompt[:80]}...', "
            f"duration={request.duration}s, steps={steps}, seed={seed}"
        )

        # Call the pipeline
        result = self._pipeline(
            prompt=prompt,
            lyrics=lyrics if lyrics else None,
            audio_duration=request.duration,
            infer_step=steps,
            guidance_scale=request.guidance_scale,
            manual_seeds=[seed + i for i in range(request.batch_size)],
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


class AceStepSFTModel(AceStepTurboModel):
    """ACE-Step 1.5 SFT - higher quality, 50 steps."""

    model_id = "ace-step-sft"
    display_name = "ACE-Step 1.5 SFT (Quality)"
    estimated_vram_gb = 8.0
    default_steps = 50
