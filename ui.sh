#!/bin/bash
# Launch the UI in a browser
# Set BROWSER env var to override (default: brave)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UI_FILE="$SCRIPT_DIR/ui.html"
BROWSER="${BROWSER:-brave}"

if [[ ! -f "$UI_FILE" ]]; then
    echo "Error: ui.html not found"
    exit 1
fi

"$BROWSER" "$UI_FILE"
