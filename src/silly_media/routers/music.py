"""Music generation API endpoints."""

import asyncio
import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from ..music import MusicRegistry
from ..music.schemas import (
    MusicAudioResult,
    MusicGenerateRequest,
    MusicJobResponse,
    MusicStatusResponse,
)
from ..progress import music_progress
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/music", tags=["music"])

# In-memory job tracking (same pattern as video router)
_jobs: dict[str, MusicStatusResponse] = {}
_job_start_times: dict[str, float] = {}


@router.get("/models")
async def list_music_models():
    """List available music generation models."""
    available = vram_manager.get_available_models(ModelType.MUSIC)
    loaded = vram_manager.get_loaded_models()

    models = []
    for name in available:
        model = MusicRegistry.get_model(name)
        models.append({
            "id": name,
            "name": model.display_name,
            "loaded": name in loaded,
            "default_steps": model.default_steps,
            "estimated_vram_gb": model.estimated_vram_gb,
        })

    return {"models": models}


@router.post("/generate", response_model=MusicJobResponse)
async def generate_music(
    request: MusicGenerateRequest,
    background_tasks: BackgroundTasks,
) -> MusicJobResponse:
    """Start music generation. Returns a job ID for status polling."""
    model_name = request.model.value

    if model_name not in vram_manager.get_available_models(ModelType.MUSIC):
        raise HTTPException(404, f"Unknown music model: {model_name}")

    job_id = str(uuid.uuid4())[:8]
    steps = request.inference_steps or MusicRegistry.get_model(model_name).default_steps

    _jobs[job_id] = MusicStatusResponse(
        job_id=job_id,
        status="queued",
        progress=0.0,
        current_step=0,
        total_steps=steps,
    )

    background_tasks.add_task(_run_music_job, job_id, model_name, request)

    # Rough estimate: ~1-2s per step + overhead
    estimated_time = steps * 1.5 + 5.0

    return MusicJobResponse(
        job_id=job_id,
        status="queued",
        estimated_time_seconds=estimated_time,
    )


async def _run_music_job(
    job_id: str, model_name: str, request: MusicGenerateRequest
) -> None:
    """Background task for music generation."""
    start_time = time.time()
    _job_start_times[job_id] = start_time
    _jobs[job_id].status = "processing"

    steps = request.inference_steps or MusicRegistry.get_model(model_name).default_steps
    music_progress.start(steps)

    try:
        async with vram_manager.acquire_gpu(model_name) as model:
            audios = await asyncio.to_thread(model.generate, request, None)

        music_progress.finish()

        # Build audio results
        audio_results = []
        for audio in audios:
            audio_results.append(
                MusicAudioResult(
                    index=audio["index"],
                    seed=audio["seed"],
                    sample_rate=audio["sample_rate"],
                    download_url=f"/music/download/{audio['job_id']}/{audio['index']}",
                )
            )

        _jobs[job_id].status = "completed"
        _jobs[job_id].progress = 1.0
        _jobs[job_id].current_step = steps
        _jobs[job_id].audios = audio_results
        _jobs[job_id].elapsed_seconds = time.time() - start_time

        logger.info(f"Music job {job_id} completed in {_jobs[job_id].elapsed_seconds:.1f}s")

    except Exception as e:
        music_progress.finish()
        logger.exception(f"Music job {job_id} failed: {e}")
        _jobs[job_id].status = "failed"
        _jobs[job_id].error = str(e)
        _jobs[job_id].elapsed_seconds = time.time() - start_time


@router.get("/status/{job_id}", response_model=MusicStatusResponse)
async def get_job_status(job_id: str) -> MusicStatusResponse:
    """Get music generation job status."""
    if job_id not in _jobs:
        raise HTTPException(404, f"Job not found: {job_id}")

    job = _jobs[job_id]
    if job.status == "processing" and job_id in _job_start_times:
        job.elapsed_seconds = time.time() - _job_start_times[job_id]

    return job


@router.get("/progress")
async def get_music_progress():
    """Get current music generation progress."""
    return music_progress.to_dict()


@router.get("/download/{job_id}/{audio_index}")
async def download_audio(job_id: str, audio_index: int) -> FileResponse:
    """Download a generated audio file."""
    music_dir = Path("data/music") / job_id
    if not music_dir.exists():
        raise HTTPException(404, "Audio not found")

    # Find audio files sorted by name, pick by index
    audio_files = sorted(
        f for f in music_dir.iterdir()
        if f.is_file() and f.suffix in (".wav", ".flac", ".mp3")
    )

    if audio_index >= len(audio_files):
        raise HTTPException(404, "Audio file not found")

    audio_file = audio_files[audio_index]
    media_type = {
        ".wav": "audio/wav",
        ".flac": "audio/flac",
        ".mp3": "audio/mpeg",
    }.get(audio_file.suffix, "audio/wav")

    return FileResponse(
        audio_file,
        media_type=media_type,
        filename=f"music_{job_id}_{audio_index}{audio_file.suffix}",
    )


@router.delete("/{job_id}")
async def delete_music_job(job_id: str) -> dict:
    """Delete a music job and its files."""
    import shutil

    music_dir = Path("data/music") / job_id
    if music_dir.exists():
        shutil.rmtree(music_dir)

    if job_id in _jobs:
        del _jobs[job_id]
    if job_id in _job_start_times:
        del _job_start_times[job_id]

    return {"status": "deleted", "job_id": job_id}
