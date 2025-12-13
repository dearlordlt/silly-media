"""Video generation API endpoints."""

import asyncio
import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse

from ..db import create_video_job, delete_video_job, get_video_job, get_video_jobs
from ..video import VideoRegistry
from ..video.schemas import (
    I2VRequest,
    T2VRequest,
    VideoHistoryResponse,
    VideoJobResponse,
    VideoModelInfo,
    VideoModelsResponse,
    VideoStatusResponse,
)
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/video", tags=["video"])

# In-memory job status tracking
_jobs: dict[str, VideoStatusResponse] = {}
_job_start_times: dict[str, float] = {}  # Track start times for elapsed calculation


@router.get("/models", response_model=VideoModelsResponse)
async def list_video_models() -> VideoModelsResponse:
    """List available video generation models."""
    available = vram_manager.get_available_models(ModelType.VIDEO)
    loaded = vram_manager.get_loaded_models()

    models = []
    for name in available:
        model = VideoRegistry.get_model(name)
        models.append(
            VideoModelInfo(
                id=name,
                name=model.display_name,
                loaded=name in loaded,
                supports_t2v=model.supports_t2v,
                supports_i2v=model.supports_i2v,
                estimated_vram_gb=model.estimated_vram_gb,
            )
        )

    return VideoModelsResponse(models=models)


@router.post("/t2v/{model}", response_model=VideoJobResponse)
async def generate_t2v(
    model: str,
    request: T2VRequest,
    background_tasks: BackgroundTasks,
) -> VideoJobResponse:
    """Start text-to-video generation.

    Returns a job ID that can be used to poll for status.
    Generation typically takes 60-90 seconds on RTX 4090.
    """
    if model not in vram_manager.get_available_models(ModelType.VIDEO):
        raise HTTPException(status_code=404, detail=f"Unknown video model: {model}")

    job_id = str(uuid.uuid4())[:8]

    # Initialize job status
    _jobs[job_id] = VideoStatusResponse(
        job_id=job_id,
        status="queued",
        progress=0.0,
        current_step=0,
        total_steps=request.num_inference_steps,
        elapsed_seconds=None,
        video_url=None,
        thumbnail_url=None,
        error=None,
    )

    # Add background task
    background_tasks.add_task(_run_t2v_job, job_id, model, request)

    # Estimate time based on steps and frames
    estimated_time = (request.num_inference_steps / 50) * 75  # ~75s for 50 steps

    return VideoJobResponse(
        job_id=job_id,
        status="queued",
        estimated_time_seconds=estimated_time,
    )


@router.post("/i2v/{model}", response_model=VideoJobResponse)
async def generate_i2v(
    model: str,
    request: I2VRequest,
    background_tasks: BackgroundTasks,
) -> VideoJobResponse:
    """Start image-to-video generation.

    The input image will be used as the first frame and animated based on the prompt.
    Image will be automatically resized to match the target resolution.
    Returns a job ID that can be used to poll for status.
    """
    if model not in vram_manager.get_available_models(ModelType.VIDEO):
        raise HTTPException(status_code=404, detail=f"Unknown video model: {model}")

    job_id = str(uuid.uuid4())[:8]

    # Initialize job status
    _jobs[job_id] = VideoStatusResponse(
        job_id=job_id,
        status="queued",
        progress=0.0,
        current_step=0,
        total_steps=request.num_inference_steps,
        elapsed_seconds=None,
        video_url=None,
        thumbnail_url=None,
        error=None,
    )

    # Add background task
    background_tasks.add_task(_run_i2v_job, job_id, model, request)

    # Estimate time
    estimated_time = (request.num_inference_steps / 50) * 75

    return VideoJobResponse(
        job_id=job_id,
        status="queued",
        estimated_time_seconds=estimated_time,
    )


async def _run_t2v_job(job_id: str, model_name: str, request: T2VRequest) -> None:
    """Background task for T2V generation."""
    start_time = time.time()
    _job_start_times[job_id] = start_time
    _jobs[job_id].status = "processing"

    # Note: HunyuanVideo15Pipeline doesn't support progress callbacks
    # Elapsed time is calculated on status poll instead

    try:
        async with vram_manager.acquire_gpu(model_name) as model:
            output_path = await asyncio.to_thread(
                model.generate_t2v, request, None
            )

        # Calculate duration
        duration_seconds = request.num_frames / request.fps

        # Save to database
        await create_video_job(
            job_id=job_id,
            model=model_name,
            prompt=request.prompt,
            resolution=request.resolution.value,
            aspect_ratio=request.aspect_ratio.value,
            num_frames=request.num_frames,
            video_path=str(output_path),
            duration_seconds=duration_seconds,
        )

        # Update job status
        _jobs[job_id].status = "completed"
        _jobs[job_id].progress = 1.0
        _jobs[job_id].current_step = request.num_inference_steps
        _jobs[job_id].video_url = f"/video/download/{job_id}"
        _jobs[job_id].thumbnail_url = f"/video/thumbnail/{job_id}"
        _jobs[job_id].elapsed_seconds = time.time() - start_time

        logger.info(f"T2V job {job_id} completed in {_jobs[job_id].elapsed_seconds:.1f}s")

    except Exception as e:
        logger.error(f"T2V job {job_id} failed: {e}")
        _jobs[job_id].status = "failed"
        _jobs[job_id].error = str(e)
        _jobs[job_id].elapsed_seconds = time.time() - start_time


