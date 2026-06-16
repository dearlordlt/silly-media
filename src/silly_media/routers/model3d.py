"""3D model generation API endpoints.

POST /model3d/generate is intentionally synchronous and returns raw GLB bytes,
matching the blender-mcp Hunyuan3D LOCAL_API contract (it POSTs {text|image,
octree_resolution, num_inference_steps, guidance_scale, texture} to
`{base_url}/generate` and writes the response body straight to a .glb). Point
the Blender addon's Hunyuan3D API URL at `http://<host>:4201/model3d`.
"""

import asyncio
import base64
import binascii
import io
import logging
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, Response
from PIL import Image

from ..model3d import Model3DRegistry
from ..model3d.schemas import Model3DInfo, Model3DListResponse, Model3DRequest
from ..schemas import AspectRatio, GenerateRequest
from ..vram_manager import ModelType, vram_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/model3d", tags=["model3d"])

_MODELS_DIR = Path("data/models")
_GLB_MEDIA = "model/gltf-binary"


@router.get("/models", response_model=Model3DListResponse)
async def list_model3d_models() -> Model3DListResponse:
    """List available 3D generation backends."""
    available = vram_manager.get_available_models(ModelType.MODEL3D)
    loaded = vram_manager.get_loaded_models()
    models = []
    for name in available:
        m = Model3DRegistry.get_model(name)
        models.append(
            Model3DInfo(
                id=name,
                name=m.display_name,
                loaded=name in loaded,
                supports_texture=m.supports_texture,
                estimated_vram_gb=m.estimated_vram_gb,
            )
        )
    return Model3DListResponse(models=models)


def _decode_image(image_field: str) -> Image.Image:
    """Decode the `image` field: data URL, raw base64, or http(s) URL."""
    if image_field.startswith("http://") or image_field.startswith("https://"):
        with urllib.request.urlopen(image_field, timeout=30) as resp:  # noqa: S310
            data = resp.read()
        return Image.open(io.BytesIO(data)).convert("RGB")

    # Strip a data URL prefix if present.
    if image_field.startswith("data:") and "," in image_field:
        image_field = image_field.split(",", 1)[1]
    try:
        data = base64.b64decode(image_field)
    except (binascii.Error, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 image: {e}")
    return Image.open(io.BytesIO(data)).convert("RGB")


# Framing templates per subject type. A clean, isolated reference image is what
# makes the 3D reconstruction come out as the thing you actually asked for.
_FRAMING = {
    "character": (
        "{p}, single character, full body, centered, facing forward, A-pose, "
        "plain solid background, even studio lighting",
        AspectRatio.PORTRAIT_3_4,
    ),
    "object": (
        "{p}, single object, centered, isolated on plain white background, "
        "product shot, studio lighting, no people, no hands, no character",
        AspectRatio.SQUARE,
    ),
    "building": (
        "{p}, single building, centered, three-quarter isometric view, "
        "isolated on plain background, architectural render, no people",
        AspectRatio.SQUARE,
    ),
    "auto": (
        "{p}, single subject, centered, isolated on plain background, studio lighting",
        AspectRatio.SQUARE,
    ),
}


async def _image_from_text(
    prompt: str, image_model: str, seed: int, subject: str = "character"
) -> Image.Image:
    """Generate a reference image from text using an existing image model."""
    if image_model not in vram_manager.get_available_models(ModelType.IMAGE):
        # Fall back to whatever image model is available.
        avail = vram_manager.get_available_models(ModelType.IMAGE)
        if not avail:
            raise HTTPException(status_code=500, detail="No image model available for text->3D")
        image_model = avail[0]

    template, ar = _FRAMING.get(subject, _FRAMING["character"])
    framed = template.format(p=prompt)
    req = GenerateRequest(
        prompt=framed,
        aspect_ratio=ar,
        base_size=1024,
        seed=None if seed < 0 else seed,
    )
    async with vram_manager.acquire_gpu(image_model) as model_instance:
        image = await asyncio.to_thread(model_instance.generate, req, None)
    return image.convert("RGB")


@router.post(
    "/generate",
    responses={
        200: {"content": {_GLB_MEDIA: {}}, "description": "Generated GLB model"},
        400: {"description": "Invalid request"},
        500: {"description": "Generation failed"},
    },
)
async def generate_model3d(request: Model3DRequest, model: str = "hunyuan3d-2") -> Response:
    """Generate a textured 3D model (.glb) from text or an image.

    Synchronous: blocks until the GLB is ready and returns the bytes. Provide
    `text` (auto image -> 3D) or `image` (base64/URL, image -> 3D).
    """
    if model not in vram_manager.get_available_models(ModelType.MODEL3D):
        raise HTTPException(status_code=404, detail=f"Unknown 3D model: {model}")
    if not request.text and not request.image:
        raise HTTPException(status_code=400, detail="Provide either 'text' or 'image'")

    # 1) Resolve a reference image.
    if request.image:
        image = _decode_image(request.image)
    else:
        logger.info(
            f"text->3D ({request.subject}): generating reference for: {request.text[:60]}..."
        )
        image = await _image_from_text(
            request.text, request.image_model, request.seed, request.subject
        )

    # 2) Image -> 3D (separate GPU acquisition; VRAM manager swaps models).
    try:
        async with vram_manager.acquire_gpu(model) as model_instance:
            glb_path: Path = await asyncio.to_thread(model_instance.generate, image, request)
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("3D generation failed")
        raise HTTPException(status_code=500, detail=f"3D generation failed: {e}")

    # Keep the reference image (the source z-image / uploaded image) next to the
    # GLB so the UI can show what actually fed the reconstruction.
    model_id = Path(glb_path).stem
    try:
        image.save(_MODELS_DIR / f"{model_id}_ref.png")
    except Exception as e:  # non-fatal
        logger.warning(f"Could not save reference image: {e}")

    data = Path(glb_path).read_bytes()
    return Response(
        content=data,
        media_type=_GLB_MEDIA,
        headers={
            "X-Model-Id": model_id,
            "X-Ref-Url": f"/model3d/ref/{model_id}",
            "Content-Disposition": f'attachment; filename="{Path(glb_path).name}"',
        },
    )


@router.get("/ref/{model_id}")
async def get_reference(model_id: str) -> FileResponse:
    """Get the reference image used to build a model (the text->image result)."""
    safe = "".join(c for c in model_id if c.isalnum())
    path = _MODELS_DIR / f"{safe}_ref.png"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Reference image not found")
    return FileResponse(path, media_type="image/png")


@router.get("/download/{model_id}")
async def download_model3d(model_id: str) -> FileResponse:
    """Download a previously generated GLB by its id."""
    # Guard against path traversal — ids are 8-char hex stems.
    safe = "".join(c for c in model_id if c.isalnum())
    path = _MODELS_DIR / f"{safe}.glb"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Model not found")
    return FileResponse(path, media_type=_GLB_MEDIA, filename=f"{safe}.glb")


@router.get("/list")
async def list_generated(limit: int = 50) -> dict:
    """List recently generated GLB files (most recent first)."""
    if not _MODELS_DIR.exists():
        return {"models": []}
    files = sorted(_MODELS_DIR.glob("*.glb"), key=lambda p: p.stat().st_mtime, reverse=True)
    out = []
    for p in files[:limit]:
        entry = {"id": p.stem, "url": f"/model3d/download/{p.stem}", "size_bytes": p.stat().st_size}
        if (_MODELS_DIR / f"{p.stem}_ref.png").exists():
            entry["ref_url"] = f"/model3d/ref/{p.stem}"
        out.append(entry)
    return {"models": out}
