"""Maya TTS model implementation with voice description control.

Maya is a 3B parameter TTS model that uses natural language voice descriptions
instead of reference audio files. Supports 20+ emotion tags for expressive speech.

Model: maya-research/maya1
VRAM: ~16GB
Sample rate: 24kHz
Languages: English only
"""

import gc
import io
import logging
import wave
from typing import TYPE_CHECKING, Any, Generator

import numpy as np
import torch

from .base import BaseAudioModel

if TYPE_CHECKING:
    from .schemas import MayaTTSRequest

logger = logging.getLogger(__name__)

# Maya token constants
CODE_START_TOKEN_ID = 128257  # SOS - Start of Speech
CODE_END_TOKEN_ID = 128258    # EOS - End of Speech
CODE_TOKEN_OFFSET = 128266
SNAC_MIN_ID = 128266
SNAC_MAX_ID = 156937
SNAC_TOKENS_PER_FRAME = 7

# Maya special tokens for prompt formatting
SOH_TOKEN_ID = 128259    # Start of Header
BOS_TOKEN_ID = 128000    # Beginning of Sequence
TEXT_EOT_TOKEN_ID = 128009  # End of Text
EOH_TOKEN_ID = 128260    # End of Header
SOA_TOKEN_ID = 128261    # Start of Audio


