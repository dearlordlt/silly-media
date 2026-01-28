# Silly Media - Development Guide

## Docker Commands

### Quick Reference
```bash
./restart.sh    # Fast: copies Python files to container + restart (use this for code changes)
./build.sh      # Full rebuild with --no-cache (only needed for dependency changes)
```

### restart.sh (Recommended for Code Changes)
Copies local `src/silly_media/` files directly into the running container and restarts. Much faster than full rebuild - no need to re-download CUDA drivers.

**Use for**:
- Modifying Python code (adding/editing models, routes, logic)
- Adding new model classes or registrations
- Updating configurations in Python files
- UI changes (ui.html is served statically)

**How it works**:
1. Checks if container is running
2. Copies `src/silly_media/` to container via `docker cp`
3. Restarts container with `docker compose restart`

### build.sh (Full Rebuild)
Full rebuild: runs `docker compose down && docker compose build --no-cache && docker compose up`

**Only needed when**:
- Changing dependencies in pyproject.toml
- Changing Dockerfile
- First time setup
- Container doesn't exist yet

### Dev Mode (Hot Reload)
```bash
docker compose --profile dev up silly-media-dev
```

Dev mode mounts `./src:/app/src:ro` so Python changes are picked up automatically via uvicorn's `--reload` flag. Best for active development.

## Key Files

- `docker-compose.yml` - Defines both `silly-media` (prod) and `silly-media-dev` (dev) services
- `src/silly_media/` - Main Python package
- `ui.html` - Single-file frontend (served statically, no build needed)

## Architecture Notes

### VRAM Management
The `vram_manager` handles GPU memory. Only one model is loaded at a time:
- When switching models (e.g., img2img to text2img), the current model is unloaded first
- This is handled automatically by `vram_manager.acquire_gpu(model)`

### Progress Tracking
- `/progress` - Text-to-image generation progress
- `/img2img/progress` - Image editing progress
- Both use `GenerationProgress` class from `src/silly_media/progress.py`
