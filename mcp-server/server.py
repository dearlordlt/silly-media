#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = [
#   "mcp>=1.2.0",
#   "httpx>=0.27",
# ]
# ///
"""
silly-media MCP server.

Wraps the local silly-media FastAPI service (default http://localhost:4201)
as MCP tools so an agent can generate images, edit images, synthesize speech,
analyze images, run the local LLM, and generate video / music.

Config via env:
  SILLY_MEDIA_URL   base URL of the service   (default http://localhost:4201)
  SILLY_MEDIA_OUT   where generated files go  (default ~/Documents/Claude/silly-media)

Source of truth for the API: docs/api.md in the silly-media repo.
"""
from __future__ import annotations

import base64
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import httpx
from mcp.server.fastmcp import FastMCP, Image

BASE_URL = os.environ.get("SILLY_MEDIA_URL", "http://localhost:4201").rstrip("/")
OUT_DIR = Path(
    os.environ.get("SILLY_MEDIA_OUT", "~/Documents/Claude/silly-media")
).expanduser()
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Generous timeouts: model warmup (cold load) can add 10-30s.
HTTP_TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=600.0, pool=600.0)

mcp = FastMCP("silly-media")


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _client() -> httpx.Client:
    return httpx.Client(base_url=BASE_URL, timeout=HTTP_TIMEOUT)


def _stamp(prefix: str, ext: str) -> Path:
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    return OUT_DIR / f"{prefix}_{ts}.{ext}"


def _save(data: bytes, prefix: str, ext: str) -> Path:
    p = _stamp(prefix, ext)
    p.write_bytes(data)
    return p


def _b64_of(path: str) -> str:
    raw = Path(path).expanduser().read_bytes()
    return base64.b64encode(raw).decode("ascii")


def _drop_none(d: dict) -> dict:
    return {k: v for k, v in d.items() if v is not None}


def _err(resp: httpx.Response) -> str:
    body = resp.text[:500]
    return f"silly-media error {resp.status_code}: {body}"


# --------------------------------------------------------------------------- #
# status / discovery
# --------------------------------------------------------------------------- #
@mcp.tool()
def service_status() -> str:
    """Health + which models are available and currently loaded. Call this if
    a generation fails or you're unsure what models/voices exist."""
    with _client() as c:
        h = c.get("/health")
        m = c.get("/models")
    out = ["# silly-media status", "", "## /health", h.text, "", "## /models", m.text]
    return "\n".join(out)


@mcp.tool()
def list_tts_actors() -> str:
    """List saved XTTS voice-clone actors (use one as the `actor` for speak())
    and Maya saved voice descriptions."""
    with _client() as c:
        actors = c.get("/actors")
        maya = c.get("/tts/maya/actors")
    return f"## XTTS actors\n{actors.text}\n\n## Maya actors\n{maya.text}"


# --------------------------------------------------------------------------- #
# image generation
# --------------------------------------------------------------------------- #
@mcp.tool()
def generate_image(
    prompt: str,
    model: str = "z-image-turbo",
    aspect_ratio: str = "1:1",
    negative_prompt: str = "",
    num_inference_steps: Optional[int] = None,
    cfg_scale: Optional[float] = None,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    base_size: int = 1024,
) -> list:
    """Text-to-image. Models: z-image-turbo (fast, default), z-image, qwen-image-2512,
    ovis-image-7b. Use aspect_ratio (1:1,16:9,9:16,4:5,3:4,2:3,5:4,4:3,3:2,21:9) +
    base_size, OR explicit width/height (64-2048). Returns the image inline and the
    saved PNG path."""
    payload = _drop_none(
        {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "num_inference_steps": num_inference_steps,
            "cfg_scale": cfg_scale,
            "seed": seed,
            "width": width,
            "height": height,
            # only send aspect_ratio when explicit dims weren't given
            "aspect_ratio": None if (width or height) else aspect_ratio,
            "base_size": base_size,
        }
    )
    with _client() as c:
        r = c.post(f"/generate/{model}", json=payload)
    if r.status_code != 200:
        return [_err(r)]
    p = _save(r.content, "image", "png")
    return [Image(data=r.content, format="png"), f"Saved: {p}"]


@mcp.tool()
def generate_pixel_art(
    prompt: str,
    size: int = 32,
    remove_background: bool = True,
    num_inference_steps: int = 9,
    seed: Optional[int] = None,
) -> list:
    """Generate a small pixel-art sprite/icon. size 8-512. remove_background=True
    makes a transparent sprite; False makes a seamless tile. Returns image inline + path."""
    payload = _drop_none(
        {
            "prompt": prompt,
            "size": size,
            "remove_background": remove_background,
            "num_inference_steps": num_inference_steps,
            "seed": seed,
        }
    )
    with _client() as c:
        r = c.post("/pixelart/generate", json=payload)
    if r.status_code != 200:
        return [_err(r)]
    p = _save(r.content, "pixelart", "png")
    return [Image(data=r.content, format="png"), f"Saved: {p}"]


