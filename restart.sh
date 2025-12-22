#!/bin/bash
# Copy Python files to container and restart (fast reload for code changes)
CONTAINER=$(docker compose ps -q silly-media)

if [ -z "$CONTAINER" ]; then
    echo "Container not running. Use ./build.sh first."
    exit 1
fi

echo "Copying source files..."
docker cp src/silly_media/. "$CONTAINER":/app/src/silly_media/

echo "Restarting container..."
docker compose restart

echo "Done!"
