"""Demucs vocal separation model with VRAM management."""

import gc
import logging
import tempfile
from pathlib import Path
from typing import Generator

import torch
import torchaudio

logger = logging.getLogger(__name__)


class DemucsModel:
    """Demucs model wrapper for vocal separation with VRAM management.

    This model separates audio into stems (vocals, drums, bass, other).
    We use it to isolate vocals from music for clean voice references.
    """

    model_id = "demucs"
    display_name = "Demucs (Vocal Separation)"

    def __init__(self):
        self._loaded = False
        self._model = None
        self._device = "cuda" if torch.cuda.is_available() else "cpu"

    @property
    def is_loaded(self) -> bool:
        return self._loaded

    def load(self) -> None:
        """Load demucs model into GPU memory."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        # Import demucs here to avoid loading at module level
        from demucs.pretrained import get_model

        # Load htdemucs model (best quality)
        self._model = get_model("htdemucs")
        self._model.to(self._device)
        self._model.eval()

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        """Unload model from GPU memory."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        if self._model is not None:
            # Move to CPU first
            try:
                self._model.to("cpu")
            except Exception:
                pass

            del self._model
            self._model = None

        # Aggressive cleanup
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.display_name} unloaded")

    def separate_vocals(self, audio_path: Path) -> tuple[torch.Tensor, int]:
        """Separate vocals from audio file.

        Args:
            audio_path: Path to input audio file

        Returns:
            Tuple of (vocals_waveform, sample_rate)
        """
        if not self._loaded or self._model is None:
            raise RuntimeError("Model not loaded")

        from demucs.apply import apply_model

        logger.info(f"Separating vocals: {audio_path}")

        # Load audio
        waveform, sample_rate = torchaudio.load(str(audio_path))

        # Demucs expects stereo at its sample rate (44100)
        target_sr = self._model.samplerate

        # Resample if needed
        if sample_rate != target_sr:
            resampler = torchaudio.transforms.Resample(sample_rate, target_sr)
            waveform = resampler(waveform)
            sample_rate = target_sr

        # Convert mono to stereo if needed
        if waveform.shape[0] == 1:
            waveform = waveform.repeat(2, 1)

        # Add batch dimension
        waveform = waveform.unsqueeze(0).to(self._device)

        # Apply separation
        with torch.no_grad():
            sources = apply_model(
                self._model,
                waveform,
                device=self._device,
                progress=False,
            )

        # sources shape: (batch, sources, channels, samples)
        # htdemucs sources: drums, bass, other, vocals (index 3)
        vocals = sources[0, 3]  # (channels, samples)

        logger.info(f"Vocals separated: {vocals.shape}")
        return vocals.cpu(), sample_rate

    def separate_vocals_to_file(
        self,
        audio_path: Path,
        output_path: Path,
    ) -> Path:
        """Separate vocals and save to file.

        Args:
            audio_path: Path to input audio file
            output_path: Path for output vocals file

        Returns:
            Path to saved vocals file
        """
        vocals, sample_rate = self.separate_vocals(audio_path)
        torchaudio.save(str(output_path), vocals, sample_rate)
        logger.info(f"Vocals saved: {output_path}")
        return output_path

    # Stub methods to satisfy Loadable protocol (not used for audio generation)
    def synthesize(self, request, speaker_wav_paths: list[str]) -> bytes:
        """Not implemented - demucs is for separation, not synthesis."""
        raise NotImplementedError("Demucs is for separation, not synthesis")

    def synthesize_stream(
        self, request, speaker_wav_paths: list[str]
    ) -> Generator[bytes, None, None]:
        """Not implemented - demucs is for separation, not synthesis."""
        raise NotImplementedError("Demucs is for separation, not synthesis")
