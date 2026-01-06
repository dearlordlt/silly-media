"""LLM text generation API router."""

import asyncio
import json
import logging
import queue
import threading

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..llm import LLMRegistry
from ..llm.schemas import LLMRequest, LLMResponse, StreamChunk
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/llm", tags=["llm"])

# Sentinel to signal end of stream
_STREAM_END = object()


@router.get("/models")
async def list_llm_models():
    """List available LLM models."""
    loaded = [
        m
        for m in vram_manager.get_loaded_models()
        if vram_manager.get_model_info(m)
        and vram_manager.get_model_info(m).model_type == ModelType.LLM
    ]
    return {
        "available": LLMRegistry.get_available_models(),
        "loaded": loaded,
    }


def _validate_request(request: LLMRequest) -> None:
    """Validate LLM request input."""
    if not request.messages and not request.prompt:
        raise HTTPException(400, "Either 'messages' or 'prompt' must be provided")

    if request.messages and request.prompt:
        raise HTTPException(400, "Provide either 'messages' or 'prompt', not both")


@router.post("/generate", response_model=LLMResponse)
async def generate_text(request: LLMRequest):
    """Generate text completion (non-streaming).

    Provide either 'messages' (chat format) or 'prompt' (raw text).

    Default parameters are tuned for creative writing:
    - temperature: 0.8 (creative but coherent)
    - top_p: 0.9 (nucleus sampling)
    - top_k: 50 (diversity)
    - repetition_penalty: 1.1 (avoid loops)
    """
    _validate_request(request)

    model_name = "huihui-qwen3-4b"

    try:
        async with vram_manager.acquire_gpu(model_name) as model:
            logger.info(
                f"LLM generation: temp={request.temperature}, "
                f"max_tokens={request.max_tokens}"
            )
            response = await asyncio.to_thread(model.generate, request)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("LLM generation failed")
        raise HTTPException(500, f"LLM generation failed: {e}")

    return response


@router.post("/stream")
async def stream_text(request: LLMRequest):
    """Generate text completion with streaming (SSE).

    Returns Server-Sent Events with JSON chunks:
    - data: {"delta": "token", "finish_reason": null}
    - data: {"delta": "", "finish_reason": "stop"}
    - data: [DONE]

    Same parameters as /llm/generate.
    """
    _validate_request(request)

    model_name = "huihui-qwen3-4b"

    async def generate_events():
        """Generate SSE events."""
        try:
            async with vram_manager.acquire_gpu(model_name) as model:
                logger.info(
                    f"LLM streaming: temp={request.temperature}, "
                    f"max_tokens={request.max_tokens}"
                )

                # Use a queue to bridge sync generator and async code
                token_queue: queue.Queue = queue.Queue()

                def run_generator():
                    """Run the sync generator and put tokens in queue."""
                    try:
                        for token in model.generate_stream(request):
                            token_queue.put(token)
                    except Exception as e:
                        token_queue.put(e)
                    finally:
                        token_queue.put(_STREAM_END)

                # Start generator in background thread
                thread = threading.Thread(target=run_generator, daemon=True)
                thread.start()

                # Yield tokens as they arrive
                while True:
                    # Use run_in_executor to avoid blocking the event loop
                    token = await asyncio.get_event_loop().run_in_executor(
                        None, token_queue.get
                    )

                    if token is _STREAM_END:
                        break

                    if isinstance(token, Exception):
                        raise token

                    chunk = StreamChunk(delta=token, finish_reason=None)
                    yield f"data: {chunk.model_dump_json()}\n\n"

                thread.join(timeout=1.0)

                # Send final chunk
                final_chunk = StreamChunk(delta="", finish_reason="stop")
                yield f"data: {final_chunk.model_dump_json()}\n\n"
                yield "data: [DONE]\n\n"

        except ValueError as e:
            error_data = json.dumps({"error": str(e)})
            yield f"data: {error_data}\n\n"
        except Exception as e:
            logger.exception("LLM streaming failed")
            error_data = json.dumps({"error": str(e)})
            yield f"data: {error_data}\n\n"

    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