class MayaModel(BaseAudioModel):
    """Maya TTS model with natural language voice descriptions.

    Unlike XTTS-v2 which requires reference audio, Maya uses text descriptions
    to control voice characteristics. Example: "A young woman with a warm, friendly tone"

    Supports inline emotion tags for expressive speech:
    <laugh> <chuckle> <sigh> <gasp> <whisper> <scream> etc.
    """

    model_id = "maya"
    display_name = "Maya TTS"
    supported_languages = ["en"]  # English only
    sample_rate = 24000

    def __init__(self):
        super().__init__()
        self._model: Any = None
        self._tokenizer: Any = None
        self._snac: Any = None
        self._device = "cuda" if torch.cuda.is_available() else "cpu"

    def load(self) -> None:
        """Load Maya model into GPU memory."""
        if self._loaded:
            return

        logger.info(f"Loading {self.display_name}...")

        from transformers import AutoModelForCausalLM, AutoTokenizer

        model_name = "maya-research/maya1"

        # Load tokenizer with left padding for batch generation
        self._tokenizer = AutoTokenizer.from_pretrained(model_name)
        self._tokenizer.padding_side = "left"
        if not self._tokenizer.pad_token:
            self._tokenizer.pad_token = self._tokenizer.eos_token

        # Check for flash attention support
        attn_impl = None
        try:
            import flash_attn  # noqa: F401
            attn_impl = "flash_attention_2"
            logger.info("Flash Attention 2 available - using for faster generation")
        except ImportError:
            logger.info("Flash Attention not available - using default attention")

        # Load model in BF16 for efficiency
        model_kwargs = {
            "torch_dtype": torch.bfloat16,
            "device_map": self._device,
            "trust_remote_code": True,
        }
        if attn_impl:
            model_kwargs["attn_implementation"] = attn_impl

        self._model = AutoModelForCausalLM.from_pretrained(model_name, **model_kwargs)
        self._model.eval()

        # Compile model for faster inference (PyTorch 2.0+)
        # First generation will be slow (compilation), subsequent ones faster
        try:
            self._model = torch.compile(self._model, mode="reduce-overhead")
            logger.info("Model compiled with torch.compile for faster inference")
        except Exception as e:
            logger.warning(f"torch.compile failed, using uncompiled model: {e}")

        # Load SNAC codec for audio decoding
        import snac

        self._snac = snac.SNAC.from_pretrained("hubertsiuzdak/snac_24khz")
        self._snac = self._snac.to(self._device)
        self._snac.eval()

        self._loaded = True
        logger.info(f"{self.display_name} loaded successfully")

    def unload(self) -> None:
        """Unload model from GPU memory."""
        if not self._loaded:
            return

        logger.info(f"Unloading {self.display_name}...")

        # Clean up model
        if self._model is not None:
            try:
                self._model.to("cpu")
            except Exception:
                pass
            del self._model
            self._model = None

        # Clean up tokenizer
        if self._tokenizer is not None:
            del self._tokenizer
            self._tokenizer = None

        # Clean up SNAC
        if self._snac is not None:
            try:
                self._snac.to("cpu")
            except Exception:
                pass
            del self._snac
            self._snac = None

        # Aggressive cleanup
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()

        self._loaded = False
        logger.info(f"{self.display_name} unloaded")

    def _build_prompt(self, voice_description: str, text: str) -> str:
        """Build the Maya prompt with voice description.

        Maya uses XML-style attribute format for voice description.
        """
        return f'<description="{voice_description}"> {text}'

    def _extract_snac_codes(self, token_ids: list[int]) -> list[int]:
        """Extract SNAC codes from generated tokens.

        Filters tokens to only include valid SNAC token range.
        """
        # Find end token if present
        try:
            eos_idx = token_ids.index(CODE_END_TOKEN_ID)
            logger.info(f"Found EOS at index {eos_idx} of {len(token_ids)} tokens")
        except ValueError:
            eos_idx = len(token_ids)
            logger.warning(f"No EOS token found in {len(token_ids)} tokens")

        # Filter to only SNAC tokens (this is correct per official Maya code)
        snac_codes = [
            token_id
            for token_id in token_ids[:eos_idx]
            if SNAC_MIN_ID <= token_id <= SNAC_MAX_ID
        ]

        # Count non-SNAC tokens for debugging
        non_snac = [t for t in token_ids[:eos_idx] if not (SNAC_MIN_ID <= t <= SNAC_MAX_ID)]
        if non_snac:
            logger.warning(f"Found {len(non_snac)} non-SNAC tokens: {non_snac[:10]}...")

        # Debug logging
        if snac_codes:
            logger.info(f"Extracted {len(snac_codes)} SNAC tokens from {eos_idx} total tokens")

        return snac_codes

    def _unpack_snac_frames(self, snac_tokens: list[int]) -> list[list[int]]:
        """Unpack 7-token SNAC frames to 3 hierarchical levels.

        Maya uses 7 tokens per frame with hierarchical structure:
        - Level 1: 1 token per frame (~12 Hz)
        - Level 2: 2 tokens per frame (~23 Hz)
        - Level 3: 4 tokens per frame (~47 Hz)
        """
        frames = len(snac_tokens) // SNAC_TOKENS_PER_FRAME
        snac_tokens = snac_tokens[: frames * SNAC_TOKENS_PER_FRAME]

        l1, l2, l3 = [], [], []

        for i in range(frames):
            slots = snac_tokens[i * 7 : (i + 1) * 7]
            # Level 1: slot 0
            l1.append((slots[0] - CODE_TOKEN_OFFSET) % 4096)
            # Level 2: slots 1, 4
            l2.extend(
                [
                    (slots[1] - CODE_TOKEN_OFFSET) % 4096,
                    (slots[4] - CODE_TOKEN_OFFSET) % 4096,
                ]
            )
            # Level 3: slots 2, 3, 5, 6
            l3.extend(
                [
                    (slots[2] - CODE_TOKEN_OFFSET) % 4096,
                    (slots[3] - CODE_TOKEN_OFFSET) % 4096,
                    (slots[5] - CODE_TOKEN_OFFSET) % 4096,
                    (slots[6] - CODE_TOKEN_OFFSET) % 4096,
                ]
            )

        return [l1, l2, l3]

    def _count_emotion_tags(self, text: str) -> int:
        """Count emotion tags in text."""
        import re
        # Match tags like <laugh>, <angry>, <whisper>, etc.
        return len(re.findall(r'<[a-z_]+>', text, re.IGNORECASE))

    def _split_text_by_emotion_tags(self, text: str, max_tags_per_chunk: int = 2) -> list[str]:
        """Split text into chunks with limited emotion tags per chunk.

        Accumulates sentences until adding the next would exceed max_tags_per_chunk.
        Each chunk will have at least one sentence.

        Args:
            text: Full text with emotion tags
            max_tags_per_chunk: Maximum emotion tags allowed per chunk (default 2)

        Returns:
            List of text chunks
        """
        import re

        # Split on sentence boundaries, keeping punctuation
        sentences = re.split(r'(?<=[.!?])\s+', text.strip())

        if not sentences:
            return [text]

        chunks = []
        current_chunk = ""
        current_tag_count = 0

        for sentence in sentences:
            sentence_tags = self._count_emotion_tags(sentence)

            # If adding this sentence would exceed max tags AND we have content, finalize chunk
            if current_chunk and (current_tag_count + sentence_tags > max_tags_per_chunk):
                chunks.append(current_chunk.strip())
                current_chunk = sentence
                current_tag_count = sentence_tags
            else:
                current_chunk = current_chunk + " " + sentence if current_chunk else sentence
                current_tag_count += sentence_tags

        # Add final chunk
        if current_chunk.strip():
            chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    def _crossfade_audio(self, audio1: np.ndarray, audio2: np.ndarray, fade_samples: int = 1200) -> np.ndarray:
        """Crossfade two audio arrays together.

        Args:
            audio1: First audio array
            audio2: Second audio array
            fade_samples: Number of samples for crossfade (default 1200 = 50ms at 24kHz)

        Returns:
            Combined audio with crossfade
        """
        if len(audio1) < fade_samples or len(audio2) < fade_samples:
            # Too short for crossfade, just concatenate
            return np.concatenate([audio1, audio2])

        # Create fade curves
        fade_out = np.linspace(1.0, 0.0, fade_samples)
        fade_in = np.linspace(0.0, 1.0, fade_samples)

        # Apply crossfade
        audio1_end = audio1[-fade_samples:] * fade_out
        audio2_start = audio2[:fade_samples] * fade_in
        crossfaded = audio1_end + audio2_start

        # Combine: audio1 (minus fade region) + crossfade + audio2 (minus fade region)
        return np.concatenate([
            audio1[:-fade_samples],
            crossfaded,
            audio2[fade_samples:]
        ])

    def _build_input_ids(self, text: str, voice_description: str) -> list[int]:
        """Build input token IDs for a single text chunk."""
        text_prompt = self._build_prompt(voice_description, text)
        text_tokens = self._tokenizer.encode(text_prompt, add_special_tokens=False)

        # Build full prompt with Maya's special token structure:
        # [SOH][BOS]<description="..."> text[EOT][EOH][SOA][SOS]
        return (
            [SOH_TOKEN_ID, BOS_TOKEN_ID]
            + text_tokens
            + [TEXT_EOT_TOKEN_ID, EOH_TOKEN_ID, SOA_TOKEN_ID, CODE_START_TOKEN_ID]
        )

    def _generate_audio_tokens_batch(
        self,
        texts: list[str],
        voice_description: str,
        temperature: float = 0.4,
        top_p: float = 0.9,
    ) -> list[list[int]]:
        """Generate audio tokens for multiple text chunks in parallel.

        Args:
            texts: List of text chunks to synthesize
            voice_description: Natural language description of the voice
            temperature: Sampling temperature (lower = more stable)
            top_p: Top-p sampling parameter

        Returns:
            List of generated token ID lists (one per input text)
        """
        if not texts:
            return []

        # Build input IDs for all chunks
        all_input_ids = [self._build_input_ids(text, voice_description) for text in texts]

        # Find max length for padding
        max_len = max(len(ids) for ids in all_input_ids)

        # Pad sequences (left padding for causal LM)
        pad_token_id = self._tokenizer.pad_token_id
        padded_ids = []
        attention_masks = []

        for ids in all_input_ids:
            padding_len = max_len - len(ids)
            padded = [pad_token_id] * padding_len + ids
            mask = [0] * padding_len + [1] * len(ids)
            padded_ids.append(padded)
            attention_masks.append(mask)

        # Convert to tensors
        input_tensor = torch.tensor(padded_ids, dtype=torch.long, device=self._device)
        attention_mask = torch.tensor(attention_masks, dtype=torch.long, device=self._device)

        # Estimate max tokens needed based on longest text
        max_text_len = max(len(t) for t in texts)
        estimated_audio_tokens = max(2048, max_text_len * 6)

        logger.info(
            f"Batch generating {len(texts)} chunks, "
            f"input shape={input_tensor.shape}, max_new={estimated_audio_tokens}"
        )

        with torch.no_grad():
            outputs = self._model.generate(
                input_ids=input_tensor,
                attention_mask=attention_mask,
                max_new_tokens=estimated_audio_tokens,
                min_new_tokens=28,
                temperature=temperature,
                top_p=top_p,
                repetition_penalty=1.1,
                do_sample=True,
                eos_token_id=CODE_END_TOKEN_ID,
                pad_token_id=pad_token_id,
            )

        # Extract generated tokens for each sequence
        results = []
        for i, (output_seq, orig_ids) in enumerate(zip(outputs, all_input_ids)):
            # Skip padding and original input to get only generated tokens
            orig_len = len(orig_ids)
            padding_len = max_len - orig_len

            # Generated tokens start after padding + original input
            generated = output_seq[max_len:].tolist()

            # Remove any trailing pad tokens
            while generated and generated[-1] == pad_token_id:
                generated.pop()

            results.append(generated)
            logger.info(f"Batch item {i+1}: generated {len(generated)} tokens")

        return results

    def _generate_audio_tokens_for_chunk(
        self,
        text: str,
        voice_description: str,
        temperature: float = 0.4,
        top_p: float = 0.9,
    ) -> list[int]:
        """Generate audio tokens for a single text chunk.

        Args:
            text: Text chunk to synthesize
            voice_description: Natural language description of the voice
            temperature: Sampling temperature (lower = more stable)
            top_p: Top-p sampling parameter

        Returns:
            List of generated token IDs
        """
        # Use batch method with single item
        results = self._generate_audio_tokens_batch([text], voice_description, temperature, top_p)
        return results[0] if results else []

    def _decode_audio_tokens(self, token_ids: list[int], trim_warmup: bool = True) -> np.ndarray:
        """Decode audio tokens to waveform using SNAC.

        Args:
            token_ids: Generated token IDs from the model
            trim_warmup: Whether to trim warmup samples (only for first chunk)

        Returns:
            Audio waveform as numpy array
        """
        # Extract SNAC codes (filtered to valid range)
        snac_codes = self._extract_snac_codes(token_ids)

        if len(snac_codes) < SNAC_TOKENS_PER_FRAME:
            raise ValueError(f"Not enough SNAC tokens generated: {len(snac_codes)}")

        num_frames = len(snac_codes) // SNAC_TOKENS_PER_FRAME
        logger.info(f"Extracted {len(snac_codes)} audio tokens = {num_frames} frames from {len(token_ids)} generated tokens")

        # Unpack to 3 hierarchical levels
        levels = self._unpack_snac_frames(snac_codes)

        # Convert to tensors
        codes_tensor = [
            torch.tensor(level, dtype=torch.long, device=self._device).unsqueeze(0)
            for level in levels
        ]

        # Decode with SNAC
        with torch.inference_mode():
            z_q = self._snac.quantizer.from_codes(codes_tensor)
            audio = self._snac.decoder(z_q)[0, 0].cpu().numpy()

        # Trim warmup samples (first ~85ms) - only for first chunk
        if trim_warmup and len(audio) > 2048:
            audio = audio[2048:]

        return audio

    def synthesize_maya(
        self,
        text: str,
        voice_description: str,
        temperature: float = 0.4,
        speed: float = 1.0,
    ) -> bytes:
        """Synthesize speech using Maya's voice description system.

        For long texts, automatically splits into chunks and concatenates audio.

        Args:
            text: Text to synthesize (can include emotion tags)
            voice_description: Natural language voice description
            temperature: Sampling temperature (0.0-1.0, lower is more stable)
            speed: Playback speed (0.5-2.0)

        Returns:
            WAV audio bytes
        """
        if not self._loaded or self._model is None:
            raise RuntimeError("Model not loaded")

        logger.info(
            f"Maya synthesizing: {len(text)} chars, "
            f"voice='{voice_description[:50]}...'"
        )

        # Split text by emotion tags (max 2 tags per chunk)
        chunks = self._split_text_by_emotion_tags(text, max_tags_per_chunk=2)
        logger.info(f"Split into {len(chunks)} chunks by emotion tags")

        for i, chunk in enumerate(chunks):
            tag_count = self._count_emotion_tags(chunk)
            logger.info(f"Chunk {i+1}/{len(chunks)}: {len(chunk)} chars, {tag_count} tags - {chunk[:60]}...")

        # Generate all chunks in parallel batch
        all_token_ids = self._generate_audio_tokens_batch(
            texts=chunks,
            voice_description=voice_description,
            temperature=temperature,
        )

        # Decode each chunk's tokens to audio
        audio_segments = []
        for i, token_ids in enumerate(all_token_ids):
            # Decode to waveform (trim warmup from all chunks since each is independent)
            chunk_audio = self._decode_audio_tokens(token_ids, trim_warmup=True)
            audio_segments.append(chunk_audio)
            logger.info(f"Chunk {i+1}: {len(chunk_audio)/self.sample_rate:.2f}s audio")

        # Combine audio segments with crossfade
        if len(audio_segments) == 1:
            audio = audio_segments[0]
        else:
            audio = audio_segments[0]
            for segment in audio_segments[1:]:
                audio = self._crossfade_audio(audio, segment, fade_samples=1200)  # 50ms crossfade

            logger.info(f"Combined {len(audio_segments)} segments: {len(audio)/self.sample_rate:.2f}s total")

        # Apply speed adjustment if needed
        if speed != 1.0:
            import scipy.signal

            # Resample for speed adjustment
            new_length = int(len(audio) / speed)
            audio = scipy.signal.resample(audio, new_length)

        # Normalize audio to prevent clipping
        max_val = np.abs(audio).max()
        if max_val > 0:
            audio = audio / max_val * 0.95

        # Convert to 16-bit PCM
        audio_int16 = (audio * 32767).astype(np.int16)

        # Create WAV bytes
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)  # 16-bit
            wav_file.setframerate(self.sample_rate)
            wav_file.writeframes(audio_int16.tobytes())

        audio_bytes = buffer.getvalue()
        logger.info(f"Maya synthesis complete: {len(audio_bytes)} bytes, {len(audio)/self.sample_rate:.2f}s")
        return audio_bytes

    # BaseAudioModel interface methods (for compatibility)
    # Maya doesn't use reference audio, but we implement the interface

    def synthesize(
        self,
        request: "MayaTTSRequest",
        speaker_wav_paths: list[str],
    ) -> bytes:
        """Synthesize speech - Maya ignores speaker_wav_paths.

        For Maya, voice is controlled by request.voice_description.
        The speaker_wav_paths parameter is ignored but kept for interface compatibility.
        """
        # Maya uses voice description, not reference audio
        return self.synthesize_maya(
            text=request.text,
            voice_description=getattr(request, "voice_description", "A neutral adult voice"),
            temperature=getattr(request, "temperature", 0.7),
            speed=getattr(request, "speed", 1.0),
        )

    def synthesize_stream(
        self,
        request: "MayaTTSRequest",
        speaker_wav_paths: list[str],
    ) -> Generator[bytes, None, None]:
        """Stream synthesis - Maya generates complete audio then yields chunks.

        True streaming would require model modifications.
        For now, we generate complete audio and yield in chunks.
        """
        # Generate complete audio
        audio_bytes = self.synthesize(request, speaker_wav_paths)

        # Yield in chunks for streaming response
        chunk_size = 32000  # ~1 second at 24kHz mono 16-bit
        for i in range(0, len(audio_bytes), chunk_size):
            yield audio_bytes[i : i + chunk_size]
