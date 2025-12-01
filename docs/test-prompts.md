# Test Prompts

Example commands for testing image generation with portrait photography prompts.

## Portrait Photography

### 1. Classic Headshot

```bash
./test-generate.sh -p "professional headshot of a young woman with natural makeup, soft studio lighting, neutral gray background, sharp focus on eyes, 85mm lens" -a 4:5 -s 50
```

### 2. Natural Light Portrait

```bash
./test-generate.sh -p "candid portrait of a woman in her 20s, golden hour sunlight, outdoor cafe setting, warm tones, shallow depth of field, looking away from camera" -a 3:4 -s 50
```

### 3. Fashion Editorial

```bash
./test-generate.sh -p "high fashion editorial photo of a female model, dramatic side lighting, black turtleneck, minimalist aesthetic, strong cheekbones, vogue magazine style" -a 2:3 -s 50 -c 6.0
```

### 4. Beauty Close-up

```bash
./test-generate.sh -p "beauty portrait close-up of a woman, flawless skin, subtle glossy lips, professional makeup, ring light catchlights in eyes, clean white background" -a 1:1 -s 50
```

### 5. Environmental Portrait

```bash
./test-generate.sh -p "lifestyle portrait of a woman in a modern apartment, natural window light, casual elegant outfit, relaxed pose on sofa, interior design background, film photography style" -a 4:3 -s 50
```

### 6. Cinematic Portrait

```bash
./test-generate.sh -p "cinematic portrait of a woman, moody blue and orange color grading, urban night background with bokeh lights, leather jacket, confident expression, anamorphic lens flare" -a 16:9 -s 50 -c 5.5
```

## Tips

- Omit `--seed` for random results, or use `--seed 42` for reproducibility
- Aspect ratios: `4:5` and `2:3` work well for portraits, `1:1` for headshots
- Increase `-c` (CFG scale) for more prompt adherence, decrease for more creativity
- Add negative prompts with `-n "blurry, distorted, ugly"` if needed