@mcp.tool()
def generate_sprite(
    prompt: str,
    model: str = "z-image-turbo",
    aspect_ratio: str = "1:1",
    remove_background: bool = True,
    output_size: Optional[int] = None,
    negative_prompt: str = "",
    num_inference_steps: Optional[int] = None,
    cfg_scale: Optional[float] = None,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    base_size: int = 1024,
) -> list:
    """Non-pixel-art sprite/asset generation. Prompt is used VERBATIM (no pixel
    styling) — write your own framing, e.g. "...single survivor, full body,
    centered, plain neutral background". remove_background=True returns a
    transparent cutout (rembg). output_size smooth-downscales the longest side
    (LANCZOS), aspect preserved; omit to keep full res. Supports non-square via
    aspect_ratio (e.g. 3:4 for characters) or explicit width/height. Pick model:
    z-image (quality), z-image-turbo (fast, default), qwen-image-2512 (portraits).
    Returns image inline + saved PNG path."""
    payload = _drop_none(
        {
            "prompt": prompt,
            "model": model,
            "remove_background": remove_background,
            "output_size": output_size,
            "negative_prompt": negative_prompt,
            "num_inference_steps": num_inference_steps,
            "cfg_scale": cfg_scale,
            "seed": seed,
            "width": width,
            "height": height,
            "aspect_ratio": None if (width or height) else aspect_ratio,
            "base_size": base_size,
        }
    )
    with _client() as c:
        r = c.post("/sprite/generate", json=payload)
    if r.status_code != 200:
        return [_err(r)]
    p = _save(r.content, "sprite", "png")
    return [Image(data=r.content, format="png"), f"Saved: {p}"]


@mcp.tool()
def edit_image(
    image_path: str,
    prompt: str,
    model: str = "qwen-image-edit",
    negative_prompt: str = " ",
    num_inference_steps: int = 20,
    true_cfg_scale: float = 4.0,
    seed: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    use_lora: bool = False,
) -> list:
    """Img2img edit: transform an existing image (give an absolute path) per the prompt.
    negative_prompt must be non-empty (defaults to a single space). With use_lora=True use
    4-6 steps + true_cfg_scale=1.0 (Lightning LoRA). Returns edited image inline + path."""
    payload = _drop_none(
        {
            "image": _b64_of(image_path),
            "prompt": prompt,
            "negative_prompt": negative_prompt or " ",
            "num_inference_steps": num_inference_steps,
            "true_cfg_scale": true_cfg_scale,
            "seed": seed,
            "width": width,
            "height": height,
            "use_lora": use_lora,
        }
    )
    with _client() as c:
        r = c.post(f"/img2img/edit/{model}", json=payload)
    if r.status_code != 200:
        return [_err(r)]
    p = _save(r.content, "img2img", "png")
    return [Image(data=r.content, format="png"), f"Saved: {p}"]


