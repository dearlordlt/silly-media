#!/usr/bin/env bash
# Silly Media desktop UI launcher.
#
# Builds the React UI (ui/) if needed, serves it together with the profile's
# local library (ui/server/) over http://127.0.0.1:<port>/ui/, and opens it in
# the default browser. Generation requests go to the API on :4201.
#
# Usage:
#   ./ui.sh                  # build if stale, serve profile "default" on :5273, open browser
#   ./ui.sh --profile NAME   # separate library + settings (e.g. "agent"); first free port from 5274
#   ./ui.sh --list-profiles  # list profiles with data size and running port
#   ./ui.sh --rebuild        # force a fresh production build
#   ./ui.sh --dev            # Vite dev server with HMR + the profile's app server (API only)
#   ./ui.sh --api URL        # use a different generation API base
#   ./ui.sh --port N         # serve on a specific port
#   ./ui.sh --no-open        # do not open the browser
#
# One server per profile: if the profile is already being served, its page is
# opened instead of starting another. Profile data lives in
# ${SILLY_UI_HOME:-${XDG_DATA_HOME:-~/.local/share}/silly-media-ui}/profiles/NAME.
#
# Env overrides: UI_PORT, UI_PROFILE, SILLY_UI_HOME, API_URL, BROWSER
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_DIR="$SCRIPT_DIR/ui"
DIST_DIR="$UI_DIR/dist"
SERVER="$UI_DIR/server/index.mjs"

PORT="${UI_PORT:-}"
PROFILE="${UI_PROFILE:-default}"
API_URL="${API_URL:-http://localhost:4201}"
DATA_ROOT="${SILLY_UI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/silly-media-ui}"
PROFILES_DIR="$DATA_ROOT/profiles"
REBUILD=0
DEV=0
OPEN=1
LIST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rebuild) REBUILD=1 ;;
    --dev) DEV=1 ;;
    --no-open) OPEN=0 ;;
    --list-profiles) LIST=1 ;;
    --api) API_URL="${2:?--api needs a URL}"; shift ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    --profile) PROFILE="${2:?--profile needs a name}"; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ ! "$PROFILE" =~ ^[A-Za-z0-9_-]{1,32}$ ]]; then
  echo "Error: invalid profile name '$PROFILE' (letters, digits, '_' and '-', at most 32)" >&2
  exit 2
fi
if [[ -n "$PORT" && ! ( "$PORT" =~ ^[0-9]+$ && "$PORT" -ge 1 && "$PORT" -le 65535 ) ]]; then
  echo "Error: invalid port '$PORT'" >&2
  exit 2
fi
PROFILE_DIR="$PROFILES_DIR/$PROFILE"

# Field of a server.json (compact JSON written by ui/server/index.mjs).
json_field() { sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\).*/\1/p" "$1" 2>/dev/null; }

