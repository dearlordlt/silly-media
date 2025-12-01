#!/bin/bash

# Test image generation script
# Usage: ./test-generate.sh "your prompt here" [options]

set -e

API_URL="${API_URL:-http://localhost:4201}"
MODEL="${MODEL:-z-image-turbo}"
OUTPUT_DIR="$(dirname "$0")/images"

# Default values
PROMPT=""
NEGATIVE_PROMPT=""
STEPS=9
CFG_SCALE=5.0
SEED=""
WIDTH=""
HEIGHT=""
ASPECT_RATIO=""
BASE_SIZE=1024

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -p|--prompt)
            PROMPT="$2"
            shift 2
            ;;
        -n|--negative)
            NEGATIVE_PROMPT="$2"
            shift 2
            ;;
        -s|--steps)
            STEPS="$2"
            shift 2
            ;;
        -c|--cfg)
            CFG_SCALE="$2"
            shift 2
            ;;
        --seed)
            SEED="$2"
            shift 2
            ;;
        -w|--width)
            WIDTH="$2"
            shift 2
            ;;
        -h|--height)
            HEIGHT="$2"
            shift 2
            ;;
        -a|--aspect)
            ASPECT_RATIO="$2"
            shift 2
            ;;
        -b|--base-size)
            BASE_SIZE="$2"
            shift 2
            ;;
        -m|--model)
            MODEL="$2"
            shift 2
            ;;
        -o|--output)
            OUTPUT_DIR="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 -p \"prompt\" [options]"
            echo ""
            echo "Options:"
            echo "  -p, --prompt      Text prompt (required)"
            echo "  -n, --negative    Negative prompt"
            echo "  -s, --steps       Inference steps (default: 9 for z-image-turbo)"
            echo "  -c, --cfg         CFG scale (default: 5.0, ignored by turbo models)"
            echo "  --seed            Random seed for reproducibility"
            echo "  -w, --width       Image width (64-2048)"
            echo "  -h, --height      Image height (64-2048)"
            echo "  -a, --aspect      Aspect ratio (1:1, 16:9, 9:16, 4:3, 3:4, etc.)"
            echo "  -b, --base-size   Base size for aspect ratio (default: 1024)"
            echo "  -m, --model       Model name (default: z-image-turbo)"
            echo "  -o, --output      Output directory (default: ./images)"
            echo ""
            echo "Examples:"
            echo "  $0 -p \"a red panda eating bamboo\""
            echo "  $0 -p \"sunset over mountains\" -a 16:9 --seed 42"
            echo "  $0 -p \"portrait photo\" -w 768 -h 1024"
            echo "  $0 -p \"test prompt\" -m z-image-turbo  # switch model"
            exit 0
            ;;
        *)
            # If no flag, treat as prompt
            if [[ -z "$PROMPT" ]]; then
                PROMPT="$1"
            fi
            shift
            ;;
    esac
done

# Validate prompt
if [[ -z "$PROMPT" ]]; then
    echo "Error: Prompt is required"
    echo "Usage: $0 -p \"your prompt here\" [options]"
    exit 1
fi

# Create output directory
mkdir -p "$OUTPUT_DIR"

# Build JSON payload
JSON_PAYLOAD=$(cat <<EOF
{
    "prompt": "$PROMPT",
    "negative_prompt": "$NEGATIVE_PROMPT",
    "num_inference_steps": $STEPS,
    "cfg_scale": $CFG_SCALE
EOF
)

# Add optional fields
if [[ -n "$SEED" ]]; then
    JSON_PAYLOAD="$JSON_PAYLOAD, \"seed\": $SEED"
fi

if [[ -n "$WIDTH" && -n "$HEIGHT" ]]; then
    JSON_PAYLOAD="$JSON_PAYLOAD, \"width\": $WIDTH, \"height\": $HEIGHT"
elif [[ -n "$ASPECT_RATIO" ]]; then
    JSON_PAYLOAD="$JSON_PAYLOAD, \"aspect_ratio\": \"$ASPECT_RATIO\", \"base_size\": $BASE_SIZE"
fi

JSON_PAYLOAD="$JSON_PAYLOAD }"

# Generate filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SAFE_PROMPT=$(echo "$PROMPT" | tr -cd '[:alnum:] ' | tr ' ' '_' | cut -c1-30)
OUTPUT_FILE="$OUTPUT_DIR/${TIMESTAMP}_${SAFE_PROMPT}.png"

echo "Generating image..."
echo "Model: $MODEL"
echo "Prompt: $PROMPT"
echo "Output: $OUTPUT_FILE"
echo ""

# Make request
HTTP_CODE=$(curl -s -w "%{http_code}" -X POST "$API_URL/generate/$MODEL" \
    -H "Content-Type: application/json" \
    -d "$JSON_PAYLOAD" \
    -o "$OUTPUT_FILE")

if [[ "$HTTP_CODE" == "200" ]]; then
    echo "Success! Image saved to: $OUTPUT_FILE"

    # Show image size
    if command -v file &> /dev/null; then
        file "$OUTPUT_FILE"
    fi
else
    echo "Error: HTTP $HTTP_CODE"
    # Show error message if it's JSON
    if [[ -f "$OUTPUT_FILE" ]]; then
        cat "$OUTPUT_FILE"
        rm "$OUTPUT_FILE"
    fi
    exit 1
fi
