"""ACE-Step 1.5 music generation models (hybrid LM + DiT)."""

import gc
import logging
import random
import uuid
from pathlib import Path
from typing import Callable

import torch

from .base import BaseMusicModel
from .schemas import MusicGenerateRequest

logger = logging.getLogger(__name__)

# ACE-Step 1.5 repo root inside the Docker container
ACE_STEP_ROOT = "/app/ace-step-1.5"


class AceStepModel(BaseMusicModel):
    """ACE-Step v1.5 Turbo - 8-step inference, waveform-based VAE."""

    model_id = "ace-step"
    display_name = "ACE-Step 1.5 Turbo (8 steps)"
    estimated_vram_gb = 6.0
    default_steps = 8
    config_path = "acestep-v15-turbo"

    def __init__(self) -> None:
        super().__init__()
        self._dit_handler = None
        self._llm_handler = None
        self._music_dir = Path("data/music")
        self._music_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> None:
        if self._loaded:
            return

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        logger.info(f"Loading {self.display_name}...")

        from acestep.handler import AceStepHandler

        self._dit_handler = AceStepHandler()
        status, ok = self._dit_handler.initialize_service(
            project_root=ACE_STEP_ROOT,
            config_path=self.config_path,
        )
        logger.info(f"ACE-Step init: {status} (ok={ok})")

        if not ok:
            self._dit_handler = None
            raise RuntimeError(f"ACE-Step model failed to initialize: {status}")

        # LLM handler - create but don't initialize (DiT-only mode)
        from acestep.llm_inference import LLMHandler

        self._llm_handler = LLMHandler()

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        logger.info("Unloading ACE-Step 1.5 model...")

        if self._dit_handler is not None:
            for attr in ("model", "vae", "text_encoder", "text_tokenizer"):
                if hasattr(self._dit_handler, attr):
                    obj = getattr(self._dit_handler, attr)
                    if obj is not None:
                        del obj
                        setattr(self._dit_handler, attr, None)
            del self._dit_handler
            self._dit_handler = None

        if self._llm_handler is not None:
            del self._llm_handler
            self._llm_handler = None

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        self._loaded = False
        logger.info("ACE-Step 1.5 model unloaded")

    def generate(
        self,
        request: MusicGenerateRequest,
        progress_callback: Callable[[int, int], None] | None = None,
    ) -> list[dict]:
        """Generate music using ACE-Step 1.5 pipeline."""
        if not self._loaded or self._dit_handler is None:
            raise RuntimeError("Model not loaded")

        from acestep.inference import GenerationConfig, GenerationParams, generate_music

        steps = request.inference_steps or self.default_steps
        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)

        job_id = str(uuid.uuid4())[:8]
        save_dir = self._music_dir / job_id
        save_dir.mkdir(parents=True, exist_ok=True)

        # Build lyrics
        lyrics = request.lyrics or ""
        if request.instrumental and not lyrics:
            lyrics = "[Instrumental]"

        logger.info(
            f"Generating music: caption='{request.caption[:100]}', "
            f"duration={request.duration}s, steps={steps}, seed={seed}, "
            f"guidance_scale={request.guidance_scale}"
        )

        params = GenerationParams(
            caption=request.caption,
            lyrics=lyrics,
            instrumental=request.instrumental,
            duration=request.duration,
            inference_steps=steps,
            guidance_scale=request.guidance_scale,
            seed=seed,
            thinking=False,  # DiT-only mode (no LLM needed)
        )

        # Set optional musical metadata
        if request.bpm is not None:
            params.bpm = request.bpm
        if request.keyscale:
            params.keyscale = request.keyscale
        if request.timesignature:
            params.timesignature = request.timesignature

        config = GenerationConfig(
            batch_size=request.batch_size,
            audio_format=request.audio_format.value,
        )

        result = generate_music(
            dit_handler=self._dit_handler,
            llm_handler=self._llm_handler,
            params=params,
            config=config,
            save_dir=str(save_dir),
        )

        if not result.success:
            raise RuntimeError(f"Generation failed: {result.error}")

        # Collect results
        audios = []
        for i, audio in enumerate(result.audios):
            audio_path = audio.get("path", "")
            if not audio_path:
                continue
            audios.append({
                "path": audio_path,
                "index": i,
                "seed": seed + i,
                "sample_rate": audio.get("sample_rate", 48000),
                "job_id": job_id,
            })

        if not audios:
            # Fallback: scan save_dir for audio files
            for ext in (".wav", ".flac", ".mp3"):
                found = sorted(save_dir.glob(f"*{ext}"))
                if found:
                    for i, f in enumerate(found):
                        audios.append({
                            "path": str(f),
                            "index": i,
                            "seed": seed + i,
                            "sample_rate": 48000,
                            "job_id": job_id,
                        })
                    break

        if not audios:
            raise RuntimeError("No audio files generated")

        logger.info(f"Generated {len(audios)} audio file(s) in {save_dir}")
        return audios


class AceStepQualityModel(AceStepModel):
    """ACE-Step v1.5 SFT - 50-step inference, supports CFG for higher quality."""

    model_id = "ace-step-quality"
    display_name = "ACE-Step 1.5 Quality (50 steps)"
    estimated_vram_gb = 6.0
    default_steps = 50
    config_path = "acestep-v15-sft"
