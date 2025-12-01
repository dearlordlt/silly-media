Create a Python API service that exposes the AIDC-AI/Ovis-Image-7B text-to-image model via HTTP.

## Core Requirements

**Stack:**

- Python 3.10+
- uv for dependency management
- FastAPI for the API
- Docker for containerization
- Hugging Face diffusers (custom fork for Ovis-Image)

**API:**

- Port: 4201
- Single endpoint: POST /generate
- Returns generated image as PNG

**Endpoint payload (JSON):**
{
"prompt": "string, required",
"negative_prompt": "string, optional, default empty",
"num_inference_steps": "int, optional, default 50",
"cfg_scale": "float, optional, default 5.0",
"image_size": "int, optional, default 1024",
"seed": "int, optional, for reproducibility"
}

**Response:**

- Content-Type: image/png
- Raw PNG bytes

## Model Setup

Install custom diffusers fork:
pip install git+https://github.com/DoctorKey/diffusers.git@ovis-image

Model loading code:

```python
import torch
from diffusers import OvisImagePipeline

pipe = OvisImagePipeline.from_pretrained(
    "AIDC-AI/Ovis-Image-7B",
    torch_dtype=torch.bfloat16
)
pipe.to("cuda")
```

Generation code:

```python
image = pipe(
    prompt=prompt,
    negative_prompt=negative_prompt,
    num_inference_steps=num_inference_steps,
    true_cfg_scale=cfg_scale
).images[0]
```

## Docker Requirements

**Base image:** Use NVIDIA CUDA base image (cuda 12.x with cudnn)

**GPU support:** Container must support NVIDIA GPU passthrough

**Model caching:** Mount /root/.cache/huggingface as volume to persist downloaded models between container restarts

**Environment variables:**

- HF_HOME=/root/.cache/huggingface
- TRANSFORMERS_CACHE=/root/.cache/huggingface

**Dockerfile structure:**

1. CUDA base image
2. Install Python 3.10 and uv
3. Copy pyproject.toml and uv.lock
4. Install dependencies with uv
5. Copy application code
6. Expose port 4201
7. Run with uvicorn

**docker-compose.yml:**

- Service name: ovis-image-api
- GPU reservation with NVIDIA runtime
- Volume mount for HF cache
- Port mapping 4201:4201
- Health check endpoint

## Project Structure

```
ovis-image-api/
├── pyproject.toml
├── Dockerfile
├── docker-compose.yml
├── .dockerignore
├── .env.example
├── README.md
└── src/
    └── ovis_api/
        ├── __init__.py
        ├── main.py          # FastAPI app
        ├── model.py         # Model loading/inference
        ├── schemas.py       # Pydantic models
        └── config.py        # Settings
```

## Additional Features

1. **Health endpoint:** GET /health - returns model loaded status
2. **Model preloading:** Load model on startup, not first request
3. **Request validation:** Validate prompt length, parameter ranges
4. **Error handling:** Proper HTTP error responses with details
5. **Logging:** Structured logging for requests and generation time
6. **Graceful shutdown:** Properly unload model on SIGTERM

## Development Workflow

**Dev mode with docker-compose:**

- Mount source code as volume for hot reload
- Use uvicorn with --reload flag

**Production mode:**

- No source mount
- Multiple workers if memory allows
- No reload flag

## Dependencies (pyproject.toml)

- fastapi
- uvicorn[standard]
- torch
- transformers
- accelerate
- safetensors
- pillow
- pydantic
- pydantic-settings
- Custom diffusers: git+https://github.com/DoctorKey/diffusers.git@ovis-image

## Hardware Notes

- Requires NVIDIA GPU with ~16GB+ VRAM for bfloat16
- Model size: 7B parameters + 2B vision encoder
- Consider adding queue system for production (but not for MVP)

**Environment variable:**

- HF_TOKEN: Hugging Face API token (optional, speeds up downloads)
