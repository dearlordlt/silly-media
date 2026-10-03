/**
 * Hunyuan3D page — generate a textured GLB mesh from a text prompt (via a
 * generated reference image) or directly from an uploaded image, then inspect
 * it in an in-page <model-viewer> and browse/load recent server-side models.
 *
 * Goal presets set the mesh knobs, a live phase label (polled from /models)
 * shows which stage the synchronous request is in, and an activity log keeps
 * the request history visible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { loadModelViewer } from '../../components/ModelViewer'
import { Boxes, Download, Eraser, ImagePlus, Loader2, RefreshCw, Sparkles, Upload } from 'lucide-react'
import type { Model3DRequest, Model3DResult } from '../../lib/types'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useModels } from '../../lib/query'
import { library } from '../../lib/library'
import { downloadUrl, formatBytes, stripDataUrl } from '../../lib/media'
import { ImageDrop } from '../../components/ImageDrop'
import { useHandoffImage } from '../../lib/handoff'
import { ModelBadge } from '../../components/Progress'
import {
  Button, Chip, EmptyState, IconButton, Input, Label, Panel, Section, Segmented, Select, Slider, Switch, Textarea,
} from '../../components/ui/primitives'

type Mode = 'text' | 'image'
type Subject = NonNullable<Model3DRequest['subject']>
type ViewerBg = 'dark' | 'grey' | 'light'

const RECENT_LIMIT = 24

/** Goal presets from the legacy ui-3d.html: map "what you're making" to good knobs. */
const PRESETS = {
  lowpoly: {
    label: '🧍 Low-poly character', faces: 6000, octree: 256, steps: 30, guidance: 5.5, texture: true,
    model: 'z-image-turbo', subject: 'character',
    desc: 'Stylized game character (RuneScape-ish). Few faces, flat-shaded look.',
  },
  blocky: {
    label: '🟫 Blocky / voxel', faces: 1500, octree: 128, steps: 20, guidance: 5.0, texture: true,
    model: 'z-image-turbo', subject: 'character',
    desc: 'Chunky Minecraft-ish style. Very low detail, fast.',
  },
  realistic: {
    label: '👤 Realistic figure', faces: 80000, octree: 384, steps: 50, guidance: 5.5, texture: true,
    model: 'z-image', subject: 'character',
    desc: 'High-detail person/creature from a full image. Heavier + slower.',
  },
  prop: {
    label: '⚔️ Prop / item', faces: 8000, octree: 256, steps: 30, guidance: 6.0, texture: true,
    model: 'z-image-turbo', subject: 'object',
    desc: 'A single object: sword, tool, gadget. Isolated, no character.',
  },
  building: {
    label: '🏛️ Building / structure', faces: 25000, octree: 384, steps: 40, guidance: 5.5, texture: true,
    model: 'z-image', subject: 'building',
    desc: 'House, tower, ruin. More faces for flat architectural detail.',
  },
  sculpt: {
    label: '🗿 Sculpt (no texture)', faces: 150000, octree: 512, steps: 50, guidance: 5.5, texture: false,
    model: 'z-image', subject: 'auto',
    desc: 'Clean high-res shape only — good for 3D print or re-texturing.',
  },
} satisfies Record<string, {
  label: string; faces: number; octree: number; steps: number; guidance: number; texture: boolean
  model: string; subject: Subject; desc: string
}>
type PresetKey = keyof typeof PRESETS
const PRESET_KEYS = Object.keys(PRESETS) as PresetKey[]
const DEFAULT_PRESET: PresetKey = 'lowpoly'

const VIEWER_BG: Record<ViewerBg, string> = { dark: '#0d1117', grey: '#3a3f4b', light: '#e9e9ee' }

// model-viewer loading + JSX typing live in components/ModelViewer.
/* ------------------------------------------------------------------- page */

interface ShownModel {
  id: string
  blob: Blob
  refUrl: string | null
  objectUrl: string
  /** Params used for this mesh; absent when loaded from the server list. */
  texture?: boolean
  faces?: number
}

interface LogEntry {
  id: number
  at: number
  msg: string
  kind?: 'ok' | 'err' | 'warn'
}

const LOG_TONE: Record<NonNullable<LogEntry['kind']>, string> = {
  ok: 'text-good',
  err: 'text-bad',
  warn: 'text-warn',
}

