# Silly Media UI

Single-page React app for the whole Silly Media API — replaces the individual
`ui*.html` clients with one routed desktop UI.

## Run

```bash
./ui.sh                  # build if needed, serve profile "default" on :5273, open default browser
./ui.sh --profile agent  # separate library + settings, first free port from 5274
./ui.sh --list-profiles
./ui.sh --rebuild        # force a fresh production build
./ui.sh --dev            # Vite dev server with HMR (+ the profile's app server)
./ui.sh --api http://box:4201
./ui.sh --port 8080
./ui.sh --no-open
```

`ui.sh` runs `server/index.mjs` (Node ≥ 22.13, built-ins only): it serves the
built app at `http://127.0.0.1:<port>/ui/` and owns the profile's library under
`/app-api`. The app talks to the generation API at `http://localhost:4201` by
default; a `?api=` query param or the System page changes that at runtime.

## Profiles and storage

Each profile is a directory under
`${SILLY_UI_HOME:-${XDG_DATA_HOME:-~/.local/share}/silly-media-ui}/profiles/<name>/`:

- `library.db` — SQLite (`node:sqlite`): item metadata, tags, favourites, and all
  settings / prompt history / chats (key-value table)
- `files/`, `thumbs/` — the generated media and their previews
- `server.json` — pid/port of the running server (one server per profile)

Nothing is kept in browser storage, so the same profile looks the same in any
browser. Data from the old IndexedDB-based UI can be imported once from the
banner or the System page (open the UI on the origin that wrote it, i.e. the
default profile on :5273).

## Develop

```bash
npm install
../ui.sh --dev     # Vite on :5273 (default profile), /app-api proxied to the app server
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
| `/`        | Home: quick start, recent results, backend + queue status |
| `/library` | Every generated artifact, with tags, favourites, bulk actions and deep links (`?q=`, `?item=`) |
| `/system`  | Backend health, model inventory, profile & storage, legacy import, notifications |

Generation runs through one app-wide queue (header tray): jobs keep running
when you switch pages, GPU work runs one job at a time, and finished jobs can
raise desktop notifications. Ctrl/⌘+K opens the command palette; Ctrl/⌘+Enter
runs the current page's main action.
