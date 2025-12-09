"""YouTube audio extraction and voice isolation pipeline.

Downloads audio from YouTube, separates vocals using demucs, and trims silence.
"""

import logging
import re
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

import torch
import torchaudio

if TYPE_CHECKING:
    from .demucs_model import DemucsModel

logger = logging.getLogger(__name__)

# YouTube URL patterns
YOUTUBE_PATTERNS = [
    r'(?:https?://)?(?:www\.)?youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})',
    r'(?:https?://)?(?:www\.)?youtu\.be/([a-zA-Z0-9_-]{11})',
    r'(?:https?://)?(?:www\.)?youtube\.com/shorts/([a-zA-Z0-9_-]{11})',
]


def is_youtube_url(url: str) -> bool:
    """Check if URL is a valid YouTube URL."""
    for pattern in YOUTUBE_PATTERNS:
        if re.match(pattern, url):
            return True
    return False


def extract_video_id(url: str) -> str | None:
    """Extract video ID from YouTube URL."""
    for pattern in YOUTUBE_PATTERNS:
        match = re.match(pattern, url)
        if match:
            return match.group(1)
    return None


async def download_youtube_audio(
    url: str,
    output_path: Path,
    max_duration: int = 60,
) -> Path:
    """Download audio from YouTube video.

    Args:
        url: YouTube URL
        output_path: Directory to save the audio
        max_duration: Maximum duration in seconds (default 60)

    Returns:
        Path to downloaded audio file
    """
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"Invalid YouTube URL: {url}")

    # Use yt-dlp output template - it will create {video_id}.wav
    output_template = str(output_path / f"{video_id}.%(ext)s")
    expected_output = output_path / f"{video_id}.wav"

    logger.info(f"Downloading audio from YouTube: {video_id}")

    # Use yt-dlp to download audio only
    cmd = [
        "yt-dlp",
        "-x",  # Extract audio
        "--audio-format", "wav",
        "--audio-quality", "0",  # Best quality
        "-o", output_template,
        "--no-playlist",
        url,
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,  # 2 minute timeout
        )

        if result.returncode != 0:
            logger.error(f"yt-dlp error: {result.stderr}")
            raise RuntimeError(f"Failed to download audio: {result.stderr}")

        # Check for the expected .wav file
        if expected_output.exists():
            logger.info(f"Downloaded: {expected_output}")
            return expected_output

        # yt-dlp may have created file with different extension, search for it
        possible_files = list(output_path.glob(f"{video_id}.*"))
        audio_extensions = ['.wav', '.mp3', '.m4a', '.webm', '.opus', '.ogg']
        for pf in possible_files:
            if pf.suffix.lower() in audio_extensions:
                logger.info(f"Downloaded: {pf}")
                return pf

        # Log what files exist for debugging
        all_files = list(output_path.iterdir())
        logger.error(f"Expected {expected_output}, found files: {all_files}")
        raise RuntimeError("Downloaded file not found")

    except subprocess.TimeoutExpired:
        raise RuntimeError("Download timed out")


def separate_vocals_with_model(
    audio_path: Path,
    output_path: Path,
    demucs_model: "DemucsModel",
) -> Path:
    """Separate vocals from audio using VRAM-managed demucs model.

    Args:
        audio_path: Path to input audio file
        output_path: Path for output vocals file
        demucs_model: Loaded DemucsModel instance from VRAM manager

    Returns:
        Path to isolated vocals file
    """
    logger.info(f"Separating vocals with demucs: {audio_path}")
    return demucs_model.separate_vocals_to_file(audio_path, output_path)


