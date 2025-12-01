# API Documentation

Base URL: `http://localhost:4201`

---

## Available Models

| Model | ID | Steps | Speed | Notes |
|-------|-----|-------|-------|-------|
| Z-Image Turbo | `z-image-turbo` | 9 | Fast | Default, bilingual text rendering |
| Ovis Image 7B | `ovis-image-7b` | 50 | Slower | Requires custom diffusers fork |

**Note:** Only one model can be loaded at a time (auto-unloads others to fit in VRAM).

---

## Health Check

### `GET /health`

Check API and model status.

**Response**
```json
{
  "status": "healthy",
  "models_loaded": ["z-image-turbo"],
  "available_models": ["z-image-turbo"]
}
```

---

## List Models

### `GET /models`

List available and loaded models.

**Response**
```json
{
  "available": ["z-image-turbo"],
  "loaded": ["z-image-turbo"]
}
```

---

## List Aspect Ratios

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

---

## Generate Image

### `POST /generate/{model}`

Generate an image using the specified model.

**Path Parameters**
| Parameter | Type | Description |
|-----------|------|-------------|
| `model` | string | Model name (e.g., `z-image-turbo`) |

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

## Examples

### Basic Generation (Z-Image Turbo)

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{"prompt": "a red panda eating bamboo"}' \
  -o image.png
```

### With Aspect Ratio

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a red panda eating bamboo",
    "aspect_ratio": "16:9"
  }' \
  -o landscape.png
```

### Full Parameters

```bash
curl -X POST http://localhost:4201/generate/z-image-turbo \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a red panda eating bamboo, detailed fur, forest background",
    "negative_prompt": "blurry, low quality",
    "num_inference_steps": 9,
    "seed": 42,
    "width": 1024,
    "height": 1024
  }' \
  -o image.png
```

### Python Client

```python
import requests

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
```

---

## OpenAPI Schema

Interactive docs available at:
- Swagger UI: `http://localhost:4201/docs`
- ReDoc: `http://localhost:4201/redoc`
