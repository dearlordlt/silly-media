# Silly Media UI

Single-page React app for the whole Silly Media API — replaces the individual
`ui*.html` clients with one routed desktop UI.

## Run

```bash
./ui.sh              # build if needed, serve on :5273, open default browser
./ui.sh --rebuild    # force a fresh production build
./ui.sh --dev        # Vite dev server with HMR
./ui.sh --api http://box:4201
./ui.sh --port 8080
./ui.sh --no-open
```

`ui.sh` serves the built app at `http://127.0.0.1:5273/ui/` using the
dependency-free `serve.mjs`. The app talks to the API at `http://localhost:4201`
by default; a `?api=` query param or the System page changes that at runtime.

## Develop

```bash
npm install
npm run dev        # http://localhost:5273/ui/
npm run build      # -> dist/
npm run typecheck  # tsc --noEmit
```

## Pages

| Route      | Covers |
| ---------- | ------ |
| `/studio`  | Text-to-image: every registered image model, batch mode, stacked LoRAs, ESRGAN upscale, transparency, presets |
| `/edit`    | img2img with the preset-chip composer, reference images (Qwen 2.1), RGBA output |
| `/assets`  | Pixel art (`/pixelart`) and sprite cutouts (`/sprite`) |
| `/audio`   | TTS (XTTS v2 + Maya), actors (upload / YouTube), Maya voice presets, history |
| `/music`   | ACE-Step 1.5 music generation with captions, lyrics and metadata |
| `/video`   | LTX-2.5 text-to-video and image-to-video with synchronized audio |
| `/3d`      | Hunyuan3D text/image to GLB, in-page model-viewer |
| `/vision`  | Qwen3-VL image analysis and OCR |
| `/chat`    | Local LLM chat with streaming |
| `/library` | Every generated artifact, stored locally in IndexedDB |
| `/system`  | Backend health, model inventory, storage usage, endpoint config |

All generated media is persisted in IndexedDB (`silly-media-library`) so results
survive reloads and are shared across pages.