def detect_voice_segments(
    audio_path: Path,
    threshold: float = 0.5,
    min_speech_duration: float = 0.25,
    min_silence_duration: float = 0.1,
) -> list[tuple[float, float]]:
    """Detect voice segments using silero-vad.

    Args:
        audio_path: Path to audio file
        threshold: VAD threshold (0-1)
        min_speech_duration: Minimum speech segment duration
        min_silence_duration: Minimum silence duration to split

    Returns:
        List of (start, end) tuples in seconds
    """
    logger.info(f"Detecting voice segments: {audio_path}")

    # Load silero VAD model
    model, utils = torch.hub.load(
        repo_or_dir='snakers4/silero-vad',
        model='silero_vad',
        force_reload=False,
        trust_repo=True,
    )
    get_speech_timestamps, _, read_audio, *_ = utils

    # Read audio (silero expects 16kHz)
    wav = read_audio(str(audio_path), sampling_rate=16000)

    # Get speech timestamps
    speech_timestamps = get_speech_timestamps(
        wav,
        model,
        threshold=threshold,
        min_speech_duration_ms=int(min_speech_duration * 1000),
        min_silence_duration_ms=int(min_silence_duration * 1000),
        return_seconds=True,
    )

    segments = [(ts['start'], ts['end']) for ts in speech_timestamps]
    logger.info(f"Found {len(segments)} voice segments")

    return segments


def trim_to_voice_segments(
    audio_path: Path,
    output_path: Path,
    max_duration: float = 30.0,
    padding: float = 0.1,
) -> Path:
    """Trim audio to only voice segments, removing silence.

    Args:
        audio_path: Path to input audio
        output_path: Path for output file
        max_duration: Maximum output duration in seconds
        padding: Padding around voice segments in seconds

    Returns:
        Path to trimmed audio file
    """
    logger.info(f"Trimming to voice segments: {audio_path}")

    # Detect voice segments
    segments = detect_voice_segments(audio_path)

    if not segments:
        raise RuntimeError("No voice detected in audio")

    # Load original audio
    waveform, sample_rate = torchaudio.load(str(audio_path))

    # Collect voice segments
    voice_parts = []
    total_duration = 0.0

    for start, end in segments:
        if total_duration >= max_duration:
            break

        # Add padding
        start = max(0, start - padding)
        end = min(waveform.shape[1] / sample_rate, end + padding)

        # Calculate remaining duration
        segment_duration = end - start
        if total_duration + segment_duration > max_duration:
            segment_duration = max_duration - total_duration
            end = start + segment_duration

        # Extract segment
        start_sample = int(start * sample_rate)
        end_sample = int(end * sample_rate)
        voice_parts.append(waveform[:, start_sample:end_sample])

        total_duration += segment_duration

    if not voice_parts:
        raise RuntimeError("No voice segments extracted")

    # Concatenate all voice parts
    trimmed = torch.cat(voice_parts, dim=1)

    # Save trimmed audio
    torchaudio.save(str(output_path), trimmed, sample_rate)

    logger.info(f"Trimmed audio: {total_duration:.1f}s -> {output_path}")
    return output_path


async def extract_voice_from_youtube(
    url: str,
    output_path: Path,
    max_duration: float = 30.0,
    separate_vocals: bool = True,
) -> Path:
    """Full pipeline: YouTube URL -> clean voice reference.

    Uses VRAM manager for demucs model if vocal separation is enabled.

    Args:
        url: YouTube video URL
        output_path: Final output file path
        max_duration: Maximum duration of output clip
        separate_vocals: Whether to use demucs for vocal separation

    Returns:
        Path to final processed audio file
    """
    from ..vram_manager import vram_manager

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)

        # Step 1: Download audio from YouTube
        downloaded = await download_youtube_audio(
            url,
            tmp_path,
            max_duration=int(max_duration * 3),  # Download more for processing
        )

        # Step 2: Separate vocals (optional but recommended)
        if separate_vocals:
            vocals_path = tmp_path / "vocals.wav"
            # Use VRAM manager for demucs
            async with vram_manager.acquire_gpu("demucs") as demucs_model:
                separate_vocals_with_model(downloaded, vocals_path, demucs_model)
            vocals = vocals_path
        else:
            vocals = downloaded

        # Step 3: Trim silence and limit duration
        final_path = trim_to_voice_segments(
            vocals,
            output_path,
            max_duration=max_duration,
        )

        return final_path
