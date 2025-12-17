"""FastAPI application for image and audio generation."""

import asyncio
import io
import logging
import signal
import sys
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

from fastapi import FastAPI, HTTPException, Path
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .config import settings
from .models import ModelRegistry
from .schemas import AspectRatio, ErrorResponse, GenerateRequest
from .vram_manager import ModelType, vram_manager


@dataclass
class GenerationProgress:
    """Track progress of image generation."""
    active: bool = False
    step: int = 0
    total_steps: int = 0
    started_at: float = 0.0

    def start(self, total_steps: int):
        self.active = True
        self.step = 0
        self.total_steps = total_steps
        self.started_at = time.time()

    def update(self, step: int):
        self.step = step

    def finish(self):
        self.active = False
        self.step = 0
        self.total_steps = 0

    def to_dict(self):
        if not self.active:
            return {"active": False}
        return {
            "active": True,
            "step": self.step,
            "total_steps": self.total_steps,
            "percent": round(self.step / self.total_steps * 100) if self.total_steps > 0 else 0,
            "elapsed": round(time.time() - self.started_at, 1),
        }


# Global progress tracker
progress = GenerationProgress()

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def handle_shutdown(signum, frame):
    """Handle shutdown signals gracefully."""
    logger.info("Shutdown signal received, unloading models...")
    vram_manager.shutdown()
    sys.exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Setup signal handlers
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    # Initialize database
    from .db import init_db

    await init_db()
    logger.info("Database initialized")

    # Configure VRAMManager idle timeout
    vram_manager.set_idle_timeout(settings.model_idle_timeout)

    # Register image models with VRAMManager
    for name in ModelRegistry.get_available_models():
        model = ModelRegistry.get_model(name)
        vram_manager.register(
            name,
            ModelType.IMAGE,
            model,
            estimated_vram_gb=22.0,  # Default estimate for image models
        )
    logger.info(f"Registered image models: {ModelRegistry.get_available_models()}")

    # Register XTTS-v2 audio model
    from .audio.xtts import XTTSv2Model

    xtts = XTTSv2Model()
    vram_manager.register("xtts-v2", ModelType.AUDIO, xtts, estimated_vram_gb=2.0)
    logger.info("Registered audio model: xtts-v2")

    # Register Demucs model for vocal separation (YouTube voice extraction)
    from .audio.demucs_model import DemucsModel

    demucs = DemucsModel()
    vram_manager.register("demucs", ModelType.AUDIO, demucs, estimated_vram_gb=2.0)
    logger.info("Registered audio model: demucs (vocal separation)")

    # Register Maya TTS model (voice description-based synthesis)
    from .audio.maya import MayaModel

    maya = MayaModel()
    vram_manager.register("maya", ModelType.AUDIO, maya, estimated_vram_gb=16.0)
    logger.info("Registered audio model: maya (voice description TTS)")

    # Register video models with VRAMManager
    from .video import VideoRegistry

    for name in VideoRegistry.get_available_models():
        model = VideoRegistry.get_model(name)
        vram_manager.register(
            name,
            ModelType.VIDEO,
            model,
            estimated_vram_gb=getattr(model, "estimated_vram_gb", 16.0),
        )
    logger.info(f"Registered video models: {VideoRegistry.get_available_models()}")

    # Register vision models with VRAMManager
    from .vision import VisionRegistry

    for name in VisionRegistry.get_available_models():
        model = VisionRegistry.get_model(name)
        vram_manager.register(
            name,
            ModelType.VISION,
            model,
            estimated_vram_gb=getattr(model, "estimated_vram_gb", 18.0),
        )
    logger.info(f"Registered vision models: {VisionRegistry.get_available_models()}")

    # Optionally preload the default model
    if settings.model_preload:
        logger.info(f"Preloading default model: {settings.default_model}")
        try:
            async with vram_manager.acquire_gpu(settings.default_model):
                pass  # Just load it
            logger.info(f"Preloaded model: {settings.default_model}")
        except Exception as e:
            logger.error(f"Failed to preload model: {e}")
    else:
        logger.info("Model preloading disabled, will load on first request")

    yield

    # Cleanup
    logger.info("Shutting down...")
    vram_manager.shutdown()


app = FastAPI(
    title="Silly Media API",
    description="Multi-model text-to-image and text-to-speech generation API",
    version="0.2.0",
    lifespan=lifespan,
)

