# Test Prompts

Example commands for testing image generation and text-to-speech.

---

## Image Generation

Uses `z-image-turbo` by default (9 steps, fast generation).

### Portrait Photography

#### 1. Classic Headshot

```bash
./test-generate.sh -p "professional headshot of a young woman with natural makeup, soft studio lighting, neutral gray background, sharp focus on eyes, 85mm lens" -a 4:5
```

#### 2. Natural Light Portrait

```bash
./test-generate.sh -p "candid portrait of a woman in her 20s, golden hour sunlight, outdoor cafe setting, warm tones, shallow depth of field, looking away from camera" -a 3:4
```

#### 3. Fashion Editorial

```bash
./test-generate.sh -p "high fashion editorial photo of a female model, dramatic side lighting, black turtleneck, minimalist aesthetic, strong cheekbones, vogue magazine style" -a 2:3
```

#### 4. Beauty Close-up

```bash
./test-generate.sh -p "beauty portrait close-up of a woman, flawless skin, subtle glossy lips, professional makeup, ring light catchlights in eyes, clean white background" -a 1:1
```

#### 5. Environmental Portrait

```bash
./test-generate.sh -p "lifestyle portrait of a woman in a modern apartment, natural window light, casual elegant outfit, relaxed pose on sofa, interior design background, film photography style" -a 4:3
```

#### 6. Cinematic Portrait

```bash
./test-generate.sh -p "cinematic portrait of a woman, moody blue and orange color grading, urban night background with bokeh lights, leather jacket, confident expression, anamorphic lens flare" -a 16:9
```

### Tips

- Default model is `z-image-turbo` (9 steps, very fast)
- Omit `--seed` for random results, or use `--seed 42` for reproducibility
- Aspect ratios: `4:5` and `2:3` work well for portraits, `1:1` for headshots
- Z-Image Turbo ignores CFG scale (uses 0.0 internally for best results)
- Add negative prompts with `-n "blurry, distorted, ugly"` if needed

---

## Text-to-Speech (TTS)

### Create an Actor (Zero-Shot Voice Cloning)

Create a voice profile from a reference audio file:

```bash
# Create actor with single audio file
curl -X POST http://localhost:4201/actors \
  -F "name=Morgan Freeman" \
  -F "language=en" \
  -F "description=Deep, calm, authoritative narrator voice" \
  -F "audio_files=@morgan_sample.wav"

# Create actor with multiple audio files (better quality)
curl -X POST http://localhost:4201/actors \
  -F "name=David Attenborough" \
  -F "language=en" \
  -F "description=British nature documentary narrator" \
  -F "audio_files=@david_clip1.wav" \
  -F "audio_files=@david_clip2.wav" \
  -F "audio_files=@david_clip3.wav"
```

### List Actors

```bash
curl -s http://localhost:4201/actors | python3 -m json.tool
```

### Generate Speech (Batch)

```bash
# Simple text
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello, welcome to Silly Media.", "actor": "Morgan Freeman"}' \
  -o hello.wav

# Longer narration
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "In the beginning, there was silence. Then came the sound of a single voice, speaking words that would change everything.",
    "actor": "Morgan Freeman",
    "language": "en",
    "speed": 0.9
  }' \
  -o narration.wav

# Multilingual (Spanish)
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hola, bienvenidos a nuestra aplicacion. Es un placer tenerlos aqui.",
    "actor": "Morgan Freeman",
    "language": "es"
  }' \
  -o spanish.wav
```

### Generate Speech (Streaming)

For lower time-to-first-audio on longer texts:

```bash
curl -X POST http://localhost:4201/tts/stream \
  -H "Content-Type: application/json" \
  -d '{
    "text": "This is a very long text that will be streamed as it generates, providing faster initial response times.",
    "actor": "Morgan Freeman"
  }' \
  -o streamed.wav
```

### One-Shot TTS (No Stored Actor)

Quick voice synthesis without creating an actor:

