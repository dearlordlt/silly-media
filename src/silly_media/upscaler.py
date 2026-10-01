"""Post-generation ESRGAN upscaling (optional `upscale` on /generate and /img2img/edit).

Runs after the generator inside the same GPU lock. The upscaler weights are small
(~67MB) and stay on the CPU between requests; inference is tiled so it fits next to
whatever image model is still resident.
"""

import logging
import math
import threading
from typing import Literal

import numpy as np
import torch
from PIL import Image

logger = logging.getLogger(__name__)

UpscaleModel = Literal["clean", "sharp"]

# clean: Real-ESRGAN x4plus, trained on degraded inputs, so it also removes grain,
#        noise and halftone-like texture (e.g. Qwen-Image 2.1's paper-print look).
# sharp: 4x-UltraSharp, keeps and sharpens fine detail (adds no smoothing).
UPSCALERS: dict[str, tuple[str, str]] = {
    "clean": ("lllyasviel/Annotators", "RealESRGAN_x4plus.pth"),
    "sharp": ("Kim2091/UltraSharp", "4x-UltraSharp.safetensors"),
}

MAX_OUTPUT_SIDE = 8192
TILE = 1024  # input pixels per tile; halved on OOM
TILE_OVERLAP = 128

_models: dict[str, object] = {}
_lock = threading.Lock()


def output_size(width: int, height: int, factor: float) -> tuple[int, int]:
    return round(width * factor), round(height * factor)


def _load(name: str):
    with _lock:
        if name not in _models:
            from huggingface_hub import hf_hub_download
            from spandrel import ModelLoader

            repo, filename = UPSCALERS[name]
            descriptor = ModelLoader().load_from_file(hf_hub_download(repo, filename))
            descriptor.model.eval()
            _models[name] = descriptor
            logger.info(f"Loaded upscaler '{name}' ({filename}, {descriptor.architecture.name} x{descriptor.scale})")
        return _models[name]


@torch.no_grad()
def _run_tiled(descriptor, image: torch.Tensor, tile: int) -> torch.Tensor:
    """image: (1, 3, H, W) float in [0, 1] on the model's device -> (1, 3, H*s, W*s).

    Tiles overlap and are feather-blended: Real-ESRGAN decides per tile how much to
    denoise, so hard tile cuts show up as seams between smooth and textured areas.
    """
    scale = descriptor.scale
    _, _, h, w = image.shape
    out = torch.zeros((1, 3, h * scale, w * scale), dtype=torch.float32, device=image.device)
    weight = torch.zeros((1, 1, h * scale, w * scale), dtype=torch.float32, device=image.device)
    step = tile - TILE_OVERLAP
    ys = list(range(0, max(h - tile, 0) + 1, step)) or [0]
    xs = list(range(0, max(w - tile, 0) + 1, step)) or [0]
    if ys[-1] + tile < h:
        ys.append(h - tile)
    if xs[-1] + tile < w:
        xs.append(w - tile)
    ramp_len = TILE_OVERLAP * scale
    for y0 in ys:
        for x0 in xs:
            y1, x1 = min(y0 + tile, h), min(x0 + tile, w)
            result = descriptor(image[:, :, y0:y1, x0:x1]).float()
            th, tw = result.shape[-2:]
            # Linear ramps on edges shared with a neighbouring tile, flat elsewhere.
            wy = torch.ones(th, device=image.device)
            wx = torch.ones(tw, device=image.device)
            ramp = torch.linspace(0.0, 1.0, ramp_len + 2, device=image.device)[1:-1]
            if y0 > 0:
                wy[:ramp_len] = ramp
            if y1 < h:
                wy[-ramp_len:] = torch.minimum(wy[-ramp_len:], ramp.flip(0))
            if x0 > 0:
                wx[:ramp_len] = ramp
            if x1 < w:
                wx[-ramp_len:] = torch.minimum(wx[-ramp_len:], ramp.flip(0))
            mask = (wy[:, None] * wx[None, :])[None, None]
            out[:, :, y0 * scale : y1 * scale, x0 * scale : x1 * scale] += result * mask
            weight[:, :, y0 * scale : y1 * scale, x0 * scale : x1 * scale] += mask
    return out / weight.clamp_min(1e-6)


def upscale(image: Image.Image, factor: float, model: UpscaleModel = "clean") -> Image.Image:
    """Upscale by `factor` (the 4x model output is resized down with Lanczos when < 4)."""
    longest = max(image.size)
    if longest * factor > MAX_OUTPUT_SIDE:
        capped = MAX_OUTPUT_SIDE / longest
        logger.warning(f"Upscale factor {factor} capped to {capped:.2f} ({MAX_OUTPUT_SIDE}px limit)")
        factor = capped
    width, height = output_size(*image.size, factor)
    descriptor = _load(model)

    alpha = image.getchannel("A") if image.mode == "RGBA" else None
    rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0

    use_cuda = torch.cuda.is_available()
    device = "cuda" if use_cuda else "cpu"
    dtype = torch.float16 if use_cuda and descriptor.supports_half else torch.float32
    descriptor.model.to(device=device, dtype=dtype)
    tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).to(device=device, dtype=dtype)

    tile = TILE
    try:
        while True:
            try:
                result = _run_tiled(descriptor, tensor, tile)
                break
            except torch.OutOfMemoryError:
                if tile <= 256:
                    raise
                tile //= 2
                torch.cuda.empty_cache()
                logger.warning(f"Upscaler OOM, retrying with {tile}px tiles")
    finally:
        descriptor.model.to("cpu", dtype=torch.float32)
        del tensor
        if use_cuda:
            torch.cuda.empty_cache()

    array = (result[0].float().clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255.0).round().astype(np.uint8)
    upscaled = Image.fromarray(array)
    if upscaled.size != (width, height):
        upscaled = upscaled.resize((width, height), Image.LANCZOS)
    if alpha is not None:
        upscaled.putalpha(alpha.resize((width, height), Image.LANCZOS))
    logger.info(f"Upscaled {image.size[0]}x{image.size[1]} -> {width}x{height} with '{model}'")
    return upscaled


def validate(width: int | None, height: int | None, factor: float) -> str | None:
    """Error message if the upscaled output would exceed MAX_OUTPUT_SIDE."""
    if width and height and max(output_size(width, height, factor)) > MAX_OUTPUT_SIDE:
        return f"Upscaled output would exceed {MAX_OUTPUT_SIDE}px per side; lower upscale_factor or the size"
    return None
