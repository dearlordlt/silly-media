import { useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft, ChevronRight, Clock, Copy, Dices, Download, Film, ImagePlus, Play, RefreshCw, RotateCcw, Sparkles, Trash2, Type,
} from 'lucide-react'
import { errorMessage, toast, useClient, useJobPoller } from '../../lib/hooks'
import { library } from '../../lib/library'
import { downloadUrl, stripDataUrl } from '../../lib/media'
import { useApp } from '../../lib/store'
import type { JobStatus, VideoGenerateRequest, VideoHistoryEntry } from '../../lib/types'
import {
  Button, EmptyState, IconButton, Input, Label, Panel, ProgressBar, Segmented, Section, Select, Slider, Switch, Textarea,
} from '../../components/ui/primitives'
import { ImageDrop } from '../../components/ImageDrop'
import { useHandoffImage } from '../../lib/handoff'

type Mode = 't2v' | 'i2v'
type Resolution = '480p' | '720p'
type VidAspect = '16:9' | '9:16' | '1:1'

interface VideoModelInfo {
  id: string
  name: string
  loaded: boolean
  supports_t2v: boolean
  supports_i2v: boolean
  estimated_vram_gb: number
}

interface Settings {
  mode: Mode
  model: string
  prompt: string
  resolution: Resolution
  /** Last explicit T2V aspect; I2V takes the aspect from the source image. */
  aspect: VidAspect
  lengthSec: number
  fps: number
  guidance: string
  steps: string
  seed: string
  audio: boolean
}

/** What the main player is showing: a fresh result or a history entry. */
interface CurrentVideo {
  jobId: string
  url: string
  thumbnailUrl: string | null
  prompt: string
  model: string
  resolution: string
  aspect: string
  frames: number
  fps: number | null
  durationSeconds: number
  elapsed: number | null
}

interface GenMeta {
  model: string
  prompt: string
  resolution: Resolution
  aspect: string
  frames: number
  fps: number
  seed: number
}

const RESOLUTIONS: { value: Resolution; label: string }[] = [
  { value: '480p', label: '480p · fast' },
  { value: '720p', label: '720p · higher quality' },
]
const ASPECTS: { value: VidAspect; label: string }[] = [
  { value: '16:9', label: '16:9 · landscape' },
  { value: '9:16', label: '9:16 · portrait' },
  { value: '1:1', label: '1:1 · square' },
]
const PAGE_SIZE = 8
const SETTINGS_KEY = 'silly-video-settings'

const DEFAULTS: Settings = {
  mode: 't2v',
  model: '',
  prompt: '',
  resolution: '480p',
  aspect: '16:9',
  lengthSec: 5,
  fps: 24,
  guidance: '1.0',
  steps: '6',
  seed: '-1',
  audio: true,
}

function loadSettings(): Settings {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (typeof raw !== 'object' || raw === null) return DEFAULTS
    const v: Record<string, unknown> = { ...raw }
    const out = { ...DEFAULTS }
    if (v.mode === 't2v' || v.mode === 'i2v') out.mode = v.mode
    if (typeof v.model === 'string') out.model = v.model
    if (typeof v.prompt === 'string') out.prompt = v.prompt
    if (v.resolution === '480p' || v.resolution === '720p') out.resolution = v.resolution
    if (v.aspect === '16:9' || v.aspect === '9:16' || v.aspect === '1:1') out.aspect = v.aspect
    if (typeof v.lengthSec === 'number') out.lengthSec = Math.max(1, Math.min(10, v.lengthSec))
    if (typeof v.fps === 'number') out.fps = Math.max(12, Math.min(30, v.fps))
    if (typeof v.guidance === 'string') out.guidance = v.guidance
    if (typeof v.steps === 'string') out.steps = v.steps
    if (typeof v.seed === 'string') out.seed = v.seed
    if (typeof v.audio === 'boolean') out.audio = v.audio
    return out
  } catch {
    return DEFAULTS
  }
}