# --------------------------------------------------------------------------- #
# vision / llm
# --------------------------------------------------------------------------- #
@mcp.tool()
def vision_analyze(
    image_path: str,
    query: str,
    max_tokens: Optional[int] = None,
    temperature: float = 0.7,
) -> str:
    """Ask a question about an image (OCR, description, Q&A) using the VLM. Give an
    absolute image path. Returns the model's text answer."""
    payload = _drop_none(
        {
            "image": _b64_of(image_path),
            "query": query,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
    )
    with _client() as c:
        r = c.post("/vision/analyze", json=payload)
    if r.status_code != 200:
        return _err(r)
    return r.text


@mcp.tool()
def llm_generate(
    prompt: str,
    system_prompt: Optional[str] = None,
    temperature: float = 0.8,
    max_tokens: int = 4096,
    enable_thinking: bool = False,
) -> str:
    """Run the local LLM (Huihui-Qwen3-4B, abliterated). Returns generated text."""
    payload = _drop_none(
        {
            "prompt": prompt,
            "system_prompt": system_prompt,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "enable_thinking": enable_thinking,
        }
    )
    with _client() as c:
        r = c.post("/llm/generate", json=payload)
    if r.status_code != 200:
        return _err(r)
    return r.text


# --------------------------------------------------------------------------- #
# tts
# --------------------------------------------------------------------------- #
@mcp.tool()
def speak(
    text: str,
    actor: str,
    language: str = "en",
    speed: float = 1.0,
    temperature: float = 0.65,
) -> str:
    """XTTS voice cloning: synthesize `text` in the voice of a saved `actor`
    (see list_tts_actors). 17 languages (en es fr de it pt pl tr ru nl cs ar
    zh-cn ja hu ko hi). Saves a WAV and returns its path."""
    payload = {
        "text": text,
        "actor": actor,
        "language": language,
        "speed": speed,
        "temperature": temperature,
    }
    with _client() as c:
        r = c.post("/tts/generate", json=payload)
    if r.status_code != 200:
        return _err(r)
    p = _save(r.content, "tts", "wav")
    return f"Saved: {p}"


@mcp.tool()
def speak_maya(
    text: str,
    voice_description: str,
    speed: float = 1.0,
    temperature: float = 0.7,
) -> str:
    """Maya TTS (English only): no reference audio needed — describe the voice
    (e.g. 'young woman, bright energetic tone') and use inline emotion tags like
    <laugh>, <whisper>, <sigh>. Saves a WAV and returns its path."""
    payload = {
        "text": text,
        "voice_description": voice_description,
        "speed": speed,
        "temperature": temperature,
    }
    with _client() as c:
        r = c.post("/tts/maya/generate", json=payload)
    if r.status_code != 200:
        return _err(r)
    p = _save(r.content, "maya", "wav")
    return f"Saved: {p}"


# --------------------------------------------------------------------------- #
# async jobs: video + music
# --------------------------------------------------------------------------- #
def _poll(c: httpx.Client, status_path: str, max_wait: float) -> dict:
    """Poll a job status endpoint until terminal or max_wait. Returns last JSON dict."""
    deadline = time.time() + max_wait
    last: dict = {}
    while time.time() < deadline:
        r = c.get(status_path)
        if r.status_code != 200:
            return {"_http_error": _err(r)}
        last = r.json()
        st = str(last.get("status", "")).lower()
        if last.get("error"):
            return last
        if st in {"completed", "complete", "done", "finished", "success", "succeeded"}:
            return last
        if st in {"failed", "error", "cancelled", "canceled"}:
            return last
        time.sleep(3)
    last["_timed_out"] = True
    return last


@mcp.tool()
def generate_video(
    prompt: str,
    image_path: Optional[str] = None,
    model: str = "hunyuan-video",
    resolution: str = "480p",
    aspect_ratio: str = "16:9",
    num_frames: int = 45,
    num_inference_steps: int = 6,
    guidance_scale: float = 1.0,
    seed: int = -1,
    fps: int = 24,
    max_wait_seconds: float = 600.0,
) -> str:
    """Text-to-video, or image-to-video if image_path (absolute path) is given.
    Async: submits a job and blocks while polling (~60-90s/clip). On completion
    downloads the MP4 (+thumbnail) and returns paths. If it outruns max_wait_seconds,
    returns the job_id — re-check with video_status(job_id)."""
    body = _drop_none(
        {
            "prompt": prompt,
            "resolution": resolution,
            "aspect_ratio": aspect_ratio,
            "num_frames": num_frames,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "seed": seed,
            "fps": fps,
        }
    )
    with _client() as c:
        if image_path:
            body["image"] = _b64_of(image_path)
            r = c.post(f"/video/i2v/{model}", json=body)
        else:
            r = c.post(f"/video/t2v/{model}", json=body)
        if r.status_code != 200:
            return _err(r)
        job_id = r.json().get("job_id")
        if not job_id:
            return f"No job_id in response: {r.text[:300]}"
        st = _poll(c, f"/video/status/{job_id}", max_wait_seconds)
        if st.get("_timed_out"):
            return f"Still rendering (job_id={job_id}, progress={st.get('progress')}). Re-check with video_status('{job_id}')."
        if st.get("error") or "_http_error" in st:
            return f"Video job failed: {st.get('error') or st.get('_http_error')}"
        return _download_video(c, job_id)


def _download_video(c: httpx.Client, job_id: str) -> str:
    v = c.get(f"/video/download/{job_id}")
    if v.status_code != 200:
        return _err(v)
    vp = _save(v.content, "video", "mp4")
    out = [f"Saved video: {vp}"]
    t = c.get(f"/video/thumbnail/{job_id}")
    if t.status_code == 200:
        tp = _save(t.content, "video_thumb", "png")
        out.append(f"Thumbnail: {tp}")
    return "\n".join(out)


@mcp.tool()
def video_status(job_id: str) -> str:
    """Check a video job; if complete, download the MP4 and return the path."""
    with _client() as c:
        r = c.get(f"/video/status/{job_id}")
        if r.status_code != 200:
            return _err(r)
        st = r.json()
        if str(st.get("status", "")).lower() in {
            "completed", "complete", "done", "finished", "success", "succeeded"
        }:
            return _download_video(c, job_id)
        return f"status={st.get('status')} progress={st.get('progress')} step={st.get('current_step')}/{st.get('total_steps')} error={st.get('error')}"


@mcp.tool()
def generate_music(
    caption: str,
    lyrics: str = "",
    instrumental: bool = False,
    duration: float = 30.0,
    bpm: Optional[int] = None,
    keyscale: str = "",
    timesignature: str = "",
    model: str = "ace-step",
    guidance_scale: float = 7.0,
    seed: int = -1,
    max_wait_seconds: float = 600.0,
) -> str:
    """Text-to-music. `caption` = genre/style/mood tags (required). Provide `lyrics`
    for vocals, or instrumental=True. Models: ace-step (8 steps, fast), ace-step-quality
    (50 steps). Async: blocks while polling, then downloads the audio and returns path(s).
    If it outruns max_wait_seconds, returns job_id — re-check with music_status(job_id)."""
    body = _drop_none(
        {
            "caption": caption,
            "lyrics": lyrics,
            "instrumental": instrumental,
            "duration": duration,
            "bpm": bpm,
            "keyscale": keyscale,
            "timesignature": timesignature,
            "model": model,
            "guidance_scale": guidance_scale,
            "seed": seed,
        }
    )
    with _client() as c:
        r = c.post("/music/generate", json=body)
        if r.status_code != 200:
            return _err(r)
        job_id = r.json().get("job_id")
        if not job_id:
            return f"No job_id in response: {r.text[:300]}"
        st = _poll(c, f"/music/status/{job_id}", max_wait_seconds)
        if st.get("_timed_out"):
            return f"Still generating (job_id={job_id}, progress={st.get('progress')}). Re-check with music_status('{job_id}')."
        if st.get("error") or "_http_error" in st:
            return f"Music job failed: {st.get('error') or st.get('_http_error')}"
        return _download_music(c, job_id, st)


def _download_music(c: httpx.Client, job_id: str, st: dict) -> str:
    audios = st.get("audios") or []
    n = len(audios) if audios else 1
    saved = []
    for i in range(n):
        a = c.get(f"/music/download/{job_id}/{i}")
        if a.status_code == 200:
            ap = _save(a.content, "music", "wav")
            saved.append(str(ap))
    if not saved:
        return f"Job {job_id} complete but no audio downloaded."
    return "Saved music:\n" + "\n".join(saved)


@mcp.tool()
def music_status(job_id: str) -> str:
    """Check a music job; if complete, download the audio and return the path(s)."""
    with _client() as c:
        r = c.get(f"/music/status/{job_id}")
        if r.status_code != 200:
            return _err(r)
        st = r.json()
        if str(st.get("status", "")).lower() in {
            "completed", "complete", "done", "finished", "success", "succeeded"
        }:
            return _download_music(c, job_id, st)
        return f"status={st.get('status')} progress={st.get('progress')} step={st.get('current_step')}/{st.get('total_steps')} error={st.get('error')}"


@mcp.tool()
def generate_3d(
    text: Optional[str] = None,
    image_path: Optional[str] = None,
    texture: bool = True,
    target_faces: int = 6000,
    octree_resolution: int = 256,
    num_inference_steps: int = 30,
    guidance_scale: float = 5.5,
    seed: int = -1,
    image_model: str = "z-image-turbo",
    subject: str = "character",
    max_wait_seconds: float = 900.0,
) -> str:
    """Text-to-3D or image-to-3D (Hunyuan3D-2). Give `text` (a reference image is
    auto-generated first) OR `image_path` (absolute path, image -> 3D). For the text
    path, set `subject` so the reference is framed right: "character" (person),
    "object" (isolated item like a sword — no person), "building", or "auto".
    Returns a textured low-poly .glb; lower `target_faces` = lower poly. Synchronous:
    shape + texture takes ~1-3 min (first run also downloads weights)."""
    if not text and not image_path:
        return "Provide either text or image_path."
    body = _drop_none(
        {
            "text": text,
            "image": _b64_of(image_path) if image_path else None,
            "texture": texture,
            "target_faces": target_faces,
            "octree_resolution": octree_resolution,
            "num_inference_steps": num_inference_steps,
            "guidance_scale": guidance_scale,
            "seed": seed,
            "image_model": image_model,
            "subject": subject,
        }
    )
    timeout = httpx.Timeout(connect=10.0, read=max_wait_seconds, write=120.0, pool=max_wait_seconds)
    with httpx.Client(base_url=BASE_URL, timeout=timeout) as c:
        r = c.post("/model3d/generate", json=body)
        if r.status_code != 200:
            return _err(r)
        path = _save(r.content, "model", "glb")
        return f"Saved 3D model: {path} ({len(r.content) // 1024} KB)"


if __name__ == "__main__":
    mcp.run()
