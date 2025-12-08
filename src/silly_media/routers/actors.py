"""Actor management API router."""

import logging
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..audio.schemas import (
    ActorAudioFileResponse,
    ActorListResponse,
    ActorResponse,
    TTSLanguage,
)
from ..db import (
    add_audio_to_actor,
    create_actor,
    delete_actor,
    get_actor_audio_count,
    get_actor_audio_files,
    get_actor_by_name,
    list_actors,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/actors", tags=["actors"])


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
    language: Annotated[TTSLanguage, Form(description="Primary language")] = TTSLanguage.EN,
    description: Annotated[str, Form(description="Actor description")] = "",
    audio_files: Annotated[
        list[UploadFile], File(description="Reference audio file(s)")
    ] = ...,
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
