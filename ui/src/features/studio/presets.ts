/** Model capability metadata and presets for the Studio page (ported from legacy ui.html). */
export interface ImageModelInfo {
  id: string
  label: string
  /** Default steps / cfg without the turbo LoRA. */
  steps: number
  cfgDefault: number
  /** Whether cfg_scale / negative_prompt do anything. */
  cfg: boolean
  /** Turbo LoRA toggle (`use_lora`) and its steps/cfg schedule. */
  turboLora?: { label: string; steps: number; cfg: number }
  /** Qwen 2.1 extras: RGBA output, size + settings presets. */
  supportsTransparent?: boolean
  note?: string
}

export const IMAGE_MODELS: ImageModelInfo[] = [
  {
    id: 'z-image-turbo',
    label: 'Z-Image Turbo',
    steps: 9,
    cfgDefault: 0,
    cfg: false,
    note: 'Default. 9-step turbo, bilingual text rendering. CFG is ignored internally.',
  },
  {
    id: 'z-image',
    label: 'Z-Image',
    steps: 30,
    cfgDefault: 4.0,
    cfg: true,
    note: 'Full CFG support (3.0–5.0) and negative prompts. Higher quality, slower.',
  },
  {
    id: 'z-image-turbo-pm',
    label: 'Z-Image Turbo PM',
    steps: 9,
    cfgDefault: 0,
    cfg: true,
    note: 'PornMaster V3.5 NSFW fine-tune. cfg_scale honoured (≤1.5 recommended with negatives).',
  },
  {
    id: 'qwen-image-2512',
    label: 'Qwen Image 2512',
    steps: 50,
    cfgDefault: 4.0,
    cfg: true,
    turboLora: { label: 'Use Turbo LoRA (6 steps, faster)', steps: 6, cfg: 1.0 },
    note: 'GGUF Q5_K_M. Turbo LoRA cuts 50 steps to 6.',
  },
  {
    id: 'qwen-image-2.1',
    label: 'Qwen Image 2.1 Uncensored',
    steps: 40,
    cfgDefault: 1.0,
    cfg: true,
    turboLora: { label: 'Use Turbo LoRA (6 steps, ~5x faster; 9 steps = hybrid)', steps: 6, cfg: 1.0 },
    supportsTransparent: true,
    note: 'Uncensored. Best typography + native transparency (RGBA). 40 steps CFG 1, or 6 with the turbo LoRA. Turbo is opt-in: switching to this model always starts from the base schedule.',
  },
  {
    id: 'krea-2-turbo',
    label: 'Krea 2 Turbo',
    steps: 8,
    cfgDefault: 0,
    cfg: false,
    note: 'Guidance disabled — only the positive prompt is encoded. Prefer base ≤896 on a 24GB GPU.',
  },
  {
    id: 'ovis-image-7b',
    label: 'Ovis Image 7B',
    steps: 50,
    cfgDefault: 5.0,
    cfg: true,
    note: 'Not installed unless the weights are re-downloaded.',
  },
]

export const modelInfo = (id: string): ImageModelInfo | undefined => IMAGE_MODELS.find((m) => m.id === id)

/** Steps/cfg a model starts with for the given turbo-LoRA state. */
export function modelDefaults(m: ImageModelInfo, useLora: boolean): { steps: number; cfg: number } {
  return useLora && m.turboLora ? { steps: m.turboLora.steps, cfg: m.turboLora.cfg } : { steps: m.steps, cfg: m.cfgDefault }
}

/** Qwen 2.1 size presets: keep the aspect ratio, scale the pixel area (~1MP / ~2.4MP / ~4MP). */
export const QWEN21_SIZES = [
  { label: '1K', value: 1024, title: '~1MP, fastest' },
  { label: '1.5K', value: 1536, title: '~2.4MP' },
  { label: '2K native', value: 2048, title: '~4MP, native 2K' },
]

export const QWEN21_TEXTURE_NEGATIVE =
  'halftone, dithering, noise, grain, printed texture, paper texture, jpeg artifacts, oversharpened'