# "pid port apiOnly" of the profile dir's server when its pid is alive.
live_server() {
  local f="$1/server.json" pid port
  [[ -f "$f" ]] || return 1
  pid="$(json_field "$f" pid)"
  port="$(json_field "$f" port)"
  [[ "$pid" =~ ^[0-9]+$ && "$port" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid $port $(json_field "$f" apiOnly)"
}

# Profile name reported by a Silly Media app server on a local port (empty if none).
served_profile() {
  curl -sf -m 2 "http://127.0.0.1:$1/app-api/info" 2>/dev/null |
    sed -n 's/.*"app":"silly-media-ui".*"profile":"\([^"]*\)".*/\1/p' || true
}

port_busy() {
  lsof -nP -i ":$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
  ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN && return 0
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# First free port from $1 upward, skipping $2 (a port already claimed but not yet bound).
free_port() {
  local p="$1"
  while [[ "$p" == "${2:-}" ]] || port_busy "$p"; do
    p=$((p + 1))
    if (( p > $1 + 200 )); then echo "Error: no free port in $1..$p" >&2; return 1; fi
  done
  echo "$p"
}

# Fail with a hint when an explicitly chosen (or the default) port is taken.
require_free_port() {
  port_busy "$1" || return 0
  local other
  other="$(served_profile "$1")"
  if [[ -n "$other" ]]; then
    echo "Error: port $1 is serving Silly Media profile '$other'." >&2
  else
    echo "Error: port $1 is in use by another process (an old ./ui.sh server? stop it with Ctrl+C)." >&2
  fi
  echo "Hint: pick another port with --port N (or UI_PORT=N)." >&2
  exit 1
}

list_profiles() {
  local d name size s pid port api status found=0
  printf '%-32s  %8s  %s\n' PROFILE SIZE STATUS
  for d in "$PROFILES_DIR"/*/; do
    [[ -d "$d" ]] || continue
    found=1
    name="$(basename "$d")"
    size="$(du -sh "$d" 2>/dev/null | cut -f1)"
    status="stopped"
    if s="$(live_server "$d")"; then
      read -r pid port api <<<"$s"
      status="running on http://127.0.0.1:$port/ui/ (pid $pid)"
      [[ "$api" == "true" ]] && status="running (dev, app API on :$port, pid $pid)"
    fi
    printf '%-32s  %8s  %s\n' "$name" "$size" "$status"
  done
  [[ "$found" -eq 1 ]] || echo "(no profiles yet)"
  echo
  echo "Data root: $DATA_ROOT"
}

if [[ "$LIST" -eq 1 ]]; then
  list_profiles
  exit 0
fi

command -v node >/dev/null || { echo "Error: node is required (install Node.js 22.13+)" >&2; exit 1; }
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 23 || (a === 23 && b >= 4) || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo "Error: Node.js >= 22.13 is required (built-in node:sqlite); found $(node --version)" >&2
  exit 1
fi

open_browser() {
  [[ "$OPEN" -eq 1 ]] || return 0
  local url="$1"
  if [[ -n "${BROWSER:-}" ]]; then
    "$BROWSER" "$url" >/dev/null 2>&1 &
  else
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}

# One server per profile: reuse a live one instead of starting another.
REUSE_PORT=""
if s="$(live_server "$PROFILE_DIR")"; then
  read -r LIVE_PID LIVE_PORT LIVE_API_ONLY <<<"$s"
  if [[ "$(served_profile "$LIVE_PORT")" != "$PROFILE" ]]; then
    echo "Error: $PROFILE_DIR/server.json names live pid $LIVE_PID on port $LIVE_PORT, but it does not answer as profile '$PROFILE'." >&2
    echo "If that process is not a Silly Media server, delete the file and retry." >&2
    exit 1
  fi
  if [[ "$DEV" -eq 1 ]]; then
    REUSE_PORT="$LIVE_PORT" # any live server of this profile can back the dev UI
  elif [[ "$LIVE_API_ONLY" == "true" ]]; then
    echo "Error: profile '$PROFILE' is in use by a dev session (app API on :$LIVE_PORT, pid $LIVE_PID); stop it first." >&2
    exit 1
  else
    URL="http://127.0.0.1:${LIVE_PORT}/ui/?api=${API_URL}"
    [[ -n "$PORT" && "$PORT" != "$LIVE_PORT" ]] && echo "Note: profile '$PROFILE' already runs on port $LIVE_PORT (ignoring --port $PORT)." >&2
    open_browser "$URL"
    echo "  Silly Media UI [$PROFILE]  ->  ${URL}  (existing server, pid $LIVE_PID, left running)"
    exit 0
  fi
fi

if [[ -n "$PORT" ]]; then
  require_free_port "$PORT"
elif [[ "$PROFILE" == "default" ]]; then
  PORT=5273
  require_free_port "$PORT"
else
  PORT="$(free_port 5274)"
fi

mkdir -p "$PROFILE_DIR"
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

banner() {
  cat <<EOF

  Silly Media UI  ->  $1
  Profile         ->  ${PROFILE}
  Data dir        ->  ${PROFILE_DIR}
  API backend     ->  ${API_URL}
  Press Ctrl+C to stop.

EOF
}

if [[ "$DEV" -eq 1 ]]; then
  if [[ -n "$REUSE_PORT" ]]; then
    APP_PORT="$REUSE_PORT"
    echo "Using the running app server of profile '$PROFILE' on :$APP_PORT"
  else
    APP_PORT="$(free_port 5280 "$PORT")"
    node "$SERVER" --api-only --port "$APP_PORT" --host 127.0.0.1 --profile "$PROFILE" --data-dir "$PROFILE_DIR" &
    APP_PID=$!
    trap 'kill "$APP_PID" 2>/dev/null || true; wait "$APP_PID" 2>/dev/null || true' EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    for _ in $(seq 50); do
      [[ "$(served_profile "$APP_PORT")" == "$PROFILE" ]] && break
      kill -0 "$APP_PID" 2>/dev/null || { echo "Error: app server failed to start" >&2; exit 1; }
      sleep 0.1
    done
  fi
  export SILLY_APP_API="http://127.0.0.1:${APP_PORT}"
  URL="http://127.0.0.1:${PORT}/ui/?api=${API_URL}"
  banner "$URL"
  # Bind the exact host we open, and let Vite open the browser once it is listening.
  DEV_ARGS=(--port "$PORT" --host 127.0.0.1 --strictPort)
  [[ "$OPEN" -eq 1 ]] && DEV_ARGS+=(--open "/ui/?api=${API_URL}")
  npm run dev -- "${DEV_ARGS[@]}"
  exit $?
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
open_browser "$URL"
banner "$URL"

exec node "$SERVER" --root "$DIST_DIR" --base /ui/ --port "$PORT" --host 127.0.0.1 --profile "$PROFILE" --data-dir "$PROFILE_DIR"
