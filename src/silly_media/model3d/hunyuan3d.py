"""Hunyuan3D-2 image-to-3D model implementation.

Wraps Tencent's hy3dgen pipelines:
  - Hunyuan3DDiTFlowMatchingPipeline  (image -> mesh)
  - Hunyuan3DPaintPipeline            (mesh + image -> textured mesh)
  - rembg.BackgroundRemover           (isolate the subject)

Post-processing (FloaterRemover / DegenerateFaceRemover / FaceReducer) cleans
the mesh and decimates it toward a target face count for a low-poly look.
"""

import gc
import logging
import random
import uuid
from pathlib import Path

import torch
from PIL import Image

from .base import BaseModel3D
from .schemas import Model3DRequest

logger = logging.getLogger(__name__)


# transformers >=5.17 renamed DINOv2's parameters (attention.attention.query ->
# attention.q_proj, fused SwiGLU mlp.weights_in -> gate_proj + up_proj, ...).
# Its from_pretrained converts old checkpoints on the fly, but hy3dgen loads the
# conditioner's DINOv2 through a plain load_state_dict, so apply the same renames
# (transformers' conversion_mapping for Dinov2Model) before it does.
_DINOV2_RENAMES = (
    ("attention.attention.query", "attention.q_proj"),
    ("attention.attention.key", "attention.k_proj"),
    ("attention.attention.value", "attention.v_proj"),
    ("attention.output.dense", "attention.o_proj"),
    ("mlp.weights_out", "mlp.down_proj"),
)


def _convert_legacy_dinov2_keys(state_dict: dict, expected: set[str]) -> dict:
    """Rename old-style DINOv2 keys the model no longer has; others pass through."""
    converted = {}
    for key, value in state_dict.items():
        new_key = key
        if key not in expected:
            for old, new in _DINOV2_RENAMES:
                new_key = new_key.replace(old, new)
            if ".mlp.weights_in." in key:
                gate, up = value.chunk(2, dim=0)
                converted[new_key.replace("mlp.weights_in", "mlp.gate_proj")] = gate
                converted[new_key.replace("mlp.weights_in", "mlp.up_proj")] = up
                continue
        converted[new_key] = value
    return converted


def _patch_conditioner_loading() -> None:
    from hy3dgen.shapegen.models import conditioner as cond_module

    for cls in (cond_module.SingleImageEncoder, cond_module.DualImageEncoder):
        if getattr(cls.load_state_dict, "_dinov2_compat", False):
            continue
        orig = cls.load_state_dict

        def load_state_dict(self, state_dict, *args, _orig=orig, **kwargs):
            expected = set(self.state_dict().keys())
            return _orig(self, _convert_legacy_dinov2_keys(state_dict, expected), *args, **kwargs)

        load_state_dict._dinov2_compat = True
        cls.load_state_dict = load_state_dict


class Hunyuan3DModel(BaseModel3D):
    """Hunyuan3D-2: image-to-3D shape + texture generation."""

    model_id = "tencent/Hunyuan3D-2"
    display_name = "Hunyuan3D-2"
    estimated_vram_gb = 21.0
    default_steps = 30

    def __init__(self) -> None:
        super().__init__()
        self._shape_pipe = None
        self._paint_pipe = None
        self._rembg = None
        self._models_dir = Path("data/models")
        self._models_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> None:
        if self._loaded:
            return

        from hy3dgen.rembg import BackgroundRemover
        from hy3dgen.shapegen import Hunyuan3DDiTFlowMatchingPipeline

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        logger.info(f"Loading Hunyuan3D-2 shape pipeline from {self.model_id}...")
        _patch_conditioner_loading()
        self._shape_pipe = Hunyuan3DDiTFlowMatchingPipeline.from_pretrained(self.model_id)
        # Keep the heavy paint pipeline lazy: only load it when a textured
        # generation is actually requested (saves VRAM for shape-only runs).
        self._rembg = BackgroundRemover()
        self._loaded = True
        logger.info("Hunyuan3D-2 shape pipeline loaded")

    def _ensure_paint(self) -> None:
        if self._paint_pipe is not None:
            return
        from hy3dgen.texgen import Hunyuan3DPaintPipeline

        logger.info("Loading Hunyuan3D-2 paint (texture) pipeline...")
        self._paint_pipe = Hunyuan3DPaintPipeline.from_pretrained(self.model_id)
        logger.info("Hunyuan3D-2 paint pipeline loaded")

    def unload(self) -> None:
        logger.info("Unloading Hunyuan3D-2 pipelines...")
        for attr in ("_shape_pipe", "_paint_pipe", "_rembg"):
            obj = getattr(self, attr, None)
            if obj is not None:
                del obj
                setattr(self, attr, None)
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        self._loaded = False
        logger.info("Hunyuan3D-2 pipelines unloaded")

    def _postprocess(self, mesh, target_faces: int):
        """Clean and decimate the mesh toward target_faces (low-poly)."""
        from hy3dgen.shapegen import (
            DegenerateFaceRemover,
            FaceReducer,
            FloaterRemover,
        )

        try:
            mesh = FloaterRemover()(mesh)
            mesh = DegenerateFaceRemover()(mesh)
            mesh = FaceReducer()(mesh, max_facenum=target_faces)
        except Exception as e:  # post-processing is best-effort
            logger.warning(f"Mesh post-processing partially failed: {e}")
        return mesh

    def generate(self, image: Image.Image, request: Model3DRequest) -> Path:
        if not self._loaded:
            self.load()

        seed = request.seed if request.seed >= 0 else random.randint(0, 2**32 - 1)
        generator = torch.Generator(device="cuda").manual_seed(seed)

        # Isolate the subject (RGBA with alpha) for cleaner reconstruction.
        image = image.convert("RGB")
        rgba = self._rembg(image)

        logger.info(
            f"Hunyuan3D shape: steps={request.num_inference_steps}, "
            f"octree={request.octree_resolution}, guidance={request.guidance_scale}, seed={seed}"
        )
        mesh = self._shape_pipe(
            image=rgba,
            num_inference_steps=request.num_inference_steps,
            octree_resolution=request.octree_resolution,
            guidance_scale=request.guidance_scale,
            generator=generator,
        )[0]

        mesh = self._postprocess(mesh, request.target_faces)

        if request.texture:
            self._ensure_paint()
            logger.info("Hunyuan3D paint: applying texture...")
            mesh = self._paint_pipe(mesh, image=rgba)

        job_id = str(uuid.uuid4())[:8]
        out_path = self._models_dir / f"{job_id}.glb"
        mesh.export(str(out_path))
        logger.info(f"Mesh exported to {out_path}")
        return out_path
