# Silly Media

A Python API service for text-to-image generation and text-to-speech with zero-shot voice cloning.

## Features

- **Image Generation**: Fast text-to-image with Z-Image Turbo (9 steps)
- **Text-to-Speech**: XTTS-v2 with 17 languages and voice cloning
- **Voice Cloning**: Zero-shot cloning from 6+ seconds of reference audio
- **Smart VRAM Manager**: Automatic GPU memory coordination between models
- **Actor System**: Save and reuse voice profiles

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

## Models

### Image Models

| Model | ID | Steps | Notes |
|-------|-----|-------|-------|
| Z-Image Turbo | `z-image-turbo` | 9 | Default, fast, bilingual text |
| Ovis Image 7B | `ovis-image-7b` | 50 | Higher quality, slower |

### Audio Models

| Model | ID | VRAM | Notes |
|-------|-----|------|-------|
| XTTS v2 | `xtts-v2` | ~2GB | 17 languages, voice cloning |

**Note:** Only one model loads at a time. The VRAM manager automatically swaps models.

## API Endpoints

### Health & Status

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Service health and loaded models |
| `/models` | GET | Available image and audio models |
| `/progress` | GET | Current image generation progress |

### Image Generation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/generate/{model}` | POST | Generate image from text |
| `/aspect-ratios` | GET | Available aspect ratio presets |

### Text-to-Speech

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/tts/generate` | POST | Generate speech (batch) |
| `/tts/stream` | POST | Generate speech (streaming) |
| `/tts/generate-with-audio` | POST | One-shot TTS with uploaded audio |
| `/tts/languages` | GET | Supported languages |

### Actor Management

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/actors` | GET | List all actors |
| `/actors` | POST | Create actor with audio files |
| `/actors/{name}` | GET | Get actor details |
| `/actors/{name}` | DELETE | Delete actor |
| `/actors/{name}/audio` | POST | Add audio to actor |
| `/actors/{name}/audio` | GET | List actor's audio files |

See [docs/api.md](docs/api.md) for full API documentation.

## Image Generation

```bash
# Basic generation
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a sunset over mountains"}' \
  -o image.png

# With aspect ratio
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "portrait photo", "aspect_ratio": "4:5"}' \
  -o portrait.png

# With explicit dimensions
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "landscape", "width": 1344, "height": 768}' \
  -o landscape.png
```

**Aspect Ratios:** `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `5:4`, `4:3`, `3:2`, `16:9`, `21:9`

## Text-to-Speech

### 1. Create an Actor

```bash
curl -X POST http://localhost:4201/actors \
  -F "name=Morgan" \
  -F "language=en" \
  -F "description=Deep narrator voice" \
  -F "audio_files=@voice_sample.wav"
```

**Audio Requirements:**
- Duration: 6-30 seconds (minimum 6s)
- Format: WAV, MP3, FLAC, OGG
- Quality: Clean audio, minimal background noise

### 2. Generate Speech

```bash
# Batch (returns complete audio)
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world!", "actor": "Morgan"}' \
  -o speech.wav

# Streaming (lower latency)
curl -X POST http://localhost:4201/tts/stream \
  -H "Content-Type: application/json" \
  -d '{"text": "Long text here...", "actor": "Morgan"}' \
  -o streamed.wav
```

### 3. One-Shot (No Actor)

```bash
curl -X POST http://localhost:4201/tts/generate-with-audio \
  -F "text=Hello, this is a test." \
  -F "reference_audio=@voice.wav" \
  -o output.wav
```

### Supported Languages

| Code | Language | Code | Language |
|------|----------|------|----------|
| `en` | English | `ru` | Russian |
| `es` | Spanish | `nl` | Dutch |
| `fr` | French | `cs` | Czech |
| `de` | German | `ar` | Arabic |
| `it` | Italian | `zh-cn` | Chinese |
| `pt` | Portuguese | `ja` | Japanese |
| `pl` | Polish | `ko` | Korean |
| `tr` | Turkish | `hi` | Hindi |
| `hu` | Hungarian | | |

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `HF_TOKEN` | - | HuggingFace token (optional) |
| `MODEL_PRELOAD` | `true` | Load model on startup |
| `MODEL_IDLE_TIMEOUT` | `30` | Seconds before unloading idle model |
| `DEFAULT_MODEL` | `z-image-turbo` | Model to preload |

## Development

```bash
# Dev mode with hot reload
docker compose --profile dev up silly-media-dev

# View logs
docker compose logs -f

# Rebuild
docker compose build --no-cache
```

## Project Structure

```
silly-media/
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── test-generate.sh
├── data/
│   ├── db/                    # SQLite database
│   │   └── silly_media.db
│   └── actors/                # Actor audio files
│       └── <actor_id>/
├── docs/
│   ├── api.md                 # Full API documentation
│   ├── setup.md
│   └── test-prompts.md        # Example commands
└── src/silly_media/
    ├── main.py                # FastAPI app
    ├── config.py              # Settings
    ├── schemas.py             # Image request schemas
    ├── db.py                  # SQLite database
    ├── vram_manager.py        # GPU memory manager
    ├── models/
    │   ├── base.py            # BaseImageModel
    │   └── z_image.py         # Z-Image Turbo
    ├── audio/
    │   ├── base.py            # BaseAudioModel
    │   ├── xtts.py            # XTTS-v2 implementation
    │   └── schemas.py         # TTS request schemas
    └── routers/
        ├── actors.py          # Actor CRUD endpoints
        └── tts.py             # TTS generation endpoints
```

## How VRAM Management Works

The service runs on a single GPU (designed for RTX 4090 with 24GB VRAM). Since image models use ~22GB and TTS uses ~2GB, only one model type can be loaded at a time.

```
Request arrives (TTS or Image)
         │
         ▼
   ┌─────────────────┐
   │  Acquire Lock   │  ← Blocks if another request is using GPU
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │ Unload current  │  ← Image model unloaded before TTS loads
   │ model (if any)  │  ← TTS unloaded before Image loads
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │ Clear VRAM      │  ← gc.collect() + torch.cuda.empty_cache()
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │ Load requested  │  ← Model loads into GPU
   │ model           │
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │ Process request │  ← Generate image or speech
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │ Reset idle      │  ← After timeout, model auto-unloads
   │ timer           │
   └─────────────────┘
```

## Hardware Requirements

- NVIDIA GPU with 24GB VRAM (RTX 4090 recommended)
- Docker with NVIDIA Container Toolkit
- 50GB+ disk space for models

## Documentation

- [API Reference](docs/api.md) - Full endpoint documentation
- [Test Prompts](docs/test-prompts.md) - Example commands for testing
- [Setup Guide](docs/setup.md) - Installation instructions
- [Swagger UI](http://localhost:4201/docs) - Interactive API docs (when running)