```bash
curl -X POST http://localhost:4201/tts/generate-with-audio \
  -F "text=Hello, this is a quick test of one-shot voice cloning." \
  -F "language=en" \
  -F "reference_audio=@my_voice.wav" \
  -o oneshot.wav
```

### Add More Audio to Existing Actor

```bash
curl -X POST http://localhost:4201/actors/Morgan%20Freeman/audio \
  -F "audio_file=@additional_sample.wav"
```

### Delete an Actor

```bash
curl -X DELETE http://localhost:4201/actors/Morgan%20Freeman
```

---

## TTS Test Scripts

### test-tts.sh

Create a test script for quick TTS testing:

```bash
#!/bin/bash
# test-tts.sh - Quick TTS test

ACTOR="${1:-Test Actor}"
TEXT="${2:-Hello, this is a test of the text to speech system.}"
OUTPUT="${3:-output.wav}"

curl -s -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$TEXT\", \"actor\": \"$ACTOR\"}" \
  -o "$OUTPUT"

echo "Generated: $OUTPUT"
file "$OUTPUT"
```

Usage:
```bash
chmod +x test-tts.sh
./test-tts.sh "Morgan Freeman" "Welcome to the future of voice synthesis."
```

### test-actor-create.sh

Create a test script for actor creation:

```bash
#!/bin/bash
# test-actor-create.sh - Create an actor from audio file

NAME="$1"
AUDIO="$2"
LANG="${3:-en}"

if [ -z "$NAME" ] || [ -z "$AUDIO" ]; then
  echo "Usage: $0 <name> <audio_file> [language]"
  echo "Example: $0 'John Smith' voice.wav en"
  exit 1
fi

curl -s -X POST http://localhost:4201/actors \
  -F "name=$NAME" \
  -F "language=$LANG" \
  -F "audio_files=@$AUDIO" | python3 -m json.tool
```

Usage:
```bash
chmod +x test-actor-create.sh
./test-actor-create.sh "My Voice" recording.wav en
```

---

## Example Test Session

Complete workflow from actor creation to speech generation:

```bash
# 1. Check service health
curl -s http://localhost:4201/health | python3 -m json.tool

# 2. List existing actors
curl -s http://localhost:4201/actors | python3 -m json.tool

# 3. Create a new actor (need a WAV file)
curl -X POST http://localhost:4201/actors \
  -F "name=Narrator" \
  -F "language=en" \
  -F "description=Professional audiobook narrator" \
  -F "audio_files=@narrator_sample.wav"

# 4. Verify actor was created
curl -s http://localhost:4201/actors/Narrator | python3 -m json.tool

# 5. Generate speech
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{"text": "Once upon a time, in a land far away...", "actor": "Narrator"}' \
  -o story.wav

# 6. Play the audio (Linux)
aplay story.wav
# Or on macOS:
# afplay story.wav

# 7. Test with different parameters
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Speaking slowly and clearly for emphasis.",
    "actor": "Narrator",
    "speed": 0.8,
    "temperature": 0.5
  }' \
  -o slow.wav

# 8. Test multilingual (same voice, different language)
curl -X POST http://localhost:4201/tts/generate \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Bonjour, comment allez-vous?",
    "actor": "Narrator",
    "language": "fr"
  }' \
  -o french.wav
```

---

## Audio File Requirements

For best voice cloning results:

| Requirement | Recommendation |
|-------------|----------------|
| Duration | 6-30 seconds (minimum 6s) |
| Format | WAV, MP3, FLAC, OGG |
| Sample rate | 22kHz+ (24kHz ideal) |
| Channels | Mono preferred |
| Quality | Clean, no background noise |
| Content | Natural speech, varied intonation |

### Tips for Recording Reference Audio

1. **Clean environment**: Record in a quiet room
2. **Consistent distance**: Keep mic distance constant
3. **Natural speech**: Speak naturally, not monotone
4. **Varied content**: Include questions, statements, exclamations
5. **No music/effects**: Pure speech only
