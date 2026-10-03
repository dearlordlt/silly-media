/**
 * Hunyuan3D page — generate a textured GLB mesh from a text prompt (via a
 * generated reference image) or directly from an uploaded image, then inspect
 * it in an in-page <model-viewer> and browse/load recent server-side models.
 *
 * Generation runs on the app-wide GPU queue: the page only enqueues jobs and
 * renders them (live phase label polled from /models, activity log, newest
 * result in the viewer), so leaving and returning keeps the work visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadModelViewer, renderGlbPoster } from '../../components/ModelViewer'
import { PresetPicker } from './PresetPicker'
import { DEFAULT_TIER, DEFAULT_USE_CASE, QUALITY_TIERS, USE_CASES, resolvePreset, styledPrompt } from './presets'
import type { Subject } from './presets'
import { Boxes, Download, Eraser, ImagePlus, Loader2, RefreshCw, Sparkles, Upload } from 'lucide-react'
import type { Model3DRequest, Model3DResult } from '../../lib/types'
import type { SillyClient } from '../../lib/api'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useModels } from '../../lib/query'
import { downloadItem, library, useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { downloadUrl, formatBytes, stripDataUrl } from '../../lib/media'
import { kv } from '../../lib/kv'
import { jobs, throwIfCancelled, useJobCounts, usePageJobs } from '../../lib/jobs'
import type { Job, JobContext } from '../../lib/jobs'
import { useCommands, usePrimaryAction } from '../../lib/commands'
import { ImageDrop } from '../../components/ImageDrop'
import { EnhancePrompt } from '../../components/EnhancePrompt'
import { useHandoffImage } from '../../lib/handoff'
import { JobStrip, ModelBadge } from '../../components/Progress'
import {
  Button, EmptyState, IconButton, Input, Label, Panel, Section, Segmented, Select, Slider, Switch, Textarea,
} from '../../components/ui/primitives'

type Mode = 'text' | 'image'

const PRESET_KEY = 'silly-3d-preset'

function loadPresetChoice(): { useCase: string; tier: number } {
  const raw = kv.getJson<unknown>(PRESET_KEY, null)
  if (raw && typeof raw === 'object' && 'useCase' in raw && 'tier' in raw
    && typeof raw.useCase === 'string' && USE_CASES.some((u) => u.id === raw.useCase)
    && typeof raw.tier === 'number' && raw.tier >= 0 && raw.tier < QUALITY_TIERS.length) {
    return { useCase: raw.useCase, tier: raw.tier }
  }
  return { useCase: DEFAULT_USE_CASE, tier: DEFAULT_TIER }
}

type ViewerBg = 'dark' | 'grey' | 'light'

const RECENT_LIMIT = 24
const VIEWER_BG: Record<ViewerBg, string> = { dark: '#0d1117', grey: '#3a3f4b', light: '#e9e9ee' }

// model-viewer loading + JSX typing live in components/ModelViewer.
/* ------------------------------------------------------------------- jobs */

/** Library fields fixed at enqueue time (the job adds modelId / refUrl). */
interface SaveSpec {
  name?: string
  prompt?: string
  model?: string
  seed: number
  meta: Record<string, unknown>
}

