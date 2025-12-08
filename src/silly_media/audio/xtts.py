"""XTTS-v2 text-to-speech model implementation."""

import gc
import logging
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Generator

import torch
import torchaudio

from .base import BaseAudioModel

if TYPE_CHECKING:
    from .schemas import TTSRequest

logger = logging.getLogger(__name__)


class XTTSv2Model(BaseAudioModel):
    """Coqui XTTS-v2 multilingual TTS with voice cloning.

    Zero-shot voice cloning from just 6 seconds of reference audio.
    Supports 17 languages with cross-lingual voice transfer.
    """

    model_id = "xtts-v2"
    display_name = "XTTS v2"
    supported_languages = [
        "en",  # English
        "es",  # Spanish
        "fr",  # French
        "de",  # German
        "it",  # Italian
        "pt",  # Portuguese
        "pl",  # Polish
        "tr",  # Turkish
        "ru",  # Russian
        "nl",  # Dutch
        "cs",  # Czech
        "ar",  # Arabic
        "zh-cn",  # Chinese
        "ja",  # Japanese
        "hu",  # Hungarian
        "ko",  # Korean
        "hi",  # Hindi
    ]
    sample_rate = 24000

    def __init__(self):
        super().__init__()
        self._tts: Any = None

    def load(self) -> None:
        """Load XTTS-v2 model."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        # Auto-agree to Coqui TOS (required for model download)
        import os

        os.environ["COQUI_TOS_AGREED"] = "1"

        from TTS.api import TTS

        # Load using high-level TTS API
        self._tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2")
        self._tts.to("cuda")

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        """Unload model from GPU."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        if self._tts is not None:
            # Move to CPU first
            try:
                self._tts.to("cpu")
            except Exception:
                pass  # Some models may not support .to()

            del self._tts
            self._tts = None

        # Aggressive cleanup
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.display_name} unloaded")

    def synthesize(
        self,
        request: "TTSRequest",
        speaker_wav_paths: list[str],
    ) -> bytes:
        """Synthesize speech and return WAV bytes."""
        if not self._loaded or self._tts is None:
            raise RuntimeError("Model not loaded")

        if not speaker_wav_paths:
            raise ValueError("At least one speaker reference audio file is required")

        logger.info(
            f"Synthesizing: {len(request.text)} chars, "
            f"lang={request.language}, refs={len(speaker_wav_paths)}"
        )

        # Use the first reference audio (XTTS can use multiple but API uses one)
        speaker_wav = speaker_wav_paths[0]

        # Generate audio
        wav = self._tts.tts(
            text=request.text,
            speaker_wav=speaker_wav,
            language=request.language,
            split_sentences=request.split_sentences,
        )

        # Convert to WAV bytes using temp file (torchcodec backend can't write to BytesIO)
        wav_tensor = torch.tensor(wav).unsqueeze(0)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)

        try:
            torchaudio.save(str(tmp_path), wav_tensor, self.sample_rate, format="wav")
            audio_bytes = tmp_path.read_bytes()
        finally:
            tmp_path.unlink(missing_ok=True)

        logger.info(f"Synthesis complete: {len(wav)} samples")

        return audio_bytes

    def _split_text_for_streaming(self, text: str) -> list[str]:
        """Split text into chunks suitable for XTTS streaming (max ~400 tokens).

        Uses simple sentence splitting to avoid spacy dependency.
        """
        import re

        # Split by sentence-ending punctuation
        sentences = re.split(r'(?<=[.!?])\s+', text.strip())

        # Merge short sentences, split long ones
        chunks = []
        current_chunk = ""
        max_chars = 250  # Conservative limit (~200-300 chars usually < 400 tokens)

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue

            # If sentence itself is too long, split on commas/semicolons
            if len(sentence) > max_chars:
                sub_parts = re.split(r'(?<=[,;:])\s+', sentence)
                for part in sub_parts:
                    part = part.strip()
                    if not part:
                        continue
                    if len(current_chunk) + len(part) + 1 <= max_chars:
                        current_chunk = f"{current_chunk} {part}".strip()
                    else:
                        if current_chunk:
                            chunks.append(current_chunk)
                        current_chunk = part
            elif len(current_chunk) + len(sentence) + 1 <= max_chars:
                current_chunk = f"{current_chunk} {sentence}".strip()
            else:
                if current_chunk:
                    chunks.append(current_chunk)
                current_chunk = sentence

        if current_chunk:
            chunks.append(current_chunk)

        return chunks if chunks else [text[:max_chars]]

    def synthesize_stream(
        self,
        request: "TTSRequest",
        speaker_wav_paths: list[str],
    ) -> Generator[bytes, None, None]:
        """Synthesize speech with streaming output.

        Long texts are automatically split into chunks to avoid XTTS 400 token limit.
        Uses simple sentence splitting (no spacy dependency).
        """
        if not self._loaded or self._tts is None:
            raise RuntimeError("Model not loaded")

        if not speaker_wav_paths:
            raise ValueError("At least one speaker reference audio file is required")

        # Split text into manageable chunks for streaming
        text_chunks = self._split_text_for_streaming(request.text)

        logger.info(
            f"Streaming synthesis: {len(request.text)} chars in {len(text_chunks)} chunks, "
            f"lang={request.language}, refs={len(speaker_wav_paths)}"
        )

        # Access the underlying model for streaming
        model = self._tts.synthesizer.tts_model

        # Get speaker conditioning from reference audio (once)
        gpt_cond_latent, speaker_embedding = model.get_conditioning_latents(
            audio_path=speaker_wav_paths
        )

        # Stream each text chunk
        for i, text_chunk in enumerate(text_chunks):
            logger.debug(f"Streaming chunk {i+1}/{len(text_chunks)}: {len(text_chunk)} chars")

            chunks = model.inference_stream(
                text_chunk,
                request.language,
                gpt_cond_latent,
                speaker_embedding,
                temperature=request.temperature,
                speed=request.speed,
                enable_text_splitting=False,
            )

            for chunk in chunks:
                chunk_tensor = chunk.unsqueeze(0).cpu()
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_path = Path(tmp.name)

                try:
                    torchaudio.save(str(tmp_path), chunk_tensor, self.sample_rate, format="wav")
                    yield tmp_path.read_bytes()
                finally:
                    tmp_path.unlink(missing_ok=True)

        logger.info("Streaming synthesis complete")