# Enable CORS for local UI (including file:// origins which report as "null")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=r".*",  # Allow all origins including null (file://)
    allow_credentials=False,  # Must be False when using allow_origins=["*"]
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers (imported here after app is created)
from .routers import actors_router, tts_router  # noqa: E402
from .routers.video import router as video_router  # noqa: E402
from .routers.vision import router as vision_router  # noqa: E402

app.include_router(actors_router)
app.include_router(tts_router)
app.include_router(video_router)
app.include_router(vision_router)


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "models_loaded": vram_manager.get_loaded_models(),
        "available_image_models": vram_manager.get_available_models(ModelType.IMAGE),
        "available_audio_models": vram_manager.get_available_models(ModelType.AUDIO),
        "available_video_models": vram_manager.get_available_models(ModelType.VIDEO),
        "available_vision_models": vram_manager.get_available_models(ModelType.VISION),
    }


@app.get("/models")
async def list_models():
    """List available models."""
    return {
        "image": {
            "available": vram_manager.get_available_models(ModelType.IMAGE),
            "loaded": [
                m for m in vram_manager.get_loaded_models()
                if vram_manager.get_model_info(m) and
                vram_manager.get_model_info(m).model_type == ModelType.IMAGE
            ],
        },
        "audio": {
            "available": vram_manager.get_available_models(ModelType.AUDIO),
            "loaded": [
                m for m in vram_manager.get_loaded_models()
                if vram_manager.get_model_info(m) and
                vram_manager.get_model_info(m).model_type == ModelType.AUDIO
            ],
        },
        "video": {
            "available": vram_manager.get_available_models(ModelType.VIDEO),
            "loaded": [
                m for m in vram_manager.get_loaded_models()
                if vram_manager.get_model_info(m) and
                vram_manager.get_model_info(m).model_type == ModelType.VIDEO
            ],
        },
        "vision": {
            "available": vram_manager.get_available_models(ModelType.VISION),
            "loaded": [
                m for m in vram_manager.get_loaded_models()
                if vram_manager.get_model_info(m) and
                vram_manager.get_model_info(m).model_type == ModelType.VISION
            ],
        },
    }


@app.get("/progress")
async def get_progress():
    """Get current generation progress."""
    return progress.to_dict()


@app.get("/aspect-ratios")
async def list_aspect_ratios():
    """List available aspect ratio presets."""
    from .schemas import calculate_dimensions

    return {
        ratio.value: {
            "name": ratio.name,
            "dimensions_at_1024": calculate_dimensions(ratio, 1024),
        }
        for ratio in AspectRatio
    }


@app.post(
    "/generate/{model}",
    responses={
        200: {"content": {"image/png": {}}, "description": "Generated image"},
        400: {"model": ErrorResponse, "description": "Invalid request"},
        404: {"model": ErrorResponse, "description": "Model not found"},
        500: {"model": ErrorResponse, "description": "Generation failed"},
    },
)
async def generate_image(
    model: str = Path(..., description="Model name (e.g., 'ovis-image-7b')"),
    request: GenerateRequest = ...,
):
    """Generate an image using the specified model."""
    # Validate model exists (check image models only)
    available_image_models = vram_manager.get_available_models(ModelType.IMAGE)
    if model not in available_image_models:
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model}' not found. Available: {available_image_models}",
        )

    # Generate image using VRAMManager for GPU coordination
    start_time = time.time()
    try:
        async with vram_manager.acquire_gpu(model) as model_instance:
            logger.info(
                f"Generation request: model={model}, prompt={request.prompt[:50]}..., "
                f"size={request.width}x{request.height}"
            )

            # Create progress callback
            def progress_callback(pipe, step, timestep, callback_kwargs):
                progress.update(step + 1)  # +1 because step is 0-indexed
                return callback_kwargs

            # Start progress tracking
            total_steps = request.num_inference_steps or model_instance.default_steps
            progress.start(total_steps)

            try:
                # Run in thread pool so event loop stays free for /progress polling
                image = await asyncio.to_thread(
                    model_instance.generate, request, progress_callback
                )
            finally:
                progress.finish()

            # Convert to PNG bytes
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            buffer.seek(0)

            elapsed = time.time() - start_time
            logger.info(f"Generation completed in {elapsed:.2f}s")

            return Response(content=buffer.getvalue(), media_type="image/png")

    except Exception as e:
        logger.exception("Generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


def main():
    """Run the API server."""
    import uvicorn

    uvicorn.run(
        "silly_media.main:app",
        host=settings.host,
        port=settings.port,
        log_level=settings.log_level.lower(),
    )


if __name__ == "__main__":
    main()