async def _run_i2v_job(job_id: str, model_name: str, request: I2VRequest) -> None:
    """Background task for I2V generation."""
    start_time = time.time()
    _job_start_times[job_id] = start_time
    _jobs[job_id].status = "processing"

    # Note: HunyuanVideo15ImageToVideoPipeline doesn't support progress callbacks
    # Progress will show as "processing" until complete

    try:
        async with vram_manager.acquire_gpu(model_name) as model:
            output_path = await asyncio.to_thread(
                model.generate_i2v, request, None
            )

        # Calculate duration
        duration_seconds = request.num_frames / request.fps

        # Save to database
        await create_video_job(
            job_id=job_id,
            model=model_name,
            prompt=request.prompt,
            resolution=request.resolution.value,
            aspect_ratio=request.aspect_ratio.value,
            num_frames=request.num_frames,
            video_path=str(output_path),
            duration_seconds=duration_seconds,
        )

        # Update job status
        _jobs[job_id].status = "completed"
        _jobs[job_id].progress = 1.0
        _jobs[job_id].current_step = request.num_inference_steps
        _jobs[job_id].video_url = f"/video/download/{job_id}"
        _jobs[job_id].thumbnail_url = f"/video/thumbnail/{job_id}"
        _jobs[job_id].elapsed_seconds = time.time() - start_time

        logger.info(f"I2V job {job_id} completed in {_jobs[job_id].elapsed_seconds:.1f}s")

    except Exception as e:
        logger.error(f"I2V job {job_id} failed: {e}")
        _jobs[job_id].status = "failed"
        _jobs[job_id].error = str(e)
        _jobs[job_id].elapsed_seconds = time.time() - start_time


@router.get("/status/{job_id}", response_model=VideoStatusResponse)
async def get_job_status(job_id: str) -> VideoStatusResponse:
    """Get video generation job status.

    Poll this endpoint to track generation progress.
    """
    if job_id not in _jobs:
        # Check database for completed jobs
        video = await get_video_job(job_id)
        if video:
            return VideoStatusResponse(
                job_id=job_id,
                status="completed",
                progress=1.0,
                video_url=f"/video/download/{job_id}",
                thumbnail_url=f"/video/thumbnail/{job_id}",
            )
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    # Calculate elapsed time for in-progress jobs
    job = _jobs[job_id]
    if job.status == "processing" and job_id in _job_start_times:
        job.elapsed_seconds = time.time() - _job_start_times[job_id]

    return job


@router.get("/download/{job_id}")
async def download_video(job_id: str) -> FileResponse:
    """Download completed video as MP4."""
    video = await get_video_job(job_id)
    if not video or not video.video_path:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = Path(video.video_path)
    if not video_path.exists():
        raise HTTPException(status_code=404, detail="Video file not found")

    return FileResponse(
        video_path,
        media_type="video/mp4",
        filename=f"video_{job_id}.mp4",
    )


@router.get("/thumbnail/{job_id}")
async def get_thumbnail(job_id: str) -> FileResponse:
    """Get video thumbnail (first frame as JPEG)."""
    video = await get_video_job(job_id)
    if not video or not video.video_path:
        raise HTTPException(status_code=404, detail="Video not found")

    video_path = Path(video.video_path)
    thumb_path = video_path.with_name(f"{video_path.stem}_thumb.jpg")

    if not thumb_path.exists():
        raise HTTPException(status_code=404, detail="Thumbnail not found")

    return FileResponse(thumb_path, media_type="image/jpeg")


@router.delete("/{job_id}")
async def delete_video(job_id: str) -> dict:
    """Delete a video and its associated files."""
    video = await get_video_job(job_id)
    if not video:
        raise HTTPException(status_code=404, detail="Video not found")

    # Delete files
    if video.video_path:
        video_path = Path(video.video_path)
        if video_path.exists():
            video_path.unlink()

        thumb_path = video_path.with_name(f"{video_path.stem}_thumb.jpg")
        if thumb_path.exists():
            thumb_path.unlink()

    # Delete from database
    await delete_video_job(job_id)

    # Remove from in-memory tracking
    if job_id in _jobs:
        del _jobs[job_id]

    return {"status": "deleted", "job_id": job_id}


@router.get("/history", response_model=VideoHistoryResponse)
async def get_video_history(
    limit: int = 50,
    offset: int = 0,
) -> VideoHistoryResponse:
    """Get list of generated videos."""
    videos, total = await get_video_jobs(limit=limit, offset=offset)

    return VideoHistoryResponse(
        videos=[
            {
                "id": v.id,
                "prompt": v.prompt,
                "model": v.model,
                "resolution": v.resolution,
                "aspect_ratio": v.aspect_ratio,
                "num_frames": v.num_frames,
                "duration_seconds": v.duration_seconds,
                "created_at": v.created_at,
                "thumbnail_url": f"/video/thumbnail/{v.id}" if v.video_path else None,
            }
            for v in videos
        ],
        total=total,
    )
