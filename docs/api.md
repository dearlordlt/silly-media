# API Documentation

Base URL: `http://localhost:4201`

---

## Overview

Silly Media provides two main capabilities:
- **Image Generation**: Text-to-image using diffusion models
- **Text-to-Speech (TTS)**: Voice synthesis with zero-shot voice cloning via "actors"

The service uses a **smart VRAM manager** that automatically loads/unloads models to fit within GPU memory. Only one model type (image or audio) can be active at a time.

---

## Models

### Image Models

| Model | ID | Steps | Speed | Notes |
|-------|-----|-------|-------|-------|
| Z-Image Turbo | `z-image-turbo` | 9 | Fast | Default, bilingual text rendering |
| Ovis Image 7B | `ovis-image-7b` | 50 | Slower | Requires custom diffusers fork |

### Audio Models

| Model | ID | VRAM | Notes |
|-------|-----|------|-------|
| XTTS v2 | `xtts-v2` | ~2GB | 17 languages, zero-shot voice cloning |
| Demucs | `demucs` | ~2GB | Vocal separation (used for YouTube extraction) |

**Note:** Only one model can be loaded at a time. The VRAM manager automatically unloads other models when switching.

---

## Health & Status

### `GET /health`

Check API and model status.

**Response**
```json
{
  "status": "healthy",
  "models_loaded": ["z-image-turbo"],
  "available_image_models": ["z-image-turbo", "ovis-image-7b"],
  "available_audio_models": ["xtts-v2"]
}
```

### `GET /models`

List available and loaded models by type.

**Response**
```json
{
  "image": {
    "available": ["z-image-turbo", "ovis-image-7b"],
    "loaded": ["z-image-turbo"]
  },
  "audio": {
    "available": ["xtts-v2"],
    "loaded": []
  }
}
```

### `GET /progress`

Get the current image generation progress (useful for polling).

**Response (when generating)**
```json
{
  "active": true,
  "step": 5,
  "total_steps": 9,
  "percent": 56,
  "elapsed": 2.3
}
```

**Response (when idle)**
```json
{
  "active": false
}
```

---

## Image Generation

### `GET /aspect-ratios`

List available aspect ratio presets with calculated dimensions.

**Response**
```json
{
  "1:1": {"name": "SQUARE", "dimensions_at_1024": [1024, 1024]},
  "16:9": {"name": "LANDSCAPE_16_9", "dimensions_at_1024": [1344, 768]},
  "9:16": {"name": "PORTRAIT_9_16", "dimensions_at_1024": [768, 1344]}
}
```

### `POST /generate/{model}`

Generate an image using the specified model.

**Path Parameters**
| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Model ID (e.g., `z-image-turbo`) |

**Request Body**
```json
{
  "prompt": "string, required",
  "negative_prompt": "string, optional",
  "num_inference_steps": "int, optional (default varies by model)",
  "cfg_scale": "float, optional (1.0-20.0, default 5.0)",
  "seed": "int, optional (-1 or omit for random)",
  "width": "int, optional (64-2048)",
  "height": "int, optional (64-2048)",
  "aspect_ratio": "string, optional",
  "base_size": "int, optional (256-2048, default 1024)"
}
```

**Model-specific defaults:**
- `z-image-turbo`: 9 steps, cfg_scale ignored (uses 0.0 internally)
- `ovis-image-7b`: 50 steps, cfg_scale 5.0

**Response**
- Content-Type: `image/png`
- Body: Raw PNG bytes

**Errors**
| Code | Description |
|------|-------------|
| 400 | Invalid request parameters |
| 404 | Model not found |
| 500 | Generation failed |

---

## Image Sizing Options

Three ways to specify output dimensions (pick one):

### 1. Explicit Dimensions

Set exact width and height (rounded to nearest 64):

```json
{
  "prompt": "a sunset over mountains",
  "width": 1280,
  "height": 720
}
```

### 2. Aspect Ratio Preset

Use a preset with optional base size:

```json
{
  "prompt": "a sunset over mountains",
  "aspect_ratio": "16:9",
  "base_size": 1024
}
```

**Available Presets**

| Value | Name | Dimensions (at 1024) |
|-------|------|---------------------|
| `1:1` | Square | 1024 × 1024 |
| `4:5` | Portrait | 896 × 1088 |
| `3:4` | Portrait | 896 × 1152 |
| `2:3` | Portrait | 832 × 1216 |
| `9:16` | Portrait | 768 × 1344 |
| `5:4` | Landscape | 1088 × 896 |
| `4:3` | Landscape | 1152 × 896 |
| `3:2` | Landscape | 1216 × 832 |
| `16:9` | Landscape | 1344 × 768 |
| `21:9` | Ultrawide | 1536 × 640 |

### 3. Default

Omit all sizing options for 1024×1024:

```json
{
  "prompt": "a sunset over mountains"
}
```

---

## Text-to-Speech (TTS)

TTS uses **actors** - named voice profiles created from reference audio. The system uses zero-shot voice cloning (no training required).

### Supported Languages