/** Self-contained 3D job: generate, resolve the server id, render a poster, store in the library. */
async function runModel3d(ctx: JobContext, client: SillyClient, req: Model3DRequest, save: SaveSpec): Promise<void> {
  try {
    ctx.report({ message: 'Starting…' })
    // Which model is resident tells us the phase of the synchronous request.
    ctx.poll(async () => {
      const m = await client.models({ signal: ctx.signal })
      if (m.model3d.loaded.length) return { message: 'Building 3D mesh + texture…' }
      return { message: m.image.loaded.length ? 'Generating reference image…' : 'Working…' }
    }, 2000)
    const res = await client.model3d(req, ctx.signal)
    // X-Model-Id / X-Ref-Url are not CORS-exposed, so the newest server entry is authoritative.
    let modelId = res.id
    let refPath = res.refUrl
    try {
      const latest = (await client.model3dList(1, { signal: ctx.signal })).models[0]
      if (latest) {
        modelId = latest.id
        refPath = latest.ref_url ?? refPath
      }
    } catch {
      /* keep header values */
    }
    throwIfCancelled(ctx.signal)
    ctx.report({ message: 'Rendering preview…' })
    const objectUrl = URL.createObjectURL(res.blob)
    const poster = await renderGlbPoster(objectUrl).finally(() => URL.revokeObjectURL(objectUrl))
    throwIfCancelled(ctx.signal)
    const item = await library.add({
      kind: 'model3d',
      source: '3d',
      blob: res.blob,
      name: save.name ?? `Model ${modelId}`,
      prompt: save.prompt,
      model: save.model,
      seed: save.seed,
      meta: { ...save.meta, modelId, refUrl: refPath },
      thumb: poster ?? undefined,
    })
    ctx.addItem(item.id)
    toast.success('Model generated', formatBytes(res.blob.size))
  } catch (e) {
    if (!ctx.signal.aborted) toast.error('3D generation failed', errorMessage(e))
    throw e
  }
}

/* ------------------------------------------------------------------- page */

interface ShownModel {
  /** Backend model id. */
  id: string
  /** URL the viewer loads (library file or backend download). */
  src: string
  refUrl: string | null
  size: number
  texture?: boolean
  faces?: number
  /** Library copy, when the model came from a job. */
  item?: MediaItem
  /** When it was put in the viewer (a newer finished job replaces it). */
  at: number
}

function shownFromItem(item: MediaItem, client: SillyClient, at: number): ShownModel {
  const meta = item.meta ?? {}
  return {
    id: typeof meta.modelId === 'string' ? meta.modelId : item.id,
    src: item.url,
    refUrl: client.media(typeof meta.refUrl === 'string' ? meta.refUrl : null),
    size: item.size,
    texture: typeof meta.texture === 'boolean' ? meta.texture : undefined,
    faces: typeof meta.target_faces === 'number' ? meta.target_faces : undefined,
    item,
    at,
  }
}

interface LogEntry {
  key: string
  at: number
  msg: string
  kind?: 'ok' | 'err' | 'warn'
}

const LOG_TONE: Record<NonNullable<LogEntry['kind']>, string> = {
  ok: 'text-good',
  err: 'text-bad',
  warn: 'text-warn',
}

/** Activity lines for a job's lifecycle (derived, so they survive navigation). */
function jobLog(job: Job, items: MediaItem[]): LogEntry[] {
  const out: LogEntry[] = [{ key: `${job.id}:q`, at: job.createdAt, msg: `Queued ${job.label}${job.detail ? ` (${job.detail})` : ''}.` }]
  if (job.startedAt) out.push({ key: `${job.id}:s`, at: job.startedAt, msg: 'Submitting request… (shape + texture usually 1–3 min)' })
  if (!job.finishedAt) return out
  const secs = job.startedAt ? Math.round((job.finishedAt - job.startedAt) / 1000) : 0
  if (job.state === 'done') {
    const item = items.find((i) => i.id === job.itemIds[0])
    const modelId = typeof item?.meta?.modelId === 'string' ? item.meta.modelId : null
    out.push({
      key: `${job.id}:f`, at: job.finishedAt, kind: 'ok',
      msg: `✓ Done in ${secs}s${item ? ` — received ${formatBytes(item.size)} GLB${modelId ? ` (${modelId})` : ''}` : ''}.`,
    })
  } else if (job.state === 'failed') {
    out.push({ key: `${job.id}:f`, at: job.finishedAt, kind: 'err', msg: `Request failed: ${job.error ?? 'unknown error'}` })
  } else if (job.state === 'cancelled') {
    out.push({ key: `${job.id}:f`, at: job.finishedAt, kind: 'warn', msg: `Cancelled ${job.label}.` })
  }
  return out
}

