"""TTS generation API router."""

import logging
import os
import tempfile
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response, StreamingResponse

from ..audio.schemas import (
    LANGUAGE_NAMES,
    LanguageInfo,
    LanguagesResponse,
    TTSHistoryEntryResponse,
    TTSHistoryResponse,
    TTSLanguage,
    TTSRequest,
)
from ..db import (
    add_tts_history,
    clear_tts_history,
    delete_tts_history_entry,
    get_actor_audio_paths,
    get_actor_by_name,
    get_tts_history,
    get_tts_history_audio_path,
)
from ..vram_manager import vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/tts", tags=["text-to-speech"])


@router.post(
    "/generate",
    responses={
        200: {"content": {"audio/wav": {}}, "description": "Generated audio"},
        400: {"description": "Invalid request"},
        404: {"description": "Actor not found"},
        500: {"description": "Generation failed"},
    },
)
async def generate_speech(request: TTSRequest):
    """Generate speech from text using a stored actor's voice.

    This is the batch endpoint - it returns the complete audio file at once.
    For long texts, consider using /tts/stream for lower latency.
    """
    # Find the actor
    actor = await get_actor_by_name(request.actor)
    if not actor:
        raise HTTPException(
            status_code=404, detail=f"Actor '{request.actor}' not found"
        )

    # Get reference audio paths
    ref_paths = await get_actor_audio_paths(actor.id)
    if not ref_paths:
        raise HTTPException(
            status_code=500, detail=f"Actor '{request.actor}' has no reference audio files"
        )

    try:
        # Acquire GPU and generate
        async with vram_manager.acquire_gpu("xtts-v2") as model:
            audio_bytes = model.synthesize(
                request,
                speaker_wav_paths=[str(p) for p in ref_paths],
            )

        # Save to history
        await add_tts_history(
            actor_name=request.actor,
            text=request.text,
            language=request.language,
            audio_bytes=audio_bytes,
        )

        logger.info(
            f"Generated speech: actor={request.actor}, "
            f"text_len={len(request.text)}, audio_size={len(audio_bytes)}"
        )

        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        logger.exception("TTS generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


@router.post(
    "/stream",
    responses={
        200: {"content": {"audio/wav": {}}, "description": "Streaming audio"},
        400: {"description": "Invalid request"},
        404: {"description": "Actor not found"},
        500: {"description": "Generation failed"},
    },
)
async def stream_speech(request: TTSRequest):
    """Generate speech with streaming output.

    Returns audio chunks as they are generated, reducing time-to-first-audio.
    Best for long texts where immediate playback is desired.
    """
    # Find the actor
    actor = await get_actor_by_name(request.actor)
    if not actor:
        raise HTTPException(
            status_code=404, detail=f"Actor '{request.actor}' not found"
        )

    # Get reference audio paths
    ref_paths = await get_actor_audio_paths(actor.id)
    if not ref_paths:
        raise HTTPException(
            status_code=500, detail=f"Actor '{request.actor}' has no reference audio files"
        )

    async def generate_chunks():
        """Generator for streaming audio chunks."""
        try:
            async with vram_manager.acquire_gpu("xtts-v2") as model:
                for chunk in model.synthesize_stream(
                    request,
                    speaker_wav_paths=[str(p) for p in ref_paths],
                ):
                    yield chunk
        except Exception:
            logger.exception("TTS streaming failed")
            raise

    logger.info(f"Streaming speech: actor={request.actor}, text_len={len(request.text)}")

    return StreamingResponse(
        generate_chunks(),
        media_type="audio/wav",
    )


@router.post(
    "/generate-with-audio",
    responses={
        200: {"content": {"audio/wav": {}}, "description": "Generated audio"},
        400: {"description": "Invalid request"},
        500: {"description": "Generation failed"},
    },
)
async def generate_speech_with_audio(
    text: Annotated[str, Form(description="Text to synthesize")],
    language: Annotated[TTSLanguage, Form(description="Output language")] = TTSLanguage.EN,
    reference_audio: Annotated[
        list[UploadFile], File(description="Reference audio file(s) for voice cloning")
    ] = ...,
    temperature: Annotated[float, Form(ge=0.0, le=1.0)] = 0.65,
    speed: Annotated[float, Form(ge=0.5, le=2.0)] = 1.0,
    split_sentences: Annotated[bool, Form()] = True,
):
    """Generate speech using uploaded reference audio (no stored actor).

    This is a one-shot endpoint for testing voices without creating an actor.
    For production use, create an actor first with POST /actors.
    """
    if not reference_audio:
        raise HTTPException(
            status_code=400, detail="At least one reference audio file is required"
        )

    if not text or len(text) < 1:
        raise HTTPException(status_code=400, detail="Text is required")

    # Save uploaded files temporarily
    temp_paths = []
    try:
        for upload in reference_audio:
            # Determine file extension
            ext = os.path.splitext(upload.filename or "")[1] or ".wav"
            temp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
            content = await upload.read()
            temp.write(content)
            temp.close()
            temp_paths.append(temp.name)

        # Create request object
        from ..audio.schemas import TTSRequest as TTSReq

        # Use a dummy actor name since we're using uploaded audio
        request = TTSReq(
            text=text,
            actor="__uploaded__",  # Not used in this context
            language=language,
            temperature=temperature,
            speed=speed,
            split_sentences=split_sentences,
        )

        # Generate
        async with vram_manager.acquire_gpu("xtts-v2") as model:
            audio_bytes = model.synthesize(request, temp_paths)

        logger.info(
            f"Generated speech with uploaded audio: text_len={len(text)}, "
            f"refs={len(temp_paths)}, audio_size={len(audio_bytes)}"
        )

        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        logger.exception("TTS generation with uploaded audio failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    finally:
        # Cleanup temp files
        for path in temp_paths:
            try:
                os.unlink(path)
            except Exception:
                pass


@router.get("/languages", response_model=LanguagesResponse)
async def list_languages():
    """List supported TTS languages."""
    languages = [
        LanguageInfo(code=lang.value, name=LANGUAGE_NAMES.get(lang.value, lang.value))
        for lang in TTSLanguage
    ]
    return LanguagesResponse(languages=languages)


# History endpoints


@router.get("/history", response_model=TTSHistoryResponse)
async def list_tts_history(limit: int = 50):
    """Get TTS generation history, most recent first."""
    entries = await get_tts_history(limit=limit)
    return TTSHistoryResponse(
        entries=[
            TTSHistoryEntryResponse(
                id=e.id,
                actor_name=e.actor_name,
                text=e.text,
                language=e.language,
                duration_seconds=e.duration_seconds,
                created_at=e.created_at,
            )
            for e in entries
        ],
        total=len(entries),
    )


@router.get("/history/{entry_id}/audio")
async def get_history_audio(entry_id: str):
    """Get the audio file for a TTS history entry."""
    audio_path = await get_tts_history_audio_path(entry_id)
    if not audio_path or not audio_path.exists():
        raise HTTPException(status_code=404, detail="History entry not found")

    audio_bytes = audio_path.read_bytes()
    return Response(content=audio_bytes, media_type="audio/wav")


@router.delete("/history/{entry_id}", status_code=204)
async def delete_history_entry(entry_id: str):
    """Delete a TTS history entry."""
    success = await delete_tts_history_entry(entry_id)
    if not success:
        raise HTTPException(status_code=404, detail="History entry not found")
    logger.info(f"Deleted TTS history entry: {entry_id}")


@router.delete("/history", status_code=204)
async def clear_all_history():
    """Clear all TTS history."""
    count = await clear_tts_history()
    logger.info(f"Cleared {count} TTS history entries")
