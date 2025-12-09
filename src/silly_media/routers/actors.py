"""Actor management API router."""

import logging
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..audio.schemas import (
    ActorAudioFileResponse,
    ActorListResponse,
    ActorResponse,
    TTSLanguage,
)
from ..audio.youtube import extract_voice_from_youtube, is_youtube_url
from ..config import settings
from ..db import (
    add_audio_to_actor,
    create_actor,
    delete_actor,
    delete_actor_audio_file,
    get_actor_audio_count,
    get_actor_audio_files,
    get_actor_by_name,
    list_actors,
)

ACTORS_PATH = Path(settings.actors_storage_path)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/actors", tags=["actors"])


class CreateActorFromYouTubeRequest(BaseModel):
    """Request to create an actor from a YouTube URL."""

    name: str
    youtube_url: str
    language: TTSLanguage = TTSLanguage.EN
    description: str = ""
    max_duration: float = 30.0
    separate_vocals: bool = True


@router.get("", response_model=ActorListResponse)
async def list_all_actors():
    """List all available actors."""
    actors = await list_actors()

    # Get audio counts for each actor
    actor_responses = []
    for actor in actors:
        audio_count = await get_actor_audio_count(actor.id)
        actor_responses.append(
            ActorResponse(
                id=actor.id,
                name=actor.name,
                language=actor.language,
                description=actor.description,
                audio_count=audio_count,
                created_at=actor.created_at,
                updated_at=actor.updated_at,
            )
        )

    return ActorListResponse(actors=actor_responses, total=len(actor_responses))


@router.post("", response_model=ActorResponse, status_code=201)
async def create_new_actor(
    name: Annotated[str, Form(description="Actor display name")],
    audio_files: Annotated[
        list[UploadFile], File(description="Reference audio file(s)")
    ],
    language: Annotated[TTSLanguage, Form(description="Primary language")] = TTSLanguage.EN,
    description: Annotated[str, Form(description="Actor description")] = "",
):
    """Create a new actor from uploaded audio files.

    Upload one or more audio files (WAV, MP3, etc.) as reference for voice cloning.
    Minimum 6 seconds of audio recommended for best quality.
    """
    if not audio_files:
        raise HTTPException(
            status_code=400, detail="At least one audio file is required"
        )

    # Check if actor already exists
    existing = await get_actor_by_name(name)
    if existing:
        raise HTTPException(
            status_code=409, detail=f"Actor '{name}' already exists"
        )

    # Create the actor
    actor = await create_actor(
        name=name,
        language=language.value,
        description=description,
    )

    # Add audio files
    for upload in audio_files:
        content = await upload.read()
        await add_audio_to_actor(
            actor_id=actor.id,
            audio_bytes=content,
            original_filename=upload.filename or "unknown",
        )

    audio_count = await get_actor_audio_count(actor.id)

    logger.info(f"Created actor: {name} with {audio_count} audio files")

    return ActorResponse(
        id=actor.id,
        name=actor.name,
        language=actor.language,
        description=actor.description,
        audio_count=audio_count,
        created_at=actor.created_at,
        updated_at=actor.updated_at,
    )