export function ThreeDPage() {
  const client = useClient()
  const models = useModels()
  const imageModels = models.data?.image.available ?? []

  const [choice, setChoice] = useState(loadPresetChoice)
  const [initial] = useState(() => resolvePreset(choice.useCase, choice.tier, []))
  const [mode, setMode] = useState<Mode>('text')
  const [prompt, setPrompt] = useState('')
  const [subject, setSubject] = useState<Subject>(initial.subject)
  const [imageModel, setImageModel] = useState<string>(initial.imageModel)
  const [matchStyle, setMatchStyle] = useState(true)
  const [image, setImage] = useState<string | null>(null)
  const [seed, setSeed] = useState(-1)

  // "Make 3D" from another page: switch to Image → 3D with that image.
  useHandoffImage('3d', (dataUrl) => {
    setImage(dataUrl)
    setMode('image')
  })

  const [octreeResolution, setOctreeResolution] = useState(initial.octree)
  const [steps, setSteps] = useState(initial.steps)
  const [guidance, setGuidance] = useState(initial.guidance)
  const [texture, setTexture] = useState(initial.texture)
  const [targetFaces, setTargetFaces] = useState(initial.faces)
  const [custom, setCustom] = useState(false)

  const pageJobs = usePageJobs('3d')
  const counts = useJobCounts()
  const modelItems = useLibrary('model3d')
  const active = useMemo(() => pageJobs.filter((j) => j.state === 'queued' || j.state === 'running').reverse(), [pageJobs])
  const doneCount = pageJobs.filter((j) => j.state === 'done').length

  const [picked, setPicked] = useState<ShownModel | null>(null)
  const [recent, setRecent] = useState<Model3DResult[]>([])
  const [recentLoading, setRecentLoading] = useState(false)

  const [autoRotate, setAutoRotate] = useState(true)
  const [viewerBg, setViewerBg] = useState<ViewerBg>('dark')
  const [exposure, setExposure] = useState(1)
  const [viewerState, setViewerState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const [backend, setBackend] = useState<{ id: string; name: string; loaded: boolean }[]>([])

  const [logs, setLogs] = useState<LogEntry[]>([])
  const [clearedAt, setClearedAt] = useState(0)
  const [logEl, setLogEl] = useState<HTMLDivElement | null>(null)
  const log = useCallback((msg: string, kind?: LogEntry['kind']) => {
    const at = Date.now()
    setLogs((prev) => [...prev.slice(-199), { key: `l${at}:${prev.length}`, at, msg, kind }])
  }, [])

  const activity = useMemo(() => [...logs, ...pageJobs.flatMap((j) => jobLog(j, modelItems))]
    .filter((l) => l.at > clearedAt)
    .sort((a, b) => a.at - b.at)
    .slice(-200), [logs, pageJobs, modelItems, clearedAt])

  useEffect(() => {
    if (logEl) logEl.scrollTop = logEl.scrollHeight
  }, [activity, logEl])

  /* startup: model-viewer element, backend list, health check */
  useEffect(() => {
    let cancelled = false
    void client
      .model3dModels()
      .then((r) => { if (!cancelled) setBackend(r.models) })
      .catch(() => { /* backend info is advisory */ })
    void client
      .health()
      .then((h) => {
        if (!cancelled) log(`Service healthy. 3D backends: ${h.available_model3d_models.join(', ') || 'none'}`, 'ok')
      })
      .catch(() => { if (!cancelled) log(`Cannot reach silly-media at ${client.base}`, 'err') })
    void loadModelViewer().then((ok) => {
      if (cancelled) return
      setViewerState(ok ? 'ready' : 'failed')
      if (ok) log('3D preview ready.', 'ok')
      else log('3D preview component blocked/unloaded. Downloads still work.', 'warn')
    })
    return () => { cancelled = true }
  }, [client, log])

  const loadRecent = useCallback(async () => {
    setRecentLoading(true)
    try {
      const r = await client.model3dList(RECENT_LIMIT)
      setRecent(r.models)
    } catch (e) {
      toast.error(errorMessage(e))
      log('Could not reach service for recent list.', 'warn')
    } finally {
      setRecentLoading(false)
    }
  }, [client, log])

  // Initial load, and again whenever a job of this page finishes.
  useEffect(() => { void loadRecent() }, [loadRecent, doneCount])

  /* Viewer: the newest finished job's model, unless something newer was picked by hand. */
  const latestDone = pageJobs.find((j) => j.state === 'done' && j.itemIds.length > 0)
  const latestItem = latestDone ? modelItems.find((i) => i.id === latestDone.itemIds[0]) : undefined
  const latestAt = latestDone?.finishedAt ?? 0
  const auto = useMemo(() => (latestItem ? shownFromItem(latestItem, client, latestAt) : null), [latestItem, client, latestAt])
  const shown = picked && (!auto || picked.at >= auto.at) ? picked : auto

  const downloadShown = (m: ShownModel) => {
    if (m.item) downloadItem(m.item, `model3d-${m.id}.glb`)
    else downloadUrl(m.src, `model3d-${m.id}.glb`)
  }

  const imageModelOptions = useMemo(() => {
    return imageModels.includes(imageModel) ? imageModels : [imageModel, ...imageModels]
  }, [imageModels, imageModel])

  const resolved = useMemo(() => resolvePreset(choice.useCase, choice.tier, imageModels), [choice, imageModels])

  const applyPreset = (next: { useCase: string; tier: number }) => {
    const p = resolvePreset(next.useCase, next.tier, imageModels)
    setTargetFaces(p.faces)
    setOctreeResolution(p.octree)
    setSteps(p.steps)
    setGuidance(p.guidance)
    setTexture(p.texture)
    setSubject(p.subject)
    setImageModel(p.imageModel)
    setChoice(next)
    setCustom(false)
    kv.setJson(PRESET_KEY, next)
    const uc = USE_CASES.find((u) => u.id === next.useCase)?.label ?? next.useCase
    log(`Preset ${uc} · ${QUALITY_TIERS[next.tier].label}: ${p.faces.toLocaleString()} faces, octree ${p.octree}, ${p.steps} steps, texture ${p.texture ? 'on' : 'off'}.`)
  }

  const canGenerate = mode === 'text' ? prompt.trim().length > 0 : !!image
  const ahead = counts.running + counts.queued
  const generateLabel = ahead ? `Queue 3D model (${ahead} ahead)` : 'Generate 3D model'

  const generate = () => {
    if (!canGenerate) return
    const body: Model3DRequest = {
      octree_resolution: octreeResolution,
      num_inference_steps: steps,
      guidance_scale: guidance,
      texture,
      target_faces: targetFaces,
      seed,
    }
    const text = prompt.trim()
    if (mode === 'text') {
      body.text = matchStyle ? styledPrompt(prompt, resolved.style) : text
      body.subject = subject
      body.image_model = imageModel
    } else if (image) {
      body.image = stripDataUrl(image)
    }
    const save: SaveSpec = {
      name: mode === 'text' ? text.slice(0, 60) : undefined,
      prompt: mode === 'text' ? text : undefined,
      model: mode === 'text' ? imageModel : undefined,
      seed,
      meta: {
        subject: mode === 'text' ? subject : undefined,
        octree_resolution: octreeResolution,
        num_inference_steps: steps,
        guidance_scale: guidance,
        texture,
        target_faces: targetFaces,
        mode,
        preset: custom ? 'custom' : `${choice.useCase}:${QUALITY_TIERS[choice.tier].id}`,
      },
    }
    jobs.enqueue({
      page: '3d',
      label: mode === 'text' ? `3D: ${text.slice(0, 40)}` : 'Image → 3D',
      detail: `${targetFaces.toLocaleString()} faces · ${texture ? 'textured' : 'no texture'}`,
      run: (ctx) => runModel3d(ctx, client, body, save),
    })
  }

  usePrimaryAction({ label: generateLabel, run: generate, disabled: !canGenerate })

  const openRecent = (m: Model3DResult) => {
    const src = client.media(m.url)
    if (!src) return
    setPicked({ id: m.id, src, refUrl: client.media(m.ref_url ?? null), size: m.size_bytes, at: Date.now() })
    log(`Loaded ${m.id} into the viewer. Drag to orbit.`, 'ok')
  }

  useCommands([
    { id: '3d.mode.text', label: 'Text → 3D', group: '3D', keywords: 'mode prompt', disabled: mode === 'text', run: () => setMode('text') },
    { id: '3d.mode.image', label: 'Image → 3D', group: '3D', keywords: 'mode upload', disabled: mode === 'image', run: () => setMode('image') },
    { id: '3d.seed.random', label: 'Randomize seed', group: '3D', run: () => setSeed(Math.floor(Math.random() * 2 ** 31)) },
    { id: '3d.download', label: 'Download shown GLB', group: '3D', disabled: !shown, run: () => { if (shown) downloadShown(shown) } },
    { id: '3d.refresh', label: 'Refresh recent 3D models', group: '3D', run: () => void loadRecent() },
    { id: '3d.cancel-queued', label: 'Cancel queued 3D jobs', group: '3D', disabled: !active.some((j) => j.state === 'queued'), run: () => jobs.cancelQueued({ page: '3d' }) },
  ])

  /** Mark the preset as "custom" once a knob is changed by hand. */
  const tweak = <T,>(set: (v: T) => void) => (v: T) => { set(v); setCustom(true) }

  return (
    <div className="flex h-full">
      {/* ------------------------------------------------------- controls */}
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Boxes size={16} className="text-accent" />
              <h2 className="text-sm font-semibold text-ink">Hunyuan 3D</h2>
            </div>
            {backend[0] && <ModelBadge model={backend[0].name ?? backend[0].id} loaded={backend[0].loaded} />}
          </div>

          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: 'text', label: 'Text → 3D' },
              { value: 'image', label: 'Image → 3D' },
            ]}
          />

          <Section title="Preset">
            <PresetPicker
              useCase={choice.useCase}
              tier={choice.tier}
              resolved={resolved}
              custom={custom}
              onUseCase={(id) => applyPreset({ ...choice, useCase: id })}
              onTier={(i) => applyPreset({ ...choice, tier: i })}
              onReapply={() => applyPreset(choice)}
            />
          </Section>

          {mode === 'text' ? (
            <Section title="Prompt">
              <div>
                <Label hint={
                  <span className="flex items-center gap-2">
                    <EnhancePrompt value={prompt} onChange={(v) => setPrompt(v.slice(0, 600))} kind="3d" />
                    {prompt.length}/600
                  </span>
                }>Description</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value.slice(0, 600))}
                  rows={4}
                  placeholder="low-poly RuneScape-style female, blonde ponytail, blue eyes"
                />
              </div>
              <div className="rounded-lg border border-line bg-bg px-2.5 py-2">
                <Switch checked={matchStyle} onChange={setMatchStyle} label="Match reference style to quality" />
                {matchStyle && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-ink-faint">
                    Appends: <span className="text-ink-dim">“{resolved.style}”</span> — a photoreal reference decimated to
                    a few thousand faces looks wrong; this steers the reference toward the target look.
                  </p>
                )}
              </div>
              <div>
                <Label>Subject (how the reference is framed)</Label>
                <Select value={subject} onChange={(e) => tweak(setSubject)(e.target.value as Subject)}>
                  <option value="character">Character / person</option>
                  <option value="object">Object / item (isolated, no person)</option>
                  <option value="building">Building / structure</option>
                  <option value="auto">Auto</option>
                </Select>
              </div>
              <div>
                <Label hint={imageModels.length ? `${imageModels.length} available` : 'loading…'}>
                  Reference image model
                </Label>
                <Select value={imageModel} onChange={(e) => tweak(setImageModel)(e.target.value)}>
                  {imageModelOptions.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </Select>
              </div>
            </Section>
          ) : (
            <Section title="Source image">
              <ImageDrop value={image} onChange={setImage} compact label="Drop an image or click to choose" />
              <p className="text-[11.5px] leading-relaxed text-ink-faint">
                A centered subject on a plain background reconstructs best.
              </p>
            </Section>
          )}

          <Section title="Sampling">
            <div>
              <Label hint={seed < 0 ? 'random' : String(seed)}>Seed</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  className="flex-1"
                />
                <IconButton
                  title="Randomize seed"
                  onClick={() => setSeed(Math.floor(Math.random() * 2 ** 31))}
                >
                  <Sparkles size={15} />
                </IconButton>
              </div>
            </div>
          </Section>

          <Section title="Mesh">
            <Slider
              label="Target faces (low-poly)"
              value={targetFaces}
              min={500}
              max={300000}
              step={500}
              onValueChange={tweak(setTargetFaces)}
              format={(v) => v.toLocaleString()}
            />
            <Slider
              label="Octree resolution (detail)"
              value={octreeResolution}
              min={64}
              max={512}
              step={64}
              onValueChange={tweak(setOctreeResolution)}
            />
            <Slider
              label="Inference steps"
              value={steps}
              min={1}
              max={100}
              onValueChange={tweak(setSteps)}
            />
            <Slider
              label="Guidance scale"
              value={guidance}
              min={0}
              max={15}
              step={0.5}
              onValueChange={tweak(setGuidance)}
              format={(v) => v.toFixed(1)}
            />
            <Switch checked={texture} onChange={tweak(setTexture)} label="Paint texture" />
          </Section>

          <Button
            variant="primary"
            size="lg"
            icon={<Sparkles size={15} />}
            disabled={!canGenerate}
            onClick={generate}
            className="w-full"
          >
            {generateLabel}
          </Button>
        </div>
      </div>

      {/* -------------------------------------------------------- results */}
      <div className="flex-1 scroll-area p-5">
        <div className="flex flex-col gap-5">
          {active.length > 0 && (
            <div className="flex flex-col gap-2">
              {active.map((j) => <JobStrip key={j.id} job={j} />)}
            </div>
          )}

          <Section
            title="Viewport"
            action={
              <div className="flex items-center gap-3">
                <Switch checked={autoRotate} onChange={setAutoRotate} label="Auto-rotate" />
                <Segmented
                  value={viewerBg}
                  onChange={setViewerBg}
                  options={[
                    { value: 'dark', label: 'Dark' },
                    { value: 'grey', label: 'Grey' },
                    { value: 'light', label: 'Light' },
                  ]}
                />
                {shown && (
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Download size={13} />}
                    onClick={() => downloadShown(shown)}
                  >
                    Download GLB
                  </Button>
                )}
              </div>
            }
          >
            {shown ? (
              <Panel className="overflow-hidden">
                <div className="relative h-[440px] w-full" style={{ backgroundColor: VIEWER_BG[viewerBg] }}>
                  {viewerState === 'failed' ? (
                    <div className="grid h-full place-items-center p-6 text-center text-[12.5px] text-ink-faint">
                      3D preview component didn't load (CDN blocked?).<br />Generation still works — use Download GLB.
                    </div>
                  ) : (
                    <model-viewer
                      src={shown.src}
                      alt="Generated 3D model"
                      camera-controls
                      {...(autoRotate ? { 'auto-rotate': true } : {})}
                      auto-rotate-delay={1500}
                      rotation-per-second="24deg"
                      shadow-intensity="1"
                      exposure={exposure}
                      environment-image="neutral"
                      touch-action="pan-y"
                      style={{ width: '100%', height: '100%', backgroundColor: 'transparent' }}
                    />
                  )}
                </div>
                {viewerState !== 'failed' && (
                  <div className="flex items-center gap-3 border-t border-line px-3 py-2">
                    <div className="w-56">
                      <Slider label="Exposure" value={exposure} min={0.2} max={2.5} step={0.1} onValueChange={setExposure} format={(v) => v.toFixed(1)} />
                    </div>
                    <span className="ml-auto text-[11px] text-ink-faint">Drag to orbit · scroll to zoom · right-drag to pan</span>
                  </div>
                )}
              </Panel>
            ) : (
              <EmptyState
                icon={active.length ? <Loader2 size={26} className="animate-spin" /> : <Boxes size={26} />}
                title={active.length ? 'Generating…' : 'No model yet'}
                detail={active.length
                  ? 'The mesh appears here when the job finishes — you can leave this page meanwhile.'
                  : 'Pick a preset, describe a subject or drop an image, then generate a mesh to inspect it here.'}
              />
            )}
          </Section>

          {shown && (
            <div className="grid grid-cols-2 gap-5">
              <Section title="Reference">
                {shown.refUrl ? (
                  <Panel className="overflow-hidden">
                    <img src={shown.refUrl} alt="" className="max-h-72 w-full object-contain" />
                  </Panel>
                ) : (
                  <p className="text-[12px] text-ink-faint">No reference image for this model.</p>
                )}
                <p className="text-[11px] text-ink-faint">What fed the 3D — the generated reference or your upload.</p>
              </Section>
              <Section title="Details">
                <Panel className="p-3">
                  <dl className="grid grid-cols-2 gap-y-2 text-[12.5px]">
                    <dt className="text-ink-faint">ID</dt>
                    <dd className="truncate font-mono text-ink-dim">{shown.id}</dd>
                    <dt className="text-ink-faint">Size</dt>
                    <dd className="truncate font-mono text-ink-dim">{formatBytes(shown.size)}</dd>
                    <dt className="text-ink-faint">Texture</dt>
                    <dd className="truncate font-mono text-ink-dim">{shown.texture == null ? '—' : shown.texture ? 'yes' : 'no'}</dd>
                    <dt className="text-ink-faint">Faces</dt>
                    <dd className="truncate font-mono text-ink-dim">{shown.faces ? shown.faces.toLocaleString() : '—'}</dd>
                  </dl>
                  <div className="mt-3 flex items-center gap-2">
                    <Button size="sm" variant="outline" icon={<Download size={13} />} onClick={() => downloadShown(shown)}>
                      model3d-{shown.id}.glb
                    </Button>
                  </div>
                </Panel>
              </Section>
            </div>
          )}

          <Section
            title="Activity"
            action={
              <IconButton title="Clear log" onClick={() => { setLogs([]); setClearedAt(Date.now()) }} disabled={activity.length === 0}>
                <Eraser size={14} />
              </IconButton>
            }
          >
            <div
              ref={setLogEl}
              className="scroll-area h-40 rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-faint"
            >
              {activity.length === 0 ? (
                <div>Ready. Pick a mode, enter a prompt, hit Generate.</div>
              ) : (
                activity.map((l) => (
                  <div key={l.key} className={`whitespace-pre-wrap ${l.kind ? LOG_TONE[l.kind] : ''}`}>
                    [{new Date(l.at).toLocaleTimeString()}] {l.msg}
                  </div>
                ))
              )}
            </div>
          </Section>

          <Section
            title={`Recent models${recent.length ? ` (${recent.length})` : ''}`}
            action={
              <IconButton title="Refresh" onClick={() => void loadRecent()} disabled={recentLoading}>
                {recentLoading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              </IconButton>
            }
          >
            {recent.length ? (
              <div className="grid grid-cols-4 gap-3">
                {recent.map((m) => {
                  const thumb = client.media(m.ref_url ?? null)
                  const isShown = shown?.id === m.id
                  return (
                    <Panel key={m.id} className={`group overflow-hidden ${isShown ? 'ring-1 ring-accent' : ''}`}>
                      <button
                        type="button"
                        title="Load into viewer"
                        onClick={() => openRecent(m)}
                        className="relative block aspect-square w-full bg-bg"
                      >
                        {thumb ? (
                          <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain" />
                        ) : (
                          <div className="grid h-full place-items-center text-ink-faint"><Boxes size={22} /></div>
                        )}
                      </button>
                      <div className="flex items-center justify-between gap-1 border-t border-line px-2 py-1 text-[11px] text-ink-faint">
                        <span className="min-w-0 truncate" title={m.id}>
                          {m.id}
                        </span>
                        <span className="shrink-0">{formatBytes(m.size_bytes)}</span>
                        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                          <IconButton className="h-6 w-6" title="Load into viewer" onClick={() => openRecent(m)}>
                            <Upload size={12} />
                          </IconButton>
                          <IconButton
                            className="h-6 w-6"
                            title="Download GLB"
                            onClick={() => {
                              const url = client.media(m.url)
                              if (url) downloadUrl(url, `model3d-${m.id}.glb`)
                            }}
                          >
                            <Download size={12} />
                          </IconButton>
                        </div>
                      </div>
                    </Panel>
                  )
                })}
              </div>
            ) : (
              <EmptyState
                icon={<ImagePlus size={22} />}
                title={recentLoading ? 'Loading…' : 'No models on the server'}
                detail="Generated models are persisted by the backend and listed here."
              />
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
