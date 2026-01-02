#!/bin/bash
#
# Generate pixel art examples with progress tracking and timing
# Usage: ./test-pixelart.sh [--size S] [--category CATEGORY]
#

# Don't use set -e because ((var++)) returns 1 when var is 0, which would exit
# set -e

API_URL="${API_URL:-http://localhost:4201}"
OUTPUT_DIR="$(dirname "$0")/images/icons"
SIZE=32
CATEGORY="all"  # all, items, characters, backgrounds

# Timing arrays
declare -a TIMES

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --size)
            SIZE="$2"
            shift 2
            ;;
        --category)
            CATEGORY="$2"
            shift 2
            ;;
        --output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Options:"
            echo "  --size S         Output size in pixels (default: 32)"
            echo "  --category CAT   Category to generate: all, items, characters, backgrounds (default: all)"
            echo "  --output DIR     Output directory (default: ./images/icons)"
            exit 0
            ;;
        *)
            shift
            ;;
    esac
done

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Items (7) - with background removal
ITEMS=(
    "golden coin"
    "red potion bottle"
    "wooden treasure chest"
    "silver sword"
    "magic wand with star tip"
    "golden key"
    "metal shield with crest"
)

# Characters (7) - with background removal
CHARACTERS=(
    "knight in armor"
    "wizard with hat"
    "green goblin"
    "skeleton warrior"
    "red dragon"
    "blue slime monster"
    "princess with crown"
)

# Backgrounds/Tiles (7) - NO background removal
BACKGROUNDS=(
    "grass tile seamless pattern"
    "stone brick wall tile"
    "blue water waves tile"
    "sand desert ground tile"
    "wooden floor planks tile"
    "white snow ground tile"
    "orange lava fire tile"
)

# Function to format seconds as mm:ss.s
format_time() {
    local seconds=$1
    local mins=$((${seconds%.*} / 60))
    local secs=$(echo "$seconds - $mins * 60" | bc)
    printf "%02d:%05.2f" "$mins" "$secs"
}

# Function to generate a single icon
generate_icon() {
    local prompt="$1"
    local remove_bg="$2"
    local category="$3"
    local index="$4"
    local total="$5"

    # Generate safe filename
    local safe_name=$(echo "$prompt" | tr -cd '[:alnum:] ' | tr ' ' '_' | cut -c1-30)
    local timestamp=$(date +%Y%m%d_%H%M%S)
    local output_file="$OUTPUT_DIR/${category}_${safe_name}_${timestamp}.png"

    printf "  [%2d/%2d] %-35s" "$index" "$total" "$prompt"

    # Build JSON payload
    local json_payload=$(cat <<EOF
{
    "prompt": "$prompt",
    "size": $SIZE,
    "remove_background": $remove_bg,
    "num_inference_steps": 9
}
EOF
)

    # Make request with timing
    local start_time=$(date +%s.%N)
    local http_code=$(curl -s -w "%{http_code}" -X POST "$API_URL/pixelart/generate" \
        -H "Content-Type: application/json" \
        -d "$json_payload" \
        -o "$output_file" 2>/dev/null)
    local end_time=$(date +%s.%N)
    local elapsed=$(echo "$end_time - $start_time" | bc)

    if [[ "$http_code" == "200" ]]; then
        TIMES+=("$elapsed")
        printf " %s  OK\n" "$(format_time $elapsed)"
        return 0
    else
        printf " FAILED (HTTP %s)\n" "$http_code"
        rm -f "$output_file"
        return 1
    fi
}

# Calculate total count based on category
total_count=0
if [[ "$CATEGORY" == "all" ]]; then
    total_count=$((${#ITEMS[@]} + ${#CHARACTERS[@]} + ${#BACKGROUNDS[@]}))
elif [[ "$CATEGORY" == "items" ]]; then
    total_count=${#ITEMS[@]}
elif [[ "$CATEGORY" == "characters" ]]; then
    total_count=${#CHARACTERS[@]}
elif [[ "$CATEGORY" == "backgrounds" ]]; then
    total_count=${#BACKGROUNDS[@]}
fi

echo "=== Pixel Art Generator ==="
echo "Output: $OUTPUT_DIR"
echo "Size: ${SIZE}x${SIZE}"
echo "Category: $CATEGORY ($total_count images)"
echo ""

generated=0
failed=0
current=0
total_start=$(date +%s.%N)

# Generate Items
if [[ "$CATEGORY" == "all" || "$CATEGORY" == "items" ]]; then
    echo "--- Items (with background removal) ---"
    for prompt in "${ITEMS[@]}"; do
        current=$((current + 1))
        if generate_icon "$prompt" "true" "item" "$current" "$total_count"; then
            generated=$((generated + 1))
        else
            failed=$((failed + 1))
        fi
    done
    echo ""
fi

# Generate Characters
if [[ "$CATEGORY" == "all" || "$CATEGORY" == "characters" ]]; then
    echo "--- Characters (with background removal) ---"
    for prompt in "${CHARACTERS[@]}"; do
        current=$((current + 1))
        if generate_icon "$prompt" "true" "char" "$current" "$total_count"; then
            generated=$((generated + 1))
        else
            failed=$((failed + 1))
        fi
    done
    echo ""
fi

# Generate Backgrounds (NO background removal)
if [[ "$CATEGORY" == "all" || "$CATEGORY" == "backgrounds" ]]; then
    echo "--- Backgrounds/Tiles (NO background removal) ---"
    for prompt in "${BACKGROUNDS[@]}"; do
        current=$((current + 1))
        if generate_icon "$prompt" "false" "bg" "$current" "$total_count"; then
            generated=$((generated + 1))
        else
            failed=$((failed + 1))
        fi
    done
    echo ""
fi

total_end=$(date +%s.%N)
total_elapsed=$(echo "$total_end - $total_start" | bc)

echo "=== Complete ==="
echo ""

# Calculate timing statistics
if [[ ${#TIMES[@]} -gt 0 ]]; then
    # Calculate sum, min, max
    sum=0
    min=${TIMES[0]}
    max=${TIMES[0]}
    for t in "${TIMES[@]}"; do
        sum=$(echo "$sum + $t" | bc)
        if (( $(echo "$t < $min" | bc -l) )); then min=$t; fi
        if (( $(echo "$t > $max" | bc -l) )); then max=$t; fi
    done
    avg=$(echo "scale=2; $sum / ${#TIMES[@]}" | bc)

    echo "Timing Statistics:"
    echo "  Total time:   $(format_time $total_elapsed)"
    echo "  Average:      $(format_time $avg)"
    echo "  Fastest:      $(format_time $min)"
    echo "  Slowest:      $(format_time $max)"
    echo ""
fi

echo "Results:"
echo "  Generated: $generated"
echo "  Failed:    $failed"
echo "  Output:    $OUTPUT_DIR"

# List generated files
if [[ $generated -gt 0 ]]; then
    echo ""
    echo "Generated files:"
    ls -1 "$OUTPUT_DIR"/*.png 2>/dev/null | tail -n 21 | while read f; do
        size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f" 2>/dev/null)
        printf "  %6d bytes  %s\n" "$size" "$(basename "$f")"
    done
fi