/** Same 8k+1 snapping the backend applies (ltx-2.5), so the shown frame count is exact. */
function framesFor(seconds: number, fps: number): number {
  const n = Math.round(seconds * fps)
  return Math.min(241, Math.max(9, Math.floor((n - 1) / 8) * 8 + 1))
}

/** m:ss clock for elapsed times. */
function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function VideoPage() {
  const client = useClient()
  const confirmDeletes = useApp((st) => st.confirmDeletes)

  const [s, setS] = useState<Settings>(loadSettings)
  const [image, setImage] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [estimated, setEstimated] = useState<number | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [current, setCurrent] = useState<CurrentVideo | null>(null)
  const [page, setPage] = useState(1)
  const [hovered, setHovered] = useState<string | null>(null)

  const metaRef = useRef<GenMeta | null>(null)
  const persistedRef = useRef<string | null>(null)

  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }))

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  }, [s])

  // Hand-off from another page ("Animate" on an image) preloads the I2V source.
  useHandoffImage('video', (data) => {
    setImage(data)
    setS((prev) => ({ ...prev, mode: 'i2v' }))
  })

  const modelsQ = useQuery({
    queryKey: ['video-models', client.base],
    queryFn: () => client.videoModels(),
    retry: 1,
    staleTime: 5000,
  })
  const models = useMemo<VideoModelInfo[]>(() => modelsQ.data?.models ?? [], [modelsQ.data])
  const compatible = useMemo(
    () => models.filter((m) => (s.mode === 't2v' ? m.supports_t2v : m.supports_i2v)),
    [models, s.mode],
  )
  const selected = useMemo(() => models.find((m) => m.id === s.model) ?? null, [models, s.model])

  // Keep the selected model compatible with the active mode.
  useEffect(() => {
    if (!compatible.length) return
    if (!compatible.some((m) => m.id === s.model)) setS((prev) => ({ ...prev, model: compatible[0].id }))
  }, [compatible, s.model])

  // `client.videoStatus` already returns the full status payload
  // (video_url / thumbnail_url / progress), which the poller surfaces as `data`.
  const job = useJobPoller<JobStatus>(jobId, async (id) => {
    const st = await client.videoStatus(id)
    return { ...st, data: st }
  })

  useEffect(() => {
    if (job.status === 'failed') toast.error('Video generation failed', job.error ?? undefined)
  }, [job.status, job.error])

  // Server-side pagination; `/video/history` accepts limit + offset.
  const historyQ = useQuery({
    queryKey: ['video-history', client.base, page],
    queryFn: () => client.videoHistory(PAGE_SIZE, (page - 1) * PAGE_SIZE),
    retry: 1,
  })
  const videos = historyQ.data?.videos ?? []
  const total = historyQ.data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // A delete can empty the last page — step back instead of showing nothing.
  useEffect(() => {
    if (historyQ.data && page > totalPages) setPage(totalPages)
  }, [historyQ.data, page, totalPages])

  // On completion: show the clip in the player and persist the MP4 to the library.
  useEffect(() => {
    if (job.status !== 'completed' || !job.data || !jobId) return
    const data = job.data
    // Only accept the result that belongs to the job we are watching.
    if (data.job_id && data.job_id !== jobId) return
    if (!data.video_url) return
    if (persistedRef.current === jobId) return
    persistedRef.current = jobId

    const url = client.media(data.video_url) ?? data.video_url
    const meta = metaRef.current
    const elapsed = data.elapsed_seconds ?? null
    if (meta) {
      setCurrent({
        jobId,
        url,
        thumbnailUrl: client.media(data.thumbnail_url ?? null),
        prompt: meta.prompt,
        model: meta.model,
        resolution: meta.resolution,
        aspect: meta.aspect,
        frames: meta.frames,
        fps: meta.fps,
        durationSeconds: meta.frames / meta.fps,
        elapsed,
      })
    }
    toast.success('Video ready', elapsed != null ? `Generated in ${clock(elapsed)}` : undefined)
    setPage(1)
    void historyQ.refetch()

    if (!meta) return
    void (async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Failed to download video (${res.status})`)
        const blob = await res.blob()
        await library.add({
          kind: 'video',
          source: 'video',
          blob,
          name: meta.prompt.slice(0, 48) || 'video',
          prompt: meta.prompt,
          model: meta.model,
          seed: meta.seed >= 0 ? meta.seed : undefined,
          durationSeconds: meta.frames / meta.fps,
          meta: { jobId, aspect_ratio: meta.aspect, resolution: meta.resolution, num_frames: meta.frames, fps: meta.fps },
        })
      } catch (e) {
        toast.error('Could not save video to library', errorMessage(e))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job.status, job.data, jobId])

  const active = job.status === 'queued' || job.status === 'processing'
  const frames = framesFor(s.lengthSec, s.fps)
  const canGenerate = Boolean(s.model) && s.prompt.trim().length > 0 && !submitting && !active && (s.mode === 't2v' || Boolean(image))

  async function generate() {
    if (!s.prompt.trim()) { toast.error('Please enter a prompt'); return }
    if (s.mode === 'i2v' && !image) { toast.error('Please add a reference image for Image-to-Video'); return }
    if (!canGenerate) return
    const seedNum = Number(s.seed)
    const seedValue = s.seed.trim() === '' || !Number.isFinite(seedNum) ? -1 : Math.trunc(seedNum)
    const meta: GenMeta = {
      model: s.model,
      prompt: s.prompt.trim(),
      resolution: s.resolution,
      aspect: s.mode === 'i2v' ? 'from source' : s.aspect,
      frames,
      fps: s.fps,
      seed: seedValue,
    }
    metaRef.current = meta
    persistedRef.current = null
    setEstimated(null)
    setSubmitting(true)
    try {
      const body: VideoGenerateRequest = {
        prompt: meta.prompt,
        resolution: s.resolution,
        // I2V derives the aspect from the source image, but the field must still be a valid enum.
        aspect_ratio: s.aspect,
        num_frames: frames,
        fps: s.fps,
        guidance_scale: Number(s.guidance) || 1,
        num_inference_steps: Number(s.steps) || 6,
        seed: seedValue,
        audio: s.audio,
      }
      // Backend decodes `image` with base64.b64decode — strip the data-URL prefix.
      if (s.mode === 'i2v' && image) body.image = stripDataUrl(image)
      const res = await client.video(s.mode, s.model, body)
      setEstimated(res.estimated_time_seconds)
      setJobId(res.job_id)
    } catch (e) {
      toast.error('Could not start video generation', errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  function playHistory(v: VideoHistoryEntry) {
    setCurrent({
      jobId: v.id,
      url: client.url(`/video/download/${v.id}`),
      thumbnailUrl: client.media(v.thumbnail_url),
      prompt: v.prompt,
      model: v.model,
      resolution: v.resolution,
      aspect: v.aspect_ratio,
      frames: v.num_frames,
      fps: v.duration_seconds > 0 ? Math.round(v.num_frames / v.duration_seconds) : null,
      durationSeconds: v.duration_seconds,
      elapsed: null,
    })
  }

  function reuse(v: { prompt: string; model: string; resolution: string; aspect: string; durationSeconds: number; fps: number | null }) {
    const patch: Partial<Settings> = {
      prompt: v.prompt,
      lengthSec: Math.max(1, Math.min(10, Math.round(v.durationSeconds) || 1)),
    }
    if (v.resolution === '480p' || v.resolution === '720p') patch.resolution = v.resolution
    if (v.aspect === '16:9' || v.aspect === '9:16' || v.aspect === '1:1') patch.aspect = v.aspect
    if (v.fps != null && v.fps >= 12 && v.fps <= 30) patch.fps = v.fps
    if (models.some((m) => m.id === v.model)) patch.model = v.model
    set(patch)
    toast.success('Prompt and settings reused')
  }

  async function removeHistory(id: string, prompt: string) {
    if (confirmDeletes && !confirm(`Delete this video?\n\n${prompt.slice(0, 120)}`)) return
    try {
      await client.deleteVideo(id)
      if (current?.jobId === id) setCurrent(null)
      toast.success('Video deleted')
      void historyQ.refetch()
    } catch (e) {
      toast.error('Delete failed', errorMessage(e))
    }
  }

  function copyInfo(v: CurrentVideo) {
    const info = [
      `Prompt: ${v.prompt}`,
      `Model: ${v.model}`,
      `Resolution: ${v.resolution}`,
      `Aspect Ratio: ${v.aspect}`,
      `Frames: ${v.frames}`,
      v.fps != null ? `FPS: ${v.fps}` : null,
      `Duration: ${v.durationSeconds.toFixed(1)}s`,
    ].filter((l): l is string => l != null).join('\n')
    navigator.clipboard.writeText(info).then(
      () => toast.success('Info copied to clipboard'),
      (e: unknown) => toast.error('Copy failed', errorMessage(e)),
    )
  }

  const percent = Math.round((job.progress ?? 0) * 100)
  const phase = job.status === 'queued' ? 'Queued…' : (job.progress ?? 0) >= 1 ? 'Encoding video…' : 'Generating…'

  return (
    <div className="flex h-full">
      {/* controls */}
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-5">
          <Section title="Mode">
            <Segmented<Mode>
              value={s.mode}
              onChange={(mode) => set({ mode })}
              options={[
                { value: 't2v', label: <span className="flex items-center gap-1.5"><Type size={13} /> Text-to-Video</span> },
                { value: 'i2v', label: <span className="flex items-center gap-1.5"><ImagePlus size={13} /> Image-to-Video</span> },
              ]}
            />
          </Section>

          <Section title="Model">
            {modelsQ.isLoading ? (
              <div className="text-xs text-ink-faint">Checking…</div>
            ) : modelsQ.isError ? (
              <div className="text-xs text-bad">Video endpoint unavailable</div>
            ) : !models.length ? (
              <div className="text-xs text-ink-faint">No video models reported</div>
            ) : (
              <>
                <Select value={s.model} onChange={(e) => set({ model: e.target.value })}>
                  {compatible.length === 0 && <option value="">No {s.mode === 't2v' ? 'T2V' : 'I2V'} models</option>}
                  {compatible.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}{m.loaded ? ' (loaded)' : ''} · {m.estimated_vram_gb}GB
                    </option>
                  ))}
                </Select>
                <div className="flex flex-wrap items-center gap-1.5">
                  {selected?.loaded && (
                    <span className="rounded-full border border-good/40 bg-good/10 px-2 py-0.5 text-[11px] text-good">Loaded</span>
                  )}
                  {selected?.supports_t2v && (
                    <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink-dim">T2V</span>
                  )}
                  {selected?.supports_i2v && (
                    <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink-dim">I2V</span>
                  )}
                </div>
              </>
            )}
          </Section>

          {s.mode === 'i2v' && (
            <Section title="Reference image">
              <ImageDrop value={image} onChange={setImage} compact label="Drop an image to animate (resized automatically)" />
            </Section>
          )}

          <Section title="Prompt">
            <Textarea
              rows={4}
              value={s.prompt}
              placeholder="Describe the motion, camera and scene…"
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </Section>

          <Section title="Output">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Resolution</Label>
                <Select value={s.resolution} onChange={(e) => set({ resolution: e.target.value === '720p' ? '720p' : '480p' })}>
                  {RESOLUTIONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </Select>
              </div>
              <div>
                <Label>Aspect ratio</Label>
                {s.mode === 'i2v' ? (
                  <Select value="source" disabled>
                    <option value="source">From source image</option>
                  </Select>
                ) : (
                  <Select
                    value={s.aspect}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '16:9' || v === '9:16' || v === '1:1') set({ aspect: v })
                    }}
                  >
                    {ASPECTS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                  </Select>
                )}
              </div>
            </div>
            {s.mode === 'i2v' && <div className="-mt-1 text-[11px] text-ink-faint">Aspect ratio is taken from the source image</div>}
            <Slider
              label="Length"
              value={s.lengthSec}
              min={1}
              max={10}
              step={1}
              onValueChange={(lengthSec) => set({ lengthSec })}
              format={(v) => `${v}s`}
            />
            <div className="-mt-1 text-[11px] text-ink-faint">
              {frames} frames at {s.fps}fps ≈ {(frames / s.fps).toFixed(1)}s
              {s.resolution === '720p' && s.lengthSec > 4 && (
                <span className="text-warn"> — shortened to ~5s at 720p (VRAM limit)</span>
              )}
            </div>
            <Switch checked={s.audio} onChange={(audio) => set({ audio })} label="Audio track" />
            <div className="-mt-1 text-[11px] text-ink-faint">Synchronized sound generated with the video</div>
          </Section>

          <Section title="Sampling">
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label hint="-1 = random">Seed</Label>
                <Input type="number" min={-1} step={1} value={s.seed} onChange={(e) => set({ seed: e.target.value })} />
              </div>
              <IconButton title="Random seed" onClick={() => set({ seed: String(Math.floor(Math.random() * 2147483647)) })}>
                <Dices size={15} />
              </IconButton>
              <IconButton title="Reset to random (-1)" onClick={() => set({ seed: '-1' })}>
                <RotateCcw size={14} />
              </IconButton>
            </div>
            <Slider label="FPS" value={s.fps} min={12} max={30} step={1} onValueChange={(fps) => set({ fps })} format={(v) => `${v}`} />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Guidance</Label>
                <Input type="number" min={1} max={15} step={0.1} value={s.guidance} onChange={(e) => set({ guidance: e.target.value })} />
              </div>
              <div>
                <Label>Steps</Label>
                <Input type="number" min={1} max={100} step={1} value={s.steps} onChange={(e) => set({ steps: e.target.value })} />
              </div>
            </div>
            <div className="text-[11px] text-ink-faint">ltx-2.5 uses a fixed distilled schedule (8 steps, guidance 1.0) — steps/guidance are ignored there.</div>
          </Section>

          <Button
            variant="primary"
            icon={<Sparkles size={15} />}
            loading={submitting}
            disabled={!canGenerate}
            onClick={() => void generate()}
          >
            {active ? 'Generating…' : 'Generate video'}
          </Button>
        </div>
      </div>

      {/* results */}
      <div className="flex-1 scroll-area p-5">
        <div className="flex flex-col gap-5">
          {jobId && job.status !== 'idle' && job.status !== 'completed' && (
            <Panel className="p-4">
              <div className="mb-2 flex items-center justify-between text-[12.5px]">
                <span className={clsx('flex items-center gap-2 font-medium', job.status === 'failed' ? 'text-bad' : 'text-ink')}>
                  <Film size={15} className={job.status === 'failed' ? 'text-bad' : 'text-accent'} />
                  {job.status === 'failed' ? `Failed${job.error ? ` — ${job.error}` : ''}` : phase}
                </span>
                {active && (
                  <span className="flex items-center gap-3 text-ink-dim">
                    <span>Step {job.currentStep ?? 0} / {job.totalSteps ?? '?'}</span>
                    <span>{percent}%</span>
                    <span className="flex items-center gap-1 text-ink-faint"><Clock size={11} /> {clock(job.elapsedSeconds ?? 0)}</span>
                    {estimated != null && <span className="text-ink-faint">est. ~{Math.round(estimated)}s</span>}
                  </span>
                )}
              </div>
              {active && <ProgressBar value={Math.max(2, percent)} />}
            </Panel>
          )}

          {current ? (
            <Panel className="overflow-hidden">
              <div className="flex justify-center bg-bg">
                <video
                  key={current.url}
                  src={current.url}
                  poster={current.thumbnailUrl ?? undefined}
                  controls
                  autoPlay
                  loop
                  className="max-h-[65vh] max-w-full object-contain"
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] text-ink" title={current.prompt}>{current.prompt}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-4 text-[11.5px] text-ink-faint">
                    <span>{current.model}</span>
                    <span>{current.resolution} • {current.aspect}</span>
                    <span>{current.frames} frames • {current.durationSeconds.toFixed(1)}s</span>
                    {current.elapsed != null && <span>Generated in {clock(current.elapsed)}</span>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => reuse(current)}>Reuse</Button>
                  <Button size="sm" icon={<Copy size={13} />} onClick={() => copyInfo(current)}>Copy info</Button>
                  <Button size="sm" variant="primary" icon={<Download size={13} />} onClick={() => downloadUrl(current.url, `video_${current.jobId}.mp4`)}>Download MP4</Button>
                </div>
              </div>
            </Panel>
          ) : !active ? (
            <EmptyState
              icon={<Film size={26} />}
              title="No video yet"
              detail="Configure a prompt and generate, or pick a clip from history. Completed clips are also saved to your library."
            />
          ) : null}

          <Section
            title="History"
            action={
              <span className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                {total} video{total === 1 ? '' : 's'}
                <IconButton title="Refresh" onClick={() => void historyQ.refetch()}>
                  <RefreshCw size={13} className={historyQ.isFetching ? 'animate-spin' : undefined} />
                </IconButton>
              </span>
            }
          >
            {historyQ.isLoading ? (
              <div className="text-xs text-ink-faint">Loading…</div>
            ) : historyQ.isError ? (
              <div className="text-xs text-bad">Could not load history</div>
            ) : !videos.length ? (
              <div className="text-xs text-ink-faint">No videos yet — generated videos appear here.</div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-3">
                  {videos.map((v) => {
                    const thumb = client.media(v.thumbnail_url)
                    const isCurrent = current?.jobId === v.id
                    return (
                      <Panel key={v.id} className={clsx('group overflow-hidden', isCurrent && 'ring-2 ring-accent/60')}>
                        <button
                          className="relative block aspect-video w-full bg-bg"
                          title="Play"
                          onClick={() => playHistory(v)}
                          onMouseEnter={() => setHovered(v.id)}
                          onMouseLeave={() => setHovered((h) => (h === v.id ? null : h))}
                        >
                          {hovered === v.id ? (
                            <video
                              src={client.url(`/video/download/${v.id}`)}
                              poster={thumb ?? undefined}
                              muted
                              autoPlay
                              loop
                              playsInline
                              className="h-full w-full object-contain"
                            />
                          ) : thumb ? (
                            <img src={thumb} alt="" loading="lazy" className="h-full w-full object-contain" />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-ink-faint"><Film size={20} /></div>
                          )}
                          {hovered !== v.id && (
                            <span className="absolute inset-0 grid place-items-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
                              <Play size={22} className="text-white drop-shadow" />
                            </span>
                          )}
                          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
                            {v.duration_seconds.toFixed(1)}s
                          </span>
                        </button>
                        <div className="flex items-start justify-between gap-1 border-t border-line px-2 py-1.5">
                          <div className="min-w-0">
                            <div className="truncate text-[11.5px] text-ink-dim" title={v.prompt}>{v.prompt}</div>
                            <div className="truncate text-[10.5px] text-ink-faint" title={new Date(v.created_at).toLocaleString()}>
                              {v.resolution} · {v.aspect_ratio} · {v.num_frames}f · {timeAgo(v.created_at)}
                            </div>
                          </div>
                          <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
                            <IconButton
                              title="Reuse prompt & settings"
                              onClick={() => reuse({
                                prompt: v.prompt, model: v.model, resolution: v.resolution, aspect: v.aspect_ratio, durationSeconds: v.duration_seconds,
                                fps: v.duration_seconds > 0 ? Math.round(v.num_frames / v.duration_seconds) : null,
                              })}
                            >
                              <RotateCcw size={13} />
                            </IconButton>
                            <IconButton title="Download" onClick={() => downloadUrl(client.url(`/video/download/${v.id}`), `video_${v.id}.mp4`)}>
                              <Download size={13} />
                            </IconButton>
                            <IconButton title="Delete" onClick={() => void removeHistory(v.id, v.prompt)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </div>
                      </Panel>
                    )
                  })}
                </div>
                {totalPages > 1 && (
                  <div className="flex items-center justify-center gap-3">
                    <Button size="sm" icon={<ChevronLeft size={13} />} disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
                    <span className="text-[12px] text-ink-dim">Page {page} of {totalPages}</span>
                    <Button size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                      Next <ChevronRight size={13} />
                    </Button>
                  </div>
                )}
              </>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
