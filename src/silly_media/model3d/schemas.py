"""Schemas for 3D model generation APIs."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field


class Model3DRequest(BaseModel):
    """Request for 3D model generation.

    Provide EITHER `text` (a reference image is auto-generated first) OR
    `image` (base64 PNG/JPG, or an http(s) URL). This mirrors the blender-mcp
    Hunyuan3D LOCAL_API contract so Blender can POST here directly.
    """

    text: Annotated[
        str | None,
        Field(default=None, max_length=600, description="Text prompt (auto image -> 3D)"),
    ] = None
    image: Annotated[
        str | None,
        Field(default=None, description="Base64 image or http(s) URL (image -> 3D)"),
    ] = None
    octree_resolution: Annotated[
        int,
        Field(default=256, ge=64, le=512, description="Shape octree resolution (detail)"),
    ] = 256
    num_inference_steps: Annotated[
        int,
        Field(default=30, ge=1, le=100, description="Shape diffusion steps"),
    ] = 30
    guidance_scale: Annotated[
        float,
        Field(default=5.5, ge=0.0, le=15.0, description="Shape guidance scale"),
    ] = 5.5
    texture: Annotated[
        bool,
        Field(default=True, description="Paint a texture onto the mesh"),
    ] = True
    target_faces: Annotated[
        int,
        Field(
            default=10000,
            ge=500,
            le=300000,
            description="Decimate mesh to ~this many faces (low number = low-poly)",
        ),
    ] = 10000
    seed: Annotated[
        int,
        Field(default=-1, ge=-1, description="Random seed (-1 for random)"),
    ] = -1
    # Only used by the text path: which image model to generate the reference with.
    image_model: Annotated[
        str,
        Field(default="z-image-turbo", description="Image model for the text->image step"),
    ] = "z-image-turbo"
    # Controls how the text->image reference is framed so the 3D result is the
    # thing you asked for (a person vs an isolated object vs a building).
    subject: Annotated[
        Literal["character", "object", "building", "auto"],
        Field(default="character", description="Reference framing: character/object/building/auto"),
    ] = "character"


class Model3DInfo(BaseModel):
    """Information about a 3D model backend."""

    id: str
    name: str
    loaded: bool
    supports_texture: bool
    estimated_vram_gb: float


class Model3DListResponse(BaseModel):
    """List of available 3D model backends."""

    models: list[Model3DInfo]
