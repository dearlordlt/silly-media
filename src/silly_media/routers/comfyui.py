"""ComfyUI-compatible API endpoints.

Implements the core ComfyUI REST + WebSocket API so that clients expecting
a ComfyUI backend can generate images via Silly Media's z-image-turbo.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import platform
import sys
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

from ..comfyui.node_info import NODE_INFO
from ..comfyui.workflow_parser import parse_workflow
from ..schemas import GenerateRequest
from ..vram_manager import vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(tags=["comfyui"])

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------
COMFY_OUTPUT_DIR = Path("data/comfy/output")
COMFY_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# Global image counter (ComfyUI names files ComfyUI_00001_.png, etc.)
_image_counter: int = 0


def _next_image_counter() -> int:
    global _image_counter
    _image_counter += 1
    return _image_counter


# ---------------------------------------------------------------------------
# Job tracking
# ---------------------------------------------------------------------------
@dataclass
class ComfyJob:
    prompt_id: str
    status: str  # "queued", "processing", "completed", "failed"
    workflow: dict
    save_node_id: str = "output"
    outputs: dict = field(default_factory=dict)
    error: str | None = None
    started_at: float = 0.0
    completed_at: float = 0.0
    # Parsed generation params (for progress)
    total_steps: int = 9
    current_step: int = 0


_jobs: dict[str, ComfyJob] = {}

# ---------------------------------------------------------------------------
# WebSocket clients
# ---------------------------------------------------------------------------
_ws_clients: dict[str, WebSocket] = {}


async def _broadcast_ws(message: dict) -> None:
    """Send a JSON message to all connected WebSocket clients."""
    data = json.dumps(message)
    stale: list[str] = []
    for client_id, ws in _ws_clients.items():
        try:
            await ws.send_text(data)
        except Exception:
            stale.append(client_id)
    for cid in stale:
        _ws_clients.pop(cid, None)


# ---------------------------------------------------------------------------
# Background generation
# ---------------------------------------------------------------------------
async def _run_comfy_job(prompt_id: str, gen_request: GenerateRequest) -> None:
    """Background task: generate image and update job."""
    job = _jobs[prompt_id]
    job.status = "processing"
    job.started_at = time.time()

    total_steps = gen_request.num_inference_steps or 9
    job.total_steps = total_steps

    # Notify WS: execution_start
    await _broadcast_ws({
        "type": "execution_start",
        "data": {"prompt_id": prompt_id},
    })

    def progress_callback(pipe, step_index, timestep, callback_kwargs):
        job.current_step = step_index + 1
        # We can't await from a sync callback, so fire-and-forget
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_broadcast_ws({
                    "type": "progress",
                    "data": {"value": step_index + 1, "max": total_steps, "prompt_id": prompt_id},
                }))
        except RuntimeError:
            pass
        return callback_kwargs

    try:
        async with vram_manager.acquire_gpu("z-image-turbo") as model:
            image = await asyncio.to_thread(
                model.generate, gen_request, progress_callback
            )

        # Save image
        counter = _next_image_counter()
        filename = f"ComfyUI_{counter:05d}_.png"
        filepath = COMFY_OUTPUT_DIR / filename
        buf = io.BytesIO()
        image.save(buf, format="PNG")
        filepath.write_bytes(buf.getvalue())

        job.status = "completed"
        job.completed_at = time.time()
        job.current_step = total_steps
        job.outputs = {
            job.save_node_id: {
                "images": [
                    {"filename": filename, "subfolder": "", "type": "output"}
                ]
            }
        }

        # Notify WS: executed
        await _broadcast_ws({
            "type": "executed",
            "data": {
                "node": job.save_node_id,
                "output": job.outputs[job.save_node_id],
                "prompt_id": prompt_id,
            },
        })

        logger.info(
            "ComfyUI job %s completed in %.1fs -> %s",
            prompt_id,
            job.completed_at - job.started_at,
            filename,
        )

    except Exception as e:
        logger.exception("ComfyUI job %s failed: %s", prompt_id, e)
        job.status = "failed"
        job.error = str(e)
        job.completed_at = time.time()

    # Notify WS: status update (queue now empty)
    remaining = sum(1 for j in _jobs.values() if j.status in ("queued", "processing"))
    await _broadcast_ws({
        "type": "status",
        "data": {"status": {"exec_info": {"queue_remaining": remaining}}},
    })


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/prompt")
async def submit_prompt(request: dict) -> dict:
    """Submit a ComfyUI workflow for execution."""
    workflow = request.get("prompt")
    if not workflow or not isinstance(workflow, dict):
        raise HTTPException(400, {"error": "Missing or invalid 'prompt' field", "node_errors": {}})

    # Parse workflow into generation params
    try:
        gen_request, save_node_id = parse_workflow(workflow)
    except Exception as e:
        raise HTTPException(400, {"error": f"Failed to parse workflow: {e}", "node_errors": {}})

    prompt_id = uuid.uuid4().hex[:12]
    job = ComfyJob(
        prompt_id=prompt_id,
        status="queued",
        workflow=workflow,
        save_node_id=save_node_id,
        total_steps=gen_request.num_inference_steps or 9,
    )
    _jobs[prompt_id] = job

    # Launch generation in background
    asyncio.create_task(_run_comfy_job(prompt_id, gen_request))

    # Notify WS: queue updated
    remaining = sum(1 for j in _jobs.values() if j.status in ("queued", "processing"))
    await _broadcast_ws({
        "type": "status",
        "data": {"status": {"exec_info": {"queue_remaining": remaining}}},
    })

    return {"prompt_id": prompt_id, "number": remaining - 1}


@router.get("/queue")
async def get_queue() -> dict:
    """Get the current execution queue."""
    running = []
    pending = []
    for pid, job in _jobs.items():
        entry = [0, pid, job.workflow, {}, [job.save_node_id]]
        if job.status == "processing":
            running.append(entry)
        elif job.status == "queued":
            pending.append(entry)
    return {"queue_running": running, "queue_pending": pending}


@router.post("/queue")
async def clear_queue(request: dict | None = None) -> dict:
    """Clear items from queue."""
    # ComfyUI sends {"clear": true} or {"delete": [prompt_ids]}
    if request and request.get("clear"):
        to_remove = [pid for pid, j in _jobs.items() if j.status in ("queued", "pending")]
        for pid in to_remove:
            del _jobs[pid]
    if request and "delete" in request:
        for pid in request["delete"]:
            _jobs.pop(pid, None)
    return {}


@router.get("/history")
async def get_all_history() -> dict:
    """Get history of all completed/failed jobs."""
    result = {}
    for pid, job in _jobs.items():
        if job.status in ("completed", "failed"):
            result[pid] = _format_history_entry(job)
    return result


@router.get("/history/{prompt_id}")
async def get_history(prompt_id: str) -> dict:
    """Get history for a specific prompt."""
    job = _jobs.get(prompt_id)
    if not job:
        return {}

    # If still processing, return empty (ComfyUI convention)
    if job.status in ("queued", "processing"):
        return {}

    return {prompt_id: _format_history_entry(job)}


@router.post("/history")
async def clear_history(request: dict | None = None) -> dict:
    """Clear history."""
    if request and request.get("clear"):
        to_remove = [pid for pid, j in _jobs.items() if j.status in ("completed", "failed")]
        for pid in to_remove:
            del _jobs[pid]
    if request and "delete" in request:
        for pid in request["delete"]:
            _jobs.pop(pid, None)
    return {}


def _format_history_entry(job: ComfyJob) -> dict:
    """Format a job as a ComfyUI history entry."""
    status_str = "success" if job.status == "completed" else "error"
    messages: list = []
    if job.error:
        messages.append(["execution_error", {"message": job.error}])

    return {
        "prompt": [0, job.prompt_id, job.workflow, {}, [job.save_node_id]],
        "outputs": job.outputs,
        "status": {
            "status_str": status_str,
            "completed": True,
            "messages": messages,
        },
    }


@router.get("/view")
async def view_image(
    filename: str = Query(...),
    subfolder: str = Query(default=""),
    type: str = Query(default="output"),
) -> FileResponse:
    """Serve a generated image file (ComfyUI /view endpoint)."""
    # Sanitize path components
    filename = Path(filename).name  # strip any directory traversal
    if subfolder:
        subfolder = Path(subfolder).name

    if type == "output":
        base = COMFY_OUTPUT_DIR
    else:
        base = COMFY_OUTPUT_DIR  # all types map to our output dir

    if subfolder:
        filepath = base / subfolder / filename
    else:
        filepath = base / filename

    if not filepath.exists():
        raise HTTPException(404, "File not found")

    return FileResponse(filepath, media_type="image/png")


@router.get("/system_stats")
async def system_stats() -> dict:
    """Return system stats in ComfyUI format."""
    devices = []
    try:
        import torch

        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(0)
            free, total = torch.cuda.mem_get_info(0)
            devices.append({
                "name": props.name,
                "type": "cuda",
                "index": 0,
                "vram_total": total,
                "vram_free": free,
                "torch_vram_total": total,
                "torch_vram_free": free,
            })
    except Exception:
        pass

    return {
        "system": {
            "os": platform.system().lower(),
            "python_version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
            "embedded_python": False,
            "comfyui_version": "0.0.1",  # fake
        },
        "devices": devices,
    }


@router.get("/object_info")
async def get_object_info() -> dict:
    """Return all available node type definitions."""
    return NODE_INFO


@router.get("/object_info/{node_class}")
async def get_node_info(node_class: str) -> dict:
    """Return definition for a specific node type."""
    if node_class not in NODE_INFO:
        raise HTTPException(404, f"Node class not found: {node_class}")
    return {node_class: NODE_INFO[node_class]}


@router.get("/embeddings")
async def list_embeddings() -> list:
    """Return available embeddings (stub - empty)."""
    return []


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

@router.websocket("/ws")
async def comfy_websocket(websocket: WebSocket, clientId: str = ""):
    """ComfyUI WebSocket endpoint for real-time status updates."""
    await websocket.accept()

    cid = clientId or uuid.uuid4().hex[:8]
    _ws_clients[cid] = websocket
    logger.info("ComfyUI WebSocket client connected: %s", cid)

    # Send initial status
    remaining = sum(1 for j in _jobs.values() if j.status in ("queued", "processing"))
    try:
        await websocket.send_text(json.dumps({
            "type": "status",
            "data": {"status": {"exec_info": {"queue_remaining": remaining}}, "sid": cid},
        }))
    except Exception:
        pass

    try:
        # Keep connection alive, listen for pings
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                # ComfyUI clients may send pings or other messages - just ignore
            except asyncio.TimeoutError:
                # Send a keepalive status
                try:
                    remaining = sum(1 for j in _jobs.values() if j.status in ("queued", "processing"))
                    await websocket.send_text(json.dumps({
                        "type": "status",
                        "data": {"status": {"exec_info": {"queue_remaining": remaining}}},
                    }))
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        _ws_clients.pop(cid, None)
        logger.info("ComfyUI WebSocket client disconnected: %s", cid)
