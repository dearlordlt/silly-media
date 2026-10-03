#!/usr/bin/env bash
# Silly Media desktop UI launcher.
#
# Builds the React UI (ui/) if needed, serves it over http://127.0.0.1:5273/ui/,
# and opens it in the default browser. The SPA talks to the API on :4201.
#
# Usage:
#   ./ui.sh                  # build if stale, serve, open browser
#   ./ui.sh --rebuild        # force a fresh production build
#   ./ui.sh --dev            # Vite dev server with HMR (no build, opens browser)
#   ./ui.sh --api URL        # use a different API base
#   ./ui.sh --port N         # serve on a different port
#   ./ui.sh --no-open        # do not open the browser
#
# Env overrides: UI_PORT, API_URL, BROWSER
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$SCRIPT_DIR/ui"
DIST_DIR="$UI_DIR/dist"

PORT="${UI_PORT:-5273}"
API_URL="${API_URL:-http://localhost:4201}"
REBUILD=0
DEV=0
OPEN=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --dev) DEV=1 ;;
    --no-open) OPEN=0 ;;
    --api) API_URL="${2:?--api needs a URL}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v node >/dev/null || { echo "Error: node is required (install Node.js 18+)" >&2; exit 1; }
command -v npm >/dev/null || { echo "Error: npm is required" >&2; exit 1; }

cd "$UI_DIR"

if [[ ! -d node_modules ]]; then
  echo "Installing UI dependencies…"
  npm install --no-audit --no-fund
fi

# Rebuild when sources are newer than the last build.
needs_build() {
  [[ ! -f "$DIST_DIR/index.html" ]] && return 0
  [[ -n "$(find src index.html vite.config.ts package.json -newer "$DIST_DIR/index.html" -print -quit 2>/dev/null)" ]]
}

open_browser() {
  [[ "$OPEN" -eq 1 ]] || return 0
  local url="$1"
  if [[ -n "${BROWSER:-}" ]]; then
    "$BROWSER" "$url" >/dev/null 2>&1 &
  else
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}

if [[ "$DEV" -eq 1 ]]; then
  URL="http://127.0.0.1:${PORT}/ui/?api=${API_URL}"
  echo "Starting Vite dev server on ${URL}"
  # Bind the exact host we open, and let Vite open the browser once it is listening.
  DEV_ARGS=(--port "$PORT" --host 127.0.0.1 --strictPort)
  [[ "$OPEN" -eq 1 ]] && DEV_ARGS+=(--open "/ui/?api=${API_URL}")
  exec npm run dev -- "${DEV_ARGS[@]}"
fi

if [[ "$REBUILD" -eq 1 ]] || needs_build; then
  echo "Building UI…"
  npm run build
else
  echo "UI already built (use --rebuild to force)."
fi

if ! curl -sf -m 2 "${API_URL}/health" >/dev/null 2>&1; then
  echo "Warning: ${API_URL}/health is not responding — start the service with ./restart.sh" >&2
fi

URL="http://127.0.0.1:${PORT}/ui/?api=${API_URL}"
if lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1 || ss -ltn "sport = :${PORT}" 2>/dev/null | grep -q LISTEN; then
  echo "Note: port ${PORT} already in use — reusing the existing server." >&2
  open_browser "$URL"
  echo "  Silly Media UI  ->  ${URL}  (existing server left running)"
  exit 0
fi

open_browser "$URL"

cat <<EOF

  Silly Media UI  ->  ${URL}
  API backend     ->  ${API_URL}
  Press Ctrl+C to stop the server.

EOF

exec node "$UI_DIR/serve.mjs" --root "$DIST_DIR" --base /ui/ --port "$PORT"
