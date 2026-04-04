# Silly Media

A self-hosted FastAPI service for multimodal media generation on a single GPU.

It exposes one API for image generation, image editing, pixel art, text-to-speech, voice cloning, video generation, vision analysis, LLM text generation, music generation, and ComfyUI-compatible image workflows. The service uses a VRAM manager to load and unload large models automatically so one machine can run several heavyweight workloads without manual orchestration.

## Features

- **Image Generation**: Multiple text-to-image models including fast and quality-oriented options
- **Image Editing**: Img2img editing with natural-language instructions
- **Pixel Art**: Small icon/pixel art generation with background removal
- **Text-to-Speech**: XTTS voice cloning and Maya description-based TTS
- **Actor System**: Save reusable voice profiles from uploaded audio or YouTube extraction
- **Video Generation**: Text-to-video and image-to-video jobs
- **Vision Analysis**: OCR, image Q&A, and visual understanding
- **LLM Text Generation**: Local text generation and streaming
- **Music Generation**: Prompt-to-music generation with job polling
- **ComfyUI Compatibility**: API endpoints that mimic ComfyUI for client compatibility
- **Smart VRAM Manager**: Automatic model swapping and idle unloading

## Quick Start

```bash
# Start the service
docker compose up -d

# Check health
curl http://localhost:4201/health

# Generate an image
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a red panda eating bamboo"}' \
  -o image.png

# Create a voice actor
curl -X POST http://localhost:4201/actors \
  -F "name=Narrator" \
  -F "audio_files=@voice_sample.wav"

# Generate speech
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world!", "actor": "Narrator"}' \
  -o speech.wav
```

## Capabilities

### Image Models

| Model | ID | Notes |
|-------|----|-------|
| Z-Image | `z-image` | Full image model, higher quality |
| Z-Image Turbo | `z-image-turbo` | Fast default model |
| Qwen Image 2512 | `qwen-image-2512` | GGUF image model with optional LoRA turbo mode |
| Ovis Image 7B | `ovis-image-7b` | Higher quality, slower |

### Audio Models

| Model | ID | Notes |
|-------|----|-------|
| XTTS v2 | `xtts-v2` | Multi-language zero-shot voice cloning |
| Maya TTS | `maya` | English TTS from voice description and emotion tags |
| Demucs | `demucs` | Vocal separation for voice extraction workflows |

### Other Model Families

| Type | Model | ID |
|------|-------|----|
| Video | HunyuanVideo 1.5 | `hunyuan-video` |
| Vision | Qwen3-VL 8B | `qwen3-vl-8b` |
| Img2Img | Qwen Image Edit | `qwen-image-edit` |
| LLM | Huihui Qwen3 4B | `huihui-qwen3-4b` |
| Music | ACE-Step 1.5 Turbo / Quality | `ace-step`, `ace-step-quality` |

Only one large model is active at a time. The VRAM manager automatically unloads and swaps models between requests.

## API Overview

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health and available models by type |
| `/models` | GET | Available and currently loaded models |
| `/progress` | GET | Current text-to-image progress |
| `/aspect-ratios` | GET | Image aspect-ratio presets |
| `/generate/{model}` | POST | Text-to-image generation |

### TTS And Actors

| Endpoint Group | Description |
|----------------|-------------|
| `/tts/*` | Batch TTS, streaming TTS, one-shot audio cloning, Maya actors, history |
| `/actors/*` | Actor CRUD, audio file management, actor creation from YouTube |

### Video, Vision, Img2Img, LLM, Music

| Endpoint Group | Description |
|----------------|-------------|
| `/video/*` | Text-to-video, image-to-video, job status, downloads, history |
| `/vision/*` | Image analysis from upload or base64 payload |
| `/img2img/*` | Image editing and model/progress endpoints |
| `/llm/*` | Text generation, streaming, model listing |
| `/music/*` | Music generation jobs, progress, downloads |
| `/comfy/*` | ComfyUI-compatible endpoints |

Full endpoint details live in [docs/api.md](docs/api.md).

## Examples