/** Qwen 2.1 settings presets (legacy `QWEN21_PRESETS`). */
export const QWEN21_PRESETS: { id: string; label: string; title: string; useLora: boolean; steps: number; cfg: number; negative?: string }[] = [
  { id: 'turbo6', label: 'Turbo 6', title: 'Turbo LoRA, 6 steps, no CFG', useLora: true, steps: 6, cfg: 1.0 },
  { id: 'turbo9', label: 'Turbo 9 hybrid', title: '7 turbo + 2 base steps: finer detail, better small text', useLora: true, steps: 9, cfg: 1.0 },
  { id: 'base40', label: 'Base 40', title: 'Base model, 40 steps, no CFG (default)', useLora: false, steps: 40, cfg: 1.0 },
  // CFG 3 + this negative removes most of the model's halftone / paper-print texture
  { id: 'base40cfg', label: 'Base 40 + CFG 3 (clean)', title: 'Base model, 40 steps, true CFG 3 + anti-texture negative: cleanest output (~1.7x slower)', useLora: false, steps: 40, cfg: 3.0, negative: QWEN21_TEXTURE_NEGATIVE },
]

/** Curated prompts; the transparent ones flip the transparent toggle. */
export const PROMPT_PRESETS: { label: string; prompt: string; transparent?: boolean; models?: string[] }[] = [
  {
    label: 'Typography poster',
    prompt: 'A bold typographic poster with the headline "MIDNIGHT JAZZ" in large art-deco lettering, subtitle "Live every Friday at The Blue Room" in a clean sans-serif below, gold and deep navy palette, geometric ornaments, high contrast print design',
  },
  {
    label: 'Neon sign',
    prompt: 'A glowing neon sign that reads "OPEN ALL NIGHT" mounted on a brick wall, rainy night, pink and cyan reflections on wet pavement, cinematic photo, shallow depth of field',
  },
  {
    label: 'Sticker',
    transparent: true,
    prompt: 'A cute cartoon fox mascot sticker, full body, waving, thick clean outline, flat vibrant colors, centered',
  },
  {
    label: 'Game asset',
    transparent: true,
    prompt: 'A single ornate fantasy treasure chest game asset, three-quarter view, hand-painted style, soft rim light, centered, isolated object',
  },
  {
    label: 'Product shot',
    prompt: 'Studio product photograph of a matte black ceramic coffee mug on a seamless warm grey backdrop, soft box lighting from the left, subtle reflection, crisp detail, commercial catalog style',
  },
  {
    label: 'Cinematic portrait',
    prompt: 'Cinematic close-up portrait of a woman in her thirties by a rain-streaked window at dusk, warm tungsten key light and cool blue fill, natural skin texture, 85mm lens, shallow depth of field, film grain',
  },
  {
    label: 'Infographic',
    prompt: 'A clean infographic titled "How Coffee Is Made" with five numbered steps: 1 Harvest, 2 Process, 3 Roast, 4 Grind, 5 Brew, each with a simple flat icon and a one-line caption, pastel colors, white background',
  },
  {
    label: 'Menu board',
    prompt: "A rustic chalkboard cafe menu titled \"Today's Specials\" listing: Avocado Toast $9, Shakshuka $12, Blueberry Pancakes $10, Flat White $4.50, hand-lettered chalk style, small doodles of coffee cups",
  },
  {
    label: 'Isometric room',
    prompt: 'Isometric cutaway view of a cozy bookshop interior, warm lamps, tall shelves, a cat asleep on the counter, soft shadows, clean vector-like shading, muted teal and amber palette',
  },
  {
    label: 'Character sheet',
    prompt: 'Character reference sheet of a cyberpunk street medic: front, side and three-quarter views on a plain background, labelled proportions, clean line art with flat color, consistent design',
  },
]

/** Opt-in quality negative (legacy started empty). No "text"/"watermark": those
 *  sabotage typography prompts — Qwen 2.1's main strength — once CFG is on. */
export const DEFAULT_NEGATIVE =
  'ugly, deformed, disfigured, low quality, blurry, bad anatomy, extra limbs, jpeg artifacts'

/** Delay between batch generations (legacy "Batch Debounce" setting), ms. */
export const DEBOUNCE_OPTIONS = [0, 500, 1000, 2000, 3000, 5000, 10000]