export function ThreeDPage() {
  const client = useClient()
  const models = useModels()
  const imageModels = models.data?.image.available ?? []

  const initial = PRESETS[DEFAULT_PRESET]
  const [mode, setMode] = useState<Mode>('text')
  const [prompt, setPrompt] = useState('')
  const [subject, setSubject] = useState<Subject>(initial.subject)
  const [imageModel, setImageModel] = useState<string>(initial.model)
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
  const [preset, setPreset] = useState<PresetKey | null>(DEFAULT_PRESET)

  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [shown, setShown] = useState<ShownModel | null>(null)
  const [recent, setRecent] = useState<Model3DResult[]>([])
  const [recentLoading, setRecentLoading] = useState(false)

  const [autoRotate, setAutoRotate] = useState(true)
  const [viewerBg, setViewerBg] = useState<ViewerBg>('dark')
  const [exposure, setExposure] = useState(1)
  const [viewerState, setViewerState] = useState<'loading' | 'ready' | 'failed'>('loading')

  const [backend, setBackend] = useState<{ id: string; name: string; loaded: boolean }[]>([])

  const [logs, setLogs] = useState<LogEntry[]>([])
  const logId = useRef(0)
  const logRef = useRef<HTMLDivElement | null>(null)
  const log = useCallback((msg: string, kind?: LogEntry['kind']) => {
    logId.current += 1
    const entry: LogEntry = { id: logId.current, at: Date.now(), msg, kind }
    setLogs((prev) => [...prev.slice(-199), entry])
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [logs])

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

  /* live phase while the synchronous request runs: which model is resident? */
  useEffect(() => {
    if (!busy) return
    const t0 = Date.now()
    let cancelled = false
    const tick = async () => {
      setElapsed(Math.round((Date.now() - t0) / 1000))
      try {
        const m = await client.models()
        if (cancelled) return
        if (m.model3d.loaded.length) setPhase('Building 3D mesh + texture…')
        else if (m.image.loaded.length) setPhase('Generating reference image…')
        else setPhase('Working…')
      } catch {
        /* advisory only */
      }
    }
    setPhase('Starting…')
    void tick()
    const id = window.setInterval(() => void tick(), 2000)
    const sec = window.setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => { cancelled = true; window.clearInterval(id); window.clearInterval(sec); setPhase(null) }
  }, [busy, client])

  const showModel = useCallback((id: string, blob: Blob, refUrl: string | null, meta?: { texture?: boolean; faces?: number }) => {
    setShown((prev) => {
      if (prev) URL.revokeObjectURL(prev.objectUrl)
      return { id, blob, refUrl, objectUrl: URL.createObjectURL(blob), ...meta }
    })
  }, [])

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

  useEffect(() => { void loadRecent() }, [loadRecent])

  const imageModelOptions = useMemo(() => {
    return imageModels.includes(imageModel) ? imageModels : [imageModel, ...imageModels]
  }, [imageModels, imageModel])

  const applyPreset = (key: PresetKey) => {
    const p = PRESETS[key]
    setTargetFaces(p.faces)
    setOctreeResolution(p.octree)
    setSteps(p.steps)
    setGuidance(p.guidance)
    setTexture(p.texture)
    setSubject(p.subject)
    if (imageModels.length === 0 || imageModels.includes(p.model)) setImageModel(p.model)
    setPreset(key)
    log(`Preset "${p.label}": ${p.faces} faces, octree ${p.octree}, ${p.steps} steps, texture ${p.texture ? 'on' : 'off'}.`)
  }

  const canGenerate = mode === 'text' ? prompt.trim().length > 0 : !!image

  const generate = async () => {
    if (!canGenerate || busy) return
    setBusy(true)
    const t0 = Date.now()
    log(`Submitting ${mode}→3D request… (shape + texture usually 1–3 min)`)
    try {
      const body: Model3DRequest = {
        octree_resolution: octreeResolution,
        num_inference_steps: steps,
        guidance_scale: guidance,
        texture,
        target_faces: targetFaces,
        seed,
      }
      if (mode === 'text') {
        body.text = prompt.trim()
        body.subject = subject
        body.image_model = imageModel
      } else if (image) {
        body.image = stripDataUrl(image)
      }

      const res = await client.model3d(body)
      // X-Model-Id / X-Ref-Url are not CORS-exposed, so the newest server entry is authoritative.
      let modelId = res.id
      let refPath = res.refUrl
      try {
        const latest = (await client.model3dList(1)).models[0]
        if (latest) {
          modelId = latest.id
          refPath = latest.ref_url ?? refPath
        }
      } catch {
        /* keep header values */
      }
      showModel(modelId, res.blob, client.media(refPath), { texture, faces: targetFaces })
      log(`✓ Done in ${Math.round((Date.now() - t0) / 1000)}s — received ${formatBytes(res.blob.size)} GLB (${modelId}).`, 'ok')

      const name = mode === 'text' ? prompt.trim().slice(0, 60) : `Model ${modelId}`
      await library.add({
        kind: 'model3d',
        source: '3d',
        blob: res.blob,
        name,
        prompt: mode === 'text' ? prompt.trim() : undefined,
        model: mode === 'text' ? imageModel : undefined,
        seed,
        meta: {
          subject: mode === 'text' ? subject : undefined,
          modelId,
          refUrl: refPath,
          octree_resolution: octreeResolution,
          num_inference_steps: steps,
          guidance_scale: guidance,
          texture,
          target_faces: targetFaces,
          mode,
          preset: preset ?? undefined,
        },
      })
      toast.success('Model generated', formatBytes(res.blob.size))
      void loadRecent()
    } catch (e) {
      const msg = errorMessage(e)
      log(`Request failed: ${msg}`, 'err')
      toast.error(msg)
    } finally {
      setBusy(false)
    }
  }

  const openRecent = async (m: Model3DResult) => {
    const url = client.media(m.url)
    if (!url) return
    log(`Loading recent ${m.id}…`)
    try {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`Download failed (${r.status} ${r.statusText})`)
      const blob = await r.blob()
      showModel(m.id, blob, client.media(m.ref_url ?? null))
      log(`Loaded ${m.id} into the viewer. Drag to orbit.`, 'ok')
    } catch (e) {
      const msg = errorMessage(e)
      log(`Could not load ${m.id}: ${msg}`, 'err')
      toast.error(msg)
    }
  }

  /** Mark the preset as "custom" once a knob is changed by hand. */
  const tweak = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPreset(null) }

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
            <div className="flex flex-wrap gap-1.5">
              {PRESET_KEYS.map((key) => (
                <Chip key={key} active={preset === key} title={PRESETS[key].desc} onClick={() => applyPreset(key)}>
                  {PRESETS[key].label}
                </Chip>
              ))}
            </div>
            <p className="min-h-[16px] text-[11.5px] leading-relaxed text-ink-faint">
              {preset ? PRESETS[preset].desc : 'Custom settings.'}
            </p>
          </Section>

          {mode === 'text' ? (
            <Section title="Prompt">
              <div>
                <Label hint={`${prompt.length}/600`}>Description</Label>
                <Textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value.slice(0, 600))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void generate() }
                  }}
                  rows={4}
                  placeholder="low-poly RuneScape-style female, blonde ponytail, blue eyes"
                />
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
            loading={busy}
            disabled={!canGenerate}
            onClick={() => void generate()}
            className="w-full"
          >
            {busy ? 'Generating…' : 'Generate 3D model'}
          </Button>

          {busy && (
            <div className="flex flex-col gap-2">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-line">
                <div className="h-full w-1/3 animate-pulse rounded-full bg-gradient-to-r from-accent to-accent-2" />
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-ink">{phase ?? 'Working…'}</span>
                <span className="font-mono tabular-nums text-ink-faint">{elapsed}s</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------- results */}
      <div className="flex-1 scroll-area p-5">
        <div className="flex flex-col gap-5">
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
                    onClick={() => downloadUrl(shown.objectUrl, `model3d-${shown.id}.glb`)}
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
                      src={shown.objectUrl}
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
                icon={<Boxes size={26} />}
                title="No model yet"
                detail="Pick a preset, describe a subject or drop an image, then generate a mesh to inspect it here."
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
                    <dd className="truncate font-mono text-ink-dim">{formatBytes(shown.blob.size)}</dd>
                    <dt className="text-ink-faint">Texture</dt>
                    <dd className="truncate font-mono text-ink-dim">{shown.texture == null ? '—' : shown.texture ? 'yes' : 'no'}</dd>
                    <dt className="text-ink-faint">Faces</dt>
                    <dd className="truncate font-mono text-ink-dim">{shown.faces ? shown.faces.toLocaleString() : '—'}</dd>
                  </dl>
                  <div className="mt-3 flex items-center gap-2">
                    <a
                      href={shown.objectUrl}
                      download={`model3d-${shown.id}.glb`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-ink-dim hover:border-line-strong hover:text-ink"
                    >
                      <Download size={13} /> model3d-{shown.id}.glb
                    </a>
                  </div>
                </Panel>
              </Section>
            </div>
          )}

          <Section
            title="Activity"
            action={
              <IconButton title="Clear log" onClick={() => setLogs([])} disabled={logs.length === 0}>
                <Eraser size={14} />
              </IconButton>
            }
          >
            <div
              ref={logRef}
              className="scroll-area h-40 rounded-[10px] border border-line bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-ink-faint"
            >
              {logs.length === 0 ? (
                <div>Ready. Pick a mode, enter a prompt, hit Generate.</div>
              ) : (
                logs.map((l) => (
                  <div key={l.id} className={`whitespace-pre-wrap ${l.kind ? LOG_TONE[l.kind] : ''}`}>
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
                        onClick={() => void openRecent(m)}
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
                          <IconButton className="h-6 w-6" title="Load into viewer" onClick={() => void openRecent(m)}>
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