@router.post("/from-youtube", response_model=ActorResponse, status_code=201)
async def create_actor_from_youtube(request: CreateActorFromYouTubeRequest):
    """Create a new actor from a YouTube video URL.

    Downloads audio from YouTube, optionally separates vocals using demucs,
    trims silence using voice activity detection, and saves as actor reference.

    This is useful for creating voice actors from interviews, podcasts, etc.
    The pipeline: YouTube -> Download -> Vocal Separation -> VAD Trimming -> Actor

    Args:
        name: Actor display name (must be unique)
        youtube_url: YouTube video URL
        language: Primary language of the actor
        description: Optional description
        max_duration: Maximum duration of extracted audio (default 30s)
        separate_vocals: Whether to remove background music (default true)
    """
    # Validate YouTube URL
    if not is_youtube_url(request.youtube_url):
        raise HTTPException(
            status_code=400,
            detail="Invalid YouTube URL. Supported formats: youtube.com/watch?v=..., youtu.be/..., youtube.com/shorts/...",
        )

    # Check if actor already exists
    existing = await get_actor_by_name(request.name)
    if existing:
        raise HTTPException(
            status_code=409, detail=f"Actor '{request.name}' already exists"
        )

    try:
        # Create temp file for extracted audio
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            output_path = Path(tmp.name)

        # Extract voice from YouTube
        logger.info(f"Extracting voice from YouTube: {request.youtube_url}")
        await extract_voice_from_youtube(
            url=request.youtube_url,
            output_path=output_path,
            max_duration=request.max_duration,
            separate_vocals=request.separate_vocals,
        )

        # Create the actor
        actor = await create_actor(
            name=request.name,
            language=request.language.value,
            description=request.description,
        )

        # Add extracted audio
        audio_bytes = output_path.read_bytes()
        await add_audio_to_actor(
            actor_id=actor.id,
            audio_bytes=audio_bytes,
            original_filename=f"youtube_{request.youtube_url.split('=')[-1][:11]}.wav",
        )

        # Cleanup temp file
        output_path.unlink(missing_ok=True)

        audio_count = await get_actor_audio_count(actor.id)
        logger.info(f"Created actor from YouTube: {request.name}")

        return ActorResponse(
            id=actor.id,
            name=actor.name,
            language=actor.language,
            description=actor.description,
            audio_count=audio_count,
            created_at=actor.created_at,
            updated_at=actor.updated_at,
        )

    except Exception as e:
        logger.exception(f"Failed to create actor from YouTube: {e}")
        # Cleanup temp file on error
        if 'output_path' in locals():
            output_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=500,
            detail=f"Failed to extract voice from YouTube: {str(e)}",
        )


@router.get("/{name}", response_model=ActorResponse)
async def get_actor_details(name: str):
    """Get actor details by name."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    audio_count = await get_actor_audio_count(actor.id)

    return ActorResponse(
        id=actor.id,
        name=actor.name,
        language=actor.language,
        description=actor.description,
        audio_count=audio_count,
        created_at=actor.created_at,
        updated_at=actor.updated_at,
    )


@router.delete("/{name}", status_code=204)
async def delete_actor_by_name(name: str):
    """Delete an actor and all associated audio files."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    success = await delete_actor(actor.id)
    if not success:
        raise HTTPException(status_code=500, detail="Failed to delete actor")

    logger.info(f"Deleted actor: {name}")


@router.post("/{name}/audio", response_model=ActorAudioFileResponse, status_code=201)
async def add_audio_to_existing_actor(
    name: str,
    audio_file: Annotated[UploadFile, File(description="Audio file to add")],
):
    """Add additional audio file(s) to an existing actor."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    content = await audio_file.read()
    audio = await add_audio_to_actor(
        actor_id=actor.id,
        audio_bytes=content,
        original_filename=audio_file.filename or "unknown",
    )

    logger.info(f"Added audio file to actor {name}: {audio.filename}")

    return ActorAudioFileResponse(
        id=audio.id,
        filename=audio.filename,
        original_name=audio.original_name,
        duration_seconds=audio.duration_seconds,
        created_at=audio.created_at,
    )


@router.get("/{name}/audio", response_model=list[ActorAudioFileResponse])
async def list_actor_audio_files(name: str):
    """List all audio files for an actor."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    audio_files = await get_actor_audio_files(actor.id)

    return [
        ActorAudioFileResponse(
            id=f.id,
            filename=f.filename,
            original_name=f.original_name,
            duration_seconds=f.duration_seconds,
            created_at=f.created_at,
        )
        for f in audio_files
    ]


@router.get("/{name}/audio/{file_id}/download")
async def download_audio_file(name: str, file_id: str):
    """Download a specific audio file from an actor."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    # Find the audio file
    audio_files = await get_actor_audio_files(actor.id)
    audio_file = next((f for f in audio_files if f.id == file_id), None)
    if not audio_file:
        raise HTTPException(status_code=404, detail=f"Audio file '{file_id}' not found")

    # Get the file path
    file_path = ACTORS_PATH / actor.id / audio_file.filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    # Use original name for download if available
    download_name = audio_file.original_name or audio_file.filename

    return FileResponse(
        path=file_path,
        media_type="audio/wav",
        filename=download_name,
    )


@router.delete("/{name}/audio/{file_id}", status_code=204)
async def delete_audio_file(name: str, file_id: str):
    """Delete a specific audio file from an actor."""
    actor = await get_actor_by_name(name)
    if not actor:
        raise HTTPException(status_code=404, detail=f"Actor '{name}' not found")

    success = await delete_actor_audio_file(actor.id, file_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Audio file '{file_id}' not found")

    logger.info(f"Deleted audio file {file_id} from actor {name}")