### Image Generation

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a sunset over mountains", "aspect_ratio": "16:9"}' \
  -o image.png
```

### Text To Speech

```bash
# Create an actor
curl -X POST http://localhost:4201/actors \
  -F "name=Morgan" \
  -F "language=en" \
  -F "description=Deep narrator voice" \
  -F "audio_files=@voice_sample.wav"

# Generate speech
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world!", "actor": "Morgan"}' \
  -o speech.wav
```

### One-Shot Voice Cloning

```bash
curl -X POST http://localhost:4201/tts/generate-with-audio \
  -F "text=Hello, this is a test." \
  -F "reference_audio=@voice.wav" \
  -o output.wav
```

### Vision Analysis

```bash
curl -X POST http://localhost:4201/vision/analyze/upload \
  -F "image=@image.png" \
  -F "query=Describe this image in detail"
```

### Music Generation

```bash
curl -X POST http://localhost:4201/music/generate \
  -H "Content-Type: application/json" \
  -d '{"prompt":"energetic synthwave track with female vocals","model":"ace-step"}'
```

### Video Generation

```bash
curl -X POST http://localhost:4201/video/t2v/hunyuan-video \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a cinematic drone shot over snowy mountains"}'
```

## Configuration

Environment variables are loaded from `.env` (see [.env.example](.env.example)).

| Variable | Default | Description |
|----------|---------|-------------|
| `HF_TOKEN` | - | Hugging Face token, optional but useful for gated models |
| `MODEL_PRELOAD` | `true` | Load the default model on startup |
| `MODEL_IDLE_TIMEOUT` | `300` | Seconds before unloading an idle model |
| `DEFAULT_MODEL` | `z-image-turbo` | Model to preload |
| `PORT` | `4201` | API port |
| `DB_PATH` | `./data/db/silly_media.db` | SQLite database path |
| `ACTORS_STORAGE_PATH` | `./data/actors` | Stored actor audio directory |

## Development

```bash
# Dev mode with hot reload
docker compose --profile dev up silly-media-dev

# View logs
docker compose logs -f

# Rebuild
docker compose build --no-cache
```

The app is packaged as a Python project via [pyproject.toml](pyproject.toml) and the main entrypoint is [src/silly_media/main.py](src/silly_media/main.py).

## Project Structure

```text
silly-media/
├── docker-compose.yml
├── pyproject.toml
├── docs/
│   ├── api.md
│   ├── setup.md
│   └── test-prompts.md
├── data/
│   ├── actors/
│   ├── comfy/
│   ├── db/
│   ├── music/
│   ├── tts_history/
│   └── videos/
└── src/silly_media/
    ├── main.py
    ├── config.py
    ├── db.py
    ├── progress.py
    ├── vram_manager.py
    ├── audio/
    ├── comfyui/
    ├── img2img/
    ├── llm/
    ├── models/
    ├── music/
    ├── routers/
    ├── utils/
    ├── video/
    └── vision/
```

## VRAM Management

The service is designed around a single GPU host. Large models are registered by type and acquired through a central lock. When a request for a different model family arrives, the current model is unloaded, CUDA memory is cleared, and the requested model is loaded on demand. Idle models are unloaded automatically after the configured timeout.

This lets one machine serve image, audio, video, vision, and text workloads without keeping every model resident in VRAM.

## Hardware Requirements

- NVIDIA GPU with substantial VRAM; 24GB is the practical target for the larger image and video workflows
- Docker with NVIDIA Container Toolkit
- Significant disk space for model weights and generated media

## Web UIs

The repository includes simple static HTML clients you can open directly in a browser:

- `ui.html` for text-to-image
- `ui-audio.html` for TTS and actor management
- `ui-video.html` for video generation
- `ui-img2img.html` for image editing
- `ui-music.html` for music generation
- `llm.html` for local LLM interaction

## Documentation

- [docs/api.md](docs/api.md) for endpoint details
- [docs/setup.md](docs/setup.md) for setup notes
- [docs/test-prompts.md](docs/test-prompts.md) for example prompts
- `http://localhost:4201/docs` for Swagger UI when the service is running