| Code | Language |
|------|----------|
| `en` | English |
| `es` | Spanish |
| `fr` | French |
| `de` | German |
| `it` | Italian |
| `pt` | Portuguese |
| `pl` | Polish |
| `tr` | Turkish |
| `ru` | Russian |
| `nl` | Dutch |
| `cs` | Czech |
| `ar` | Arabic |
| `zh-cn` | Chinese |
| `ja` | Japanese |
| `hu` | Hungarian |
| `ko` | Korean |
| `hi` | Hindi |

### `GET /tts/languages`

List supported TTS languages.

**Response**
```json
{
  "languages": [
    {"code": "en", "name": "English"},
    {"code": "es", "name": "Spanish"},
    ...
  ]
}
```

### `POST /tts/generate`

Generate speech from text using a stored actor's voice (batch mode).

**Request Body**
```json
{
  "text": "Hello, this is a test.",
  "actor": "My Actor",
  "language": "en",
  "temperature": 0.65,
  "speed": 1.0,
  "split_sentences": true
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `text` | string | Yes | - | Text to synthesize (1-10000 chars) |
| `actor` | string | Yes | - | Actor name for voice |
| `language` | string | No | `en` | Output language code |
| `temperature` | float | No | `0.65` | Sampling temperature (0.0-1.0) |
| `speed` | float | No | `1.0` | Playback speed (0.5-2.0) |
| `split_sentences` | bool | No | `true` | Split text into sentences |

**Response**
- Content-Type: `audio/wav`
- Body: Raw WAV bytes (24kHz, 16-bit, mono)

**Errors**
| Code | Description |
|------|-------------|
| 400 | Invalid request |
| 404 | Actor not found |
| 500 | Generation failed |

### `POST /tts/stream`

Generate speech with streaming output (lower time-to-first-audio).

Same request body as `/tts/generate`.

**Response**
- Content-Type: `audio/wav`
- Body: Streaming WAV chunks

### `POST /tts/generate-with-audio`

One-shot TTS with uploaded reference audio (no stored actor required).

**Request** (multipart/form-data)
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `text` | string | Yes | Text to synthesize |
| `language` | string | No | Output language (default: `en`) |
| `reference_audio` | file(s) | Yes | Reference audio file(s) for voice |
| `temperature` | float | No | Sampling temperature (default: 0.65) |
| `speed` | float | No | Playback speed (default: 1.0) |
| `split_sentences` | bool | No | Split text (default: true) |

**Response**
- Content-Type: `audio/wav`
- Body: Raw WAV bytes

---

## Actor Management

Actors are named voice profiles with stored reference audio for voice cloning.

### `GET /actors`

List all actors.

**Response**
```json
{
  "actors": [
    {
      "id": "abc123",
      "name": "My Actor",
      "language": "en",
      "description": "A warm friendly voice",
      "audio_count": 2,
      "created_at": "2024-01-15T10:30:00Z",
      "updated_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 1
}
```

### `POST /actors`

Create a new actor from uploaded audio files.

**Request** (multipart/form-data)
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Actor display name (unique) |
| `language` | string | No | Primary language (default: `en`) |
| `description` | string | No | Actor description |
| `audio_files` | file(s) | Yes | Reference audio (WAV, MP3, etc.) |

**Tips for reference audio:**
- Minimum 6 seconds recommended for best quality
- Clean audio with minimal background noise
- Multiple clips improve voice consistency
- Supported formats: WAV, MP3, FLAC, OGG

**Response** (201 Created)
```json
{
  "id": "abc123",
  "name": "My Actor",
  "language": "en",
  "description": "A warm friendly voice",
  "audio_count": 1,
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

**Errors**
| Code | Description |
|------|-------------|
| 400 | No audio files provided |
| 409 | Actor name already exists |

### `GET /actors/{name}`

Get actor details by name.

**Response**
```json
{
  "id": "abc123",
  "name": "My Actor",
  "language": "en",
  "description": "A warm friendly voice",
  "audio_count": 2,
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

### `DELETE /actors/{name}`

Delete an actor and all associated audio files.

**Response**: 204 No Content

### `POST /actors/from-youtube`

Create a new actor from a YouTube video URL.

Downloads audio from YouTube, optionally separates vocals using Demucs, trims silence using voice activity detection, and saves as actor reference. Useful for creating voice actors from interviews, podcasts, etc.

**Request Body**
```json
{
  "name": "string, required",
  "youtube_url": "string, required",
  "language": "string, optional (default: en)",
  "description": "string, optional",
  "max_duration": "float, optional (default: 30.0)",
  "separate_vocals": "bool, optional (default: true)"
}
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | string | Yes | - | Actor display name (must be unique) |
| `youtube_url` | string | Yes | - | YouTube video URL |
| `language` | string | No | `en` | Primary language code |
| `description` | string | No | `""` | Actor description |
| `max_duration` | float | No | `30.0` | Max duration of extracted audio (seconds) |
| `separate_vocals` | bool | No | `true` | Remove background music using Demucs |

**Supported YouTube URL formats:**
- `https://youtube.com/watch?v=VIDEO_ID`
- `https://youtu.be/VIDEO_ID`
- `https://youtube.com/shorts/VIDEO_ID`

**Response** (201 Created)
```json
{
  "id": "abc123",
  "name": "My Actor",
  "language": "en",
  "description": "Voice from interview",
  "audio_count": 1,
  "created_at": "2024-01-15T10:30:00Z",
  "updated_at": "2024-01-15T10:30:00Z"
}
```

**Errors**
| Code | Description |
|------|-------------|
| 400 | Invalid YouTube URL |
| 409 | Actor name already exists |
| 500 | Failed to extract voice from YouTube |

---

### `POST /actors/{name}/audio`

Add additional audio file to an existing actor.

**Request** (multipart/form-data)
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `audio_file` | file | Yes | Audio file to add |

**Response** (201 Created)
```json
{
  "id": "file123",
  "filename": "reference_01.wav",
  "original_name": "my_recording.wav",
  "duration_seconds": 8.5,
  "created_at": "2024-01-15T10:35:00Z"
}
```

### `GET /actors/{name}/audio`

List all audio files for an actor.

**Response**
```json
[
  {
    "id": "file123",
    "filename": "reference_00.wav",
    "original_name": "my_recording.wav",
    "duration_seconds": 8.5,
    "created_at": "2024-01-15T10:30:00Z"
  }
]
```

### `GET /actors/{name}/audio/{file_id}/download`

Download a specific audio file from an actor.

**Path Parameters**
| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Actor name |
| `file_id` | string | Audio file ID |

**Response**
- Content-Type: `audio/wav`
- Content-Disposition: attachment with original filename
- Body: Raw WAV bytes

**Errors**
| Code | Description |
|------|-------------|
| 404 | Actor or audio file not found |

### `DELETE /actors/{name}/audio/{file_id}`

Delete a specific audio file from an actor.

**Path Parameters**
| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | string | Actor name |
| `file_id` | string | Audio file ID |

**Response**: 204 No Content

**Errors**
| Code | Description |
|------|-------------|
| 404 | Actor or audio file not found |

---

## TTS History

Generated TTS audio is automatically saved to history for playback and download.

### `GET /tts/history`

Get TTS generation history, most recent first.

**Query Parameters**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 50 | Maximum entries to return |

**Response**
```json
{
  "entries": [
    {
      "id": "abc123",
      "actor_name": "Morgan",
      "text": "Hello, welcome to Silly Media!",
      "language": "en",
      "duration_seconds": 2.5,
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "total": 1
}
```

### `GET /tts/history/{entry_id}/audio`

Get the audio file for a TTS history entry.

**Response**
- Content-Type: `audio/wav`
- Body: Raw WAV bytes

**Errors**
| Code | Description |
|------|-------------|
| 404 | History entry not found |

### `DELETE /tts/history/{entry_id}`

Delete a single TTS history entry.

**Response**: 204 No Content

### `DELETE /tts/history`

Clear all TTS history.

**Response**: 204 No Content

---

## Examples

### Image Generation

#### Basic Generation (Z-Image Turbo)

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a red panda eating bamboo"}' \
  -o image.png
```

#### With Aspect Ratio

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a red panda eating bamboo",
    "aspect_ratio": "16:9"
  }' \
  -o landscape.png
```

### TTS Generation

#### Create an Actor

```bash
curl -X POST http://localhost:4201/actors \
  -F "name=Morgan" \
  -F "language=en" \
  -F "description=Deep authoritative voice" \
  -F "audio_files=@voice_sample.wav"
```

#### Create an Actor from YouTube

```bash
curl -X POST http://localhost:4201/actors/from-youtube \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Interviewer",
    "youtube_url": "https://youtube.com/watch?v=VIDEO_ID",
    "language": "en",
    "description": "Voice from podcast interview",
    "max_duration": 30,
    "separate_vocals": true
  }'
```

#### Generate Speech

```bash
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, welcome to Silly Media!",
    "actor": "Morgan",
    "language": "en"
  }' \
  -o speech.wav
```

#### One-Shot TTS (No Actor)

```bash
curl -X POST http://localhost:4201/tts/generate-with-audio \
  -F "text=Hello, this is a test." \
  -F "language=en" \
  -F "reference_audio=@voice_sample.wav" \
  -o speech.wav
```

### Python Client

```python
import requests

# Image generation
response = requests.post(
    "http://localhost:4201/generate/z-image-turbo",
    json={
        "prompt": "a red panda eating bamboo",
        "aspect_ratio": "3:2",
        "seed": 42,
    },
)
with open("image.png", "wb") as f:
    f.write(response.content)

# TTS generation
response = requests.post(
    "http://localhost:4201/tts/generate",
    json={
        "text": "Hello, welcome to Silly Media!",
        "actor": "Morgan",
        "language": "en",
    },
)
with open("speech.wav", "wb") as f:
    f.write(response.content)

# Create actor
with open("voice_sample.wav", "rb") as f:
    response = requests.post(
        "http://localhost:4201/actors",
        data={"name": "Morgan", "language": "en"},
        files={"audio_files": f},
    )
print(response.json())
```

---

## OpenAPI Schema

Interactive docs available at:
- Swagger UI: `http://localhost:4201/docs`
- ReDoc: `http://localhost:4201/redoc`
