/**
 * Game-asset generation: pixel art (`/pixelart/generate`) and sprite/cutout
 * (`/sprite/generate`). Both pipelines render at high resolution and then
 * downscale, so small outputs stay crisp (pixel art uses nearest-neighbour,
 * sprites use LANCZOS).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dice5, Download, Layers, Sparkles, X } from 'lucide-react'
import type { AspectRatio, PixelArtRequest, SpriteRequest } from '../../lib/types'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useModels } from '../../lib/query'
import { itemFilename, library, useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { useApp } from '../../lib/store'
import { downloadBlob, imageSize } from '../../lib/media'
import { ProgressStrip, useProgressPoll } from '../../components/Progress'
import { ArtifactGrid } from '../../components/Artifact'
import { AspectPicker } from '../../components/AspectPicker'
import {
  Button, Chip, IconButton, Input, Label, Panel, Segmented, Section, Select, Slider, Switch, Textarea,
} from '../../components/ui/primitives'
import { ASSET_PRESETS, DEFAULT_PIXEL_NEGATIVE, PIXEL_SIZE_CHIPS, SPRITE_ASPECTS } from './pixelPresets'

type Mode = 'pixel' | 'sprite'

interface PixelState {
  prompt: string
  negative: string
  size: number
  steps: number
  seed: number
  removeBackground: boolean
}

interface SpriteState {
  prompt: string
  negative: string
  model: string
  aspect: AspectRatio
  baseSize: number
  outputSize: number
  removeBackground: boolean
  seed: number
}

const PIXEL_DEFAULTS: PixelState = {
  prompt: '',
  negative: DEFAULT_PIXEL_NEGATIVE,
  size: 32,
  steps: 9,
  seed: -1,
  removeBackground: true,
}

const SPRITE_DEFAULTS: SpriteState = {
  prompt: '',
  negative: '',
  model: 'z-image-turbo',
  aspect: '1:1',
  baseSize: 1024,
  outputSize: 256,
  removeBackground: true,
  seed: -1,
}

/** Matches the `meta` payload written by this page, for the Reuse action. */
type AssetMeta = { request: PixelArtRequest | SpriteRequest; mode: Mode }

function isAssetMeta(meta: unknown): meta is AssetMeta {
  if (typeof meta !== 'object' || meta === null) return false
  if (!('mode' in meta) || !('request' in meta)) return false
  return typeof meta.request === 'object' && meta.request !== null
}

