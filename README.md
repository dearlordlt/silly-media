A Python API service for text-to-image generation via HTTP.

## Quick Start

```bash
# Start the service
docker compose up -d

# Check it's running
docker compose ps

# Check health
curl http://localhost:4201/health

# Generate an image
./test-generate.sh -p "your prompt here" -a 4:3
```

## Supported Models

| Model | ID | Steps | Notes |
|-------|-----|-------|-------|
| Z-Image Turbo | `z-image-turbo` | 9 | Default, fast, bilingual text rendering |

## API Endpoints

### `GET /health`
Returns service health and loaded models.

### `GET /models`
Lists available and loaded models.

### `GET /aspect-ratios`
Returns available aspect ratio presets with dimensions.

### `POST /generate/{model}`
Generate an image. Returns raw PNG bytes.

**Request body:**
```json
{
  "prompt": "string, required",
  "negative_prompt": "string, optional",
  "num_inference_steps": "int, optional (default: model-specific)",
  "cfg_scale": "float, optional (default: 5.0)",
  "seed": "int, optional (-1 or omit for random)",
  "width": "int, optional (64-2048)",
  "height": "int, optional (64-2048)",
  "aspect_ratio": "string, optional (e.g. '4:3', '16:9')",
  "base_size": "int, optional (default: 1024)"
}
```

**Sizing options (use one):**
1. Explicit `width` + `height`
2. `aspect_ratio` + optional `base_size`
3. Omit all for default 1024x1024

**Aspect ratios:** `1:1`, `4:5`, `3:4`, `2:3`, `9:16`, `5:4`, `4:3`, `3:2`, `16:9`, `21:9`

## Configuration

Environment variables (see `.env.example`):

| Variable | Default | Description |
|----------|---------|-------------|
| `HF_TOKEN` | - | HuggingFace token (optional, speeds up downloads) |
| `MODEL_PRELOAD` | `true` | Load model on startup |
| `MODEL_IDLE_TIMEOUT` | `300` | Seconds before unloading idle model (0 = never) |
| `DEFAULT_MODEL` | `z-image-turbo` | Model to preload |

## Development

```bash
# Dev mode with hot reload
docker compose --profile dev up silly-media-dev
```

## Project Structure

```
silly-media/
├── docker-compose.yml
├── Dockerfile
├── pyproject.toml
├── test-generate.sh
├── docs/
│   ├── api.md
│   └── setup.md
└── src/silly_media/
    ├── main.py
    ├── config.py
    ├── schemas.py
    └── models/
        ├── base.py
        └── z_image.py
```

## Hardware Requirements

- NVIDIA GPU with 16GB+ VRAM
- Docker with NVIDIA Container Toolkit
