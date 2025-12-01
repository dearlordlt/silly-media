# Setup & Running

## Prerequisites

- Docker with NVIDIA GPU support
- NVIDIA GPU with 16GB+ VRAM
- [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

## Quick Start

1. **Clone and configure**
   ```bash
   cd silly-media
   cp .env.example .env
   # Edit .env and add your HF_TOKEN (optional but speeds up downloads)
   ```

2. **Run with Docker Compose**
   ```bash
   docker compose up -d
   ```

3. **Check status**
   ```bash
   # View logs
   docker compose logs -f

   # Check health
   curl http://localhost:4201/health
   ```

## Docker Commands

### Production

```bash
# Start
docker compose up -d

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build

# View logs
docker compose logs -f silly-media
```

### Development (with hot reload)

```bash
# Start dev mode
docker compose --profile dev up silly-media-dev

# Code changes in src/ will auto-reload
```

### Managing the Container

```bash
# Restart
docker compose restart

# Shell into container
docker compose exec silly-media bash

# Check GPU usage
docker compose exec silly-media nvidia-smi
```

## Model Cache

HuggingFace models are cached in a Docker volume (`huggingface-cache`). This persists between container restarts.

```bash
# Clear model cache (forces re-download)
docker volume rm silly-media_huggingface-cache
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HF_TOKEN` | - | HuggingFace API token |
| `PORT` | 4201 | API port |
| `LOG_LEVEL` | INFO | Logging level |
| `MODEL_PRELOAD` | true | Load model on startup |
| `MODEL_IDLE_TIMEOUT` | 300 | Seconds before unloading idle model (0 = never) |
| `DEFAULT_MODEL` | z-image-turbo | Model to preload/use by default |

## VRAM Management

The model uses ~22GB VRAM when loaded. To free VRAM when not generating:

**Option 1: Idle timeout (recommended)**
```bash
# In .env - unload after 5 minutes of inactivity
MODEL_IDLE_TIMEOUT=300
```

**Option 2: No preload + short timeout**
```bash
# In .env - only load when needed, unload quickly
MODEL_PRELOAD=false
MODEL_IDLE_TIMEOUT=60
```

**Option 3: Always loaded (no timeout)**
```bash
# In .env - keep model in VRAM permanently
MODEL_IDLE_TIMEOUT=0
```

When the model is unloaded, the next generation request will take ~10-30s longer to reload.

## Troubleshooting

### GPU not detected
```bash
# Verify NVIDIA runtime
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

### Out of memory
- Reduce `base_size` in requests
- Use smaller aspect ratios
- Ensure no other GPU processes running

### Model download slow
- Add `HF_TOKEN` to `.env`
- Check network connectivity to huggingface.co