export function AssetsPage() {
  const client = useClient()
  const { data: models } = useModels()
  const all = useLibrary('image')
  const items = useMemo(() => all.filter((i) => i.source === 'assets'), [all])

  const [mode, setMode] = useState<Mode>('pixel')
  const [pixel, setPixel] = useState<PixelState>(PIXEL_DEFAULTS)
  const [sprite, setSprite] = useState<SpriteState>(SPRITE_DEFAULTS)
  const [running, setRunning] = useState(false)
  const abort = useRef<AbortController | null>(null)

  const imageModels = useMemo(() => models?.image.available ?? [], [models])

  // Adopt the first registered image model once /models resolves.
  useEffect(() => {
    if (!imageModels.length) return
    setSprite((prev) => (imageModels.includes(prev.model) ? prev : { ...prev, model: imageModels[0] }))
  }, [imageModels])

  const progress = useProgressPoll(() => client.progress(), running)

  const setP = (patch: Partial<PixelState>) => setPixel((prev) => ({ ...prev, ...patch }))
  const setS = (patch: Partial<SpriteState>) => setSprite((prev) => ({ ...prev, ...patch }))

  const applyPreset = (prompt: string, seamless?: boolean) => {
    if (mode === 'pixel') setP(seamless ? { prompt, removeBackground: false } : { prompt })
    else setS(seamless ? { prompt, removeBackground: false } : { prompt })
  }

  const saveResult = async (blob: Blob, request: PixelArtRequest | SpriteRequest, label: string, model: string) => {
    const dims = await imageSize(blob)
    await library.add({
      kind: 'image',
      source: 'assets',
      blob,
      name: `${label} · ${request.prompt.slice(0, 40)}`,
      prompt: request.prompt,
      negativePrompt: 'negative_prompt' in request ? request.negative_prompt : undefined,
      model,
      seed: request.seed,
      width: dims.width,
      height: dims.height,
      meta: { request, mode } satisfies AssetMeta,
    })
  }

  const generatePixel = async () => {
    const prompt = pixel.prompt.trim()
    if (!prompt) { toast.error('Prompt required', 'Describe the asset you want to generate.'); return }
    const body: PixelArtRequest = {
      prompt,
      num_inference_steps: pixel.steps,
      size: pixel.size,
      remove_background: pixel.removeBackground,
    }
    // Always send it: omitting the key makes the backend apply its default negative.
    body.negative_prompt = pixel.negative.trim()
    if (pixel.seed >= 0) body.seed = pixel.seed

    setRunning(true)
    abort.current = new AbortController()
    try {
      const blob = await client.pixelart(body as unknown as Record<string, unknown>, abort.current.signal)
      await saveResult(blob, body, `pixel ${pixel.size}×${pixel.size}`, 'z-image-turbo')
      toast.success('Pixel art saved', `${pixel.size}×${pixel.size} added to the library.`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const generateSprite = async () => {
    const prompt = sprite.prompt.trim()
    if (!prompt) { toast.error('Prompt required', 'Describe the sprite you want to generate.'); return }
    const body: SpriteRequest = {
      model: sprite.model,
      prompt,
      aspect_ratio: sprite.aspect,
      base_size: sprite.baseSize,
      output_size: sprite.outputSize,
      remove_background: sprite.removeBackground,
    }
    if (sprite.negative.trim()) body.negative_prompt = sprite.negative.trim()
    if (sprite.seed >= 0) body.seed = sprite.seed
    // qwen-image-2.1 renders the alpha channel natively instead of via rembg.
    if (sprite.removeBackground && sprite.model === 'qwen-image-2.1') body.transparent = true

    setRunning(true)
    abort.current = new AbortController()
    try {
      const blob = await client.sprite(body, abort.current.signal)
      await saveResult(blob, body, `sprite ${sprite.outputSize}px`, sprite.model)
      toast.success('Sprite saved', `${sprite.outputSize}px cutout added to the library.`)
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast.error(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const reuse = (item: MediaItem) => {
    const meta = item.meta
    if (!isAssetMeta(meta)) return
    setMode(meta.mode)
    if (meta.mode === 'pixel') {
      const r = meta.request as PixelArtRequest
      setPixel({
        prompt: r.prompt,
        negative: r.negative_prompt ?? DEFAULT_PIXEL_NEGATIVE,
        size: r.size ?? 32,
        steps: r.num_inference_steps ?? 9,
        seed: r.seed ?? -1,
        removeBackground: r.remove_background ?? true,
      })
    } else {
      const r = meta.request as SpriteRequest
      setSprite({
        prompt: r.prompt,
        negative: r.negative_prompt ?? '',
        model: r.model,
        aspect: r.aspect_ratio ?? '1:1',
        baseSize: r.base_size ?? 1024,
        outputSize: r.output_size ?? 256,
        removeBackground: r.remove_background ?? true,
        seed: r.seed ?? -1,
      })
    }
  }

  const remove = (item: MediaItem) => {
    if (useApp.getState().confirmDeletes && !confirm('Delete this asset from the library?')) return
    void library.remove(item.id)
  }

  const canGenerate = mode === 'pixel' ? !!pixel.prompt.trim() : !!sprite.prompt.trim() && !!sprite.model

  return (
    <div className="flex h-full">
      {/* Controls */}
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-4">
          <Section title="Asset type">
            <Segmented<Mode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'pixel', label: 'Pixel Art' },
                { value: 'sprite', label: 'Sprite / Cutout' },
              ]}
              className="w-full"
            />
            <p className="text-[11.5px] leading-relaxed text-ink-faint">
              {mode === 'pixel'
                ? 'Generates at 1024px, then nearest-neighbour downscales to a crisp pixel grid.'
                : 'Prompt is used verbatim. Renders at full resolution, then LANCZOS-downscales the longest side.'}
            </p>
          </Section>

          <Section title="Prompt">
            <Textarea
              rows={4}
              value={mode === 'pixel' ? pixel.prompt : sprite.prompt}
              onChange={(e) => (mode === 'pixel' ? setP({ prompt: e.target.value }) : setS({ prompt: e.target.value }))}
              placeholder={mode === 'pixel' ? 'a red potion bottle, game item icon' : 'a knight in idle stance, full body'}
            />
            <Label hint="click to fill">Asset presets</Label>
            <div className="flex flex-wrap gap-1.5">
              {ASSET_PRESETS.map((p) => (
                <Chip
                  key={p.label}
                  title={p.prompt}
                  tone={p.seamless ? 'cyan' : 'accent'}
                  onClick={() => applyPreset(p.prompt, p.seamless)}
                >
                  {p.label}
                </Chip>
              ))}
            </div>
          </Section>

          {mode === 'pixel' ? (
            <Section title="Pixel art settings">
              <div>
                <Label hint={`${pixel.size}×${pixel.size}`}>Size</Label>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {PIXEL_SIZE_CHIPS.map((s) => (
                    <Chip key={s} active={pixel.size === s} onClick={() => setP({ size: s })}>{s}</Chip>
                  ))}
                </div>
                <Slider value={pixel.size} min={8} max={512} step={1} onValueChange={(v) => setP({ size: v })} format={(v) => `${v}px`} />
              </div>
              <div>
                <Label>Inference steps</Label>
                <Input type="number" min={1} max={100} value={pixel.steps} onChange={(e) => setP({ steps: Number(e.target.value) })} />
              </div>
              <div>
                <Label>Seed</Label>
                <div className="flex gap-2">
                  <Input type="number" value={pixel.seed} onChange={(e) => setP({ seed: Number(e.target.value) })} placeholder="-1 = random" />
                  <IconButton title="Random seed" onClick={() => setP({ seed: Math.floor(Math.random() * 2 ** 31) })}>
                    <Dice5 size={15} />
                  </IconButton>
                </div>
              </div>
              <Switch checked={pixel.removeBackground} onChange={(v) => setP({ removeBackground: v })} label="Remove background" />
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {pixel.removeBackground
                  ? 'On — character & item sprites: isometric shapes and clean outlines on transparency.'
                  : 'Off — seamless tiles (top-down): keeps the opaque surface so tiles butt together.'}
              </p>
              <div>
                <Label>Negative prompt</Label>
                <Textarea rows={2} value={pixel.negative} onChange={(e) => setP({ negative: e.target.value })} />
              </div>
            </Section>
          ) : (
            <Section title="Sprite settings">
              <div>
                <Label>Model</Label>
                <Select value={sprite.model} onChange={(e) => setS({ model: e.target.value })}>
                  {imageModels.length === 0 && <option value={sprite.model}>{sprite.model}</option>}
                  {imageModels.map((m) => <option key={m} value={m}>{m}</option>)}
                </Select>
              </div>
              <div>
                <Label>Aspect ratio</Label>
                <AspectPicker value={sprite.aspect} onChange={(v) => setS({ aspect: v })} baseSize={sprite.baseSize} options={SPRITE_ASPECTS} />
              </div>
              <Slider value={sprite.baseSize} min={256} max={2048} step={64} onValueChange={(v) => setS({ baseSize: v })} label="Base size" format={(v) => `${v}px`} />
              <Slider value={sprite.outputSize} min={8} max={1024} step={8} onValueChange={(v) => setS({ outputSize: v })} label="Output size (longest side)" format={(v) => `${v}px`} />
              <Switch checked={sprite.removeBackground} onChange={(v) => setS({ removeBackground: v })} label="Remove background" />
              {sprite.removeBackground && sprite.model === 'qwen-image-2.1' && (
                <p className="text-[11px] leading-relaxed text-accent-2">
                  qwen-image-2.1 renders transparency natively — sent as <code className="rounded bg-bg px-1">transparent: true</code>.
                </p>
              )}
              <div>
                <Label>Seed</Label>
                <div className="flex gap-2">
                  <Input type="number" value={sprite.seed} onChange={(e) => setS({ seed: Number(e.target.value) })} placeholder="-1 = random" />
                  <IconButton title="Random seed" onClick={() => setS({ seed: Math.floor(Math.random() * 2 ** 31) })}>
                    <Dice5 size={15} />
                  </IconButton>
                </div>
              </div>
              <div>
                <Label>Negative prompt</Label>
                <Textarea rows={2} value={sprite.negative} onChange={(e) => setS({ negative: e.target.value })} placeholder="(optional)" />
              </div>
            </Section>
          )}

          <div className="sticky bottom-0 -mx-5 border-t border-line bg-bg/95 px-5 py-4 backdrop-blur">
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                icon={running ? <X size={15} /> : <Sparkles size={15} />}
                onClick={() => {
                  if (running) { abort.current?.abort(); return }
                  void (mode === 'pixel' ? generatePixel() : generateSprite())
                }}
                disabled={running ? false : !canGenerate}
                className="flex-1"
              >
                {running ? 'Cancel' : 'Generate'}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 scroll-area p-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          <ProgressStrip state={progress} label={mode === 'pixel' ? 'Generating pixel art' : 'Generating sprite'} />

          <Section title={`Assets (${items.length})`}>
            <ArtifactGrid
              items={items}
              columns={5}
              onReuse={reuse}
              onDelete={remove}
              extraActions={(item) => (
                <IconButton title="Download" onClick={() => downloadBlob(item.blob, itemFilename(item))}><Download size={14} /></IconButton>
              )}
              empty={{ title: 'No assets yet', detail: 'Pick a preset or write a prompt, then generate pixel art or a cutout sprite. Results land in your local library.' }}
            />
          </Section>

          <Panel className="p-4">
            <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
              <Layers size={12} />
              Pixel art: 1024px → nearest-neighbour → {pixel.size}×{pixel.size} · Sprite: {sprite.aspect} @ {sprite.baseSize}px → LANCZOS {sprite.outputSize}px
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
