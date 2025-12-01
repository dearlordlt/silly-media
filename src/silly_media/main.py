"""FastAPI application for image generation."""

import io
import logging
import signal
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Path
from fastapi.responses import Response

from .config import settings
from .models import ModelRegistry
from .schemas import AspectRatio, ErrorResponse, GenerateRequest, HealthResponse

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.log_level.upper()),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def handle_shutdown(signum, frame):
    """Handle shutdown signals gracefully."""
    logger.info("Shutdown signal received, unloading models...")
    ModelRegistry.unload_all()
    sys.exit(0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Setup signal handlers
    signal.signal(signal.SIGTERM, handle_shutdown)
    signal.signal(signal.SIGINT, handle_shutdown)

    # Configure idle timeout
    ModelRegistry.set_idle_timeout(settings.model_idle_timeout)

    # Optionally preload the default model
    if settings.model_preload:
        logger.info(f"Preloading default model: {settings.default_model}")
        try:
            ModelRegistry.load_model(settings.default_model)
        except Exception as e:
            logger.error(f"Failed to preload model: {e}")
    else:
        logger.info("Model preloading disabled, will load on first request")

    yield

    # Cleanup
    logger.info("Shutting down, unloading models...")
    ModelRegistry.unload_all()


app = FastAPI(
    title="Silly Media API",
    description="Multi-model text-to-image generation API",
    version="0.1.0",
    lifespan=lifespan,
)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint."""
    return HealthResponse(
        status="healthy",
        models_loaded=ModelRegistry.get_loaded_models(),
        available_models=ModelRegistry.get_available_models(),
    )


@app.get("/models")
async def list_models():
    """List available models."""
    return {
        "available": ModelRegistry.get_available_models(),
        "loaded": ModelRegistry.get_loaded_models(),
    }


@app.get("/aspect-ratios")
async def list_aspect_ratios():
    """List available aspect ratio presets."""
    from .schemas import ASPECT_RATIO_MAP, calculate_dimensions

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
    # Validate model exists
    if model not in ModelRegistry.get_available_models():
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model}' not found. Available: {ModelRegistry.get_available_models()}",
        )

    # Load model if needed
    try:
        model_instance = ModelRegistry.load_model(model)
    except Exception as e:
        logger.exception(f"Failed to load model {model}")
        raise HTTPException(status_code=500, detail=f"Failed to load model: {e}")

    # Generate image
    start_time = time.time()
    try:
        logger.info(
            f"Generation request: model={model}, prompt={request.prompt[:50]}..., "
            f"size={request.width}x{request.height}"
        )

        image = model_instance.generate(request)

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
