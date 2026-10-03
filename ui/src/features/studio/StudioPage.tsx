import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowLeftRight, ChevronDown, ChevronLeft, ChevronRight, Copy, Dice5, Download, Eraser, Eye, FileArchive, HelpCircle, Layers,
  ListChecks, Maximize2, RefreshCw, RotateCcw, Rows3, Save, Search, Sparkles, Trash2, Wand2, X, Zap,
} from 'lucide-react'
import type { AspectRatio, GenerateRequest, LoraSpec } from '../../lib/types'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useHealth, useLoras } from '../../lib/query'
import type { MediaItem } from '../../lib/library'
import { downloadItem, itemBlob, library, useLibrary } from '../../lib/library'
import { kv } from '../../lib/kv'
import { jobs, useJobCounts, usePageJobs } from '../../lib/jobs'
import { MOD_KEY, useCommands, usePrimaryAction } from '../../lib/commands'
import { downloadBlob } from '../../lib/media'
import { useApp } from '../../lib/store'
import { ArtifactGrid, JustifiedGrid } from '../../components/Artifact'
import { EnhancePrompt } from '../../components/EnhancePrompt'
import { AspectPicker, dimensionsFor } from '../../components/AspectPicker'
import {
  Button, Chip, IconButton, Input, Label, Panel, Section, Select, Slider, Switch, Textarea,
} from '../../components/ui/primitives'
import {
  DEBOUNCE_OPTIONS, DEFAULT_NEGATIVE, IMAGE_MODELS, PROMPT_PRESETS, QWEN21_PRESETS, QWEN21_SIZES,
  QWEN21_TEXTURE_NEGATIVE, modelDefaults, modelInfo,
} from './presets'
import type { BatchRow } from './batch'
import { hasJsonVariables, interpolatePrompt, nameReferences, shuffle, summarizeBatchJson, validateBatchJson } from './batch'
import { HISTORY_KEYS, useTextHistory } from './history'
import { readStudioMeta, studioFilename } from './meta'
import { requestSnippet } from './snippets'
import type { SnippetKind } from './snippets'
import { createZip } from '../../lib/zip'
import { handOffItem } from '../../lib/handoff'
import { StudioViewer } from './StudioViewer'
import { HighlightVarsDialog, HistoryList, PromptView, VariablesHelpDialog, VisionDialog } from './StudioDialogs'
import { BATCH_TITLES, enqueueStudioJob, isActive, newGroup, studioJobData } from './queue'
import type { StudioJobKind } from './queue'
import { ActiveHero, BatchPanel, PendingTile, tileRatio } from './StudioJobs'
import type { StudioJob } from './StudioJobs'

interface StudioSettings {
  model: string
  prompt: string
  negative: string
  negativeEnabled: boolean
  useAspect: boolean
  aspect: AspectRatio
  baseSize: number
  width: number
  height: number
  steps: number
  cfg: number
  seed: number
  useLora: boolean
  transparent: boolean
  upscale: boolean
  upscaleFactor: number
  upscaleModel: 'clean' | 'sharp'
  loras: LoraSpec[]
  /** Prompt-list batch (one prompt per line, `{a|b}` alternatives). */
  listText: string
  simpleCount: number
  batchJson: string
  batchShuffle: boolean
  /** Pause between batch images (legacy "Batch Debounce"), ms. */
  debounce: number
}

const DEFAULTS: StudioSettings = {
  model: 'z-image-turbo',
  prompt: '',
  negative: '',
  negativeEnabled: false,
  useAspect: true,
  aspect: '1:1',
  baseSize: 1024,
  width: 1024,
  height: 1024,
  steps: 9,
  cfg: 0,
  seed: -1,
  useLora: false,
  transparent: false,
  upscale: false,
  upscaleFactor: 2,
  upscaleModel: 'clean',
  loras: [],
  listText: '',
  simpleCount: 10,
  batchJson: '',
  batchShuffle: false,
  debounce: 1000,
}

const STORAGE_KEY = 'silly-studio-settings'
const SECTIONS_KEY = 'silly-studio-sections'
const HIGHLIGHTS_KEY = 'sillyMediaVarHighlights'
const PAGE_SIZE = 24

/** Expand `{a|b|c}` alternatives into the cartesian product of prompt variants. */
function expandPrompt(prompt: string, limit = 32): string[] {
  const groups = [...prompt.matchAll(/\{([^{}]*\|[^{}]*)\}/g)]
  if (!groups.length) return [prompt]
  let variants = [prompt]
  for (const g of groups) {
    const options = g[1].split('|').map((o) => o.trim())
    const next: string[] = []
    for (const v of variants) {
      for (const o of options) {
        next.push(v.replace(g[0], o))
        if (next.length >= limit) break
      }
    }
    variants = next
    if (variants.length >= limit) break
  }
  return variants
}

/** One image to enqueue: its final request plus the batch context shown while it runs. */
interface ImageSpec {
  request: GenerateRequest
  label: string
  variables?: BatchRow
  names?: { name: string; offset: number }[]
}

/** Render size the backend will use for a request (mirrors its aspect math). */
function requestDims(req: GenerateRequest): { width: number; height: number } {
  if (req.width && req.height) return { width: req.width, height: req.height }
  return dimensionsFor(req.aspect_ratio ?? '1:1', req.base_size ?? 1024)
}

const randomSeed = () => Math.floor(Math.random() * 2 ** 31)

interface Status { kind: 'success' | 'error' | 'info'; text: string }

export function StudioPage() {
  const client = useClient()
  const navigate = useNavigate()
  const confirmDeletes = useApp((a) => a.confirmDeletes)
  const [s, setS] = useState<StudioSettings>(() => ({ ...DEFAULTS, ...kv.getJson<Partial<StudioSettings>>(STORAGE_KEY, {}) }))
  const settingsRef = useRef(s)
  settingsRef.current = s
  const [open, setOpen] = useState<Record<string, boolean>>(() => kv.getJson<Record<string, boolean>>(SECTIONS_KEY, {}))
  const [highlights, setHighlights] = useState<ReadonlySet<string>>(() => new Set<string>(kv.getJson<string[]>(HIGHLIGHTS_KEY, [])))

  const [status, setStatus] = useState<Status | null>(null)
  /** Finished-image id the user dismissed from the "latest" hero. */
  const [hiddenLatest, setHiddenLatest] = useState<string | null>(null)

  const [folder, setFolder] = useState('all')
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [visionItem, setVisionItem] = useState<MediaItem | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [varsOpen, setVarsOpen] = useState(false)
  const [zipLabel, setZipLabel] = useState<string | null>(null)
  const galleryRef = useRef<HTMLDivElement>(null)

  const promptHistory = useTextHistory(HISTORY_KEYS.prompt)
  const negHistory = useTextHistory(HISTORY_KEYS.negative)
  const jsonHistory = useTextHistory(HISTORY_KEYS.json)

  const allImages = useLibrary('image')
  const { data: loraData, isError: lorasError, refetch: refetchLoras, isFetching: lorasFetching } = useLoras()
  const { data: health } = useHealth()

  const info = modelInfo(s.model)
  const set = (patch: Partial<StudioSettings>) => setS((prev) => ({ ...prev, ...patch }))

  useEffect(() => { kv.setJson(STORAGE_KEY, s) }, [s])
  useEffect(() => { kv.setJson(SECTIONS_KEY, open) }, [open])
  useEffect(() => { kv.setJson(HIGHLIGHTS_KEY, [...highlights]) }, [highlights])

  /* ------------------------------------------------------------ jobs */

  const pageJobs = usePageJobs('studio')
  /** Studio generations (not e.g. Enhance prompt), newest first. */
  const studioJobs = useMemo(() => pageJobs.flatMap((job): StudioJob[] => {
    const data = studioJobData(job)
    return data ? [{ id: job.id, job, data }] : []
  }), [pageJobs])
  const activeJobs = useMemo(() => studioJobs.filter((j) => isActive(j.job)), [studioJobs])
  const counts = useJobCounts()
  const gpuBusy = counts.running + counts.queued

  // React to jobs finishing while the page is mounted: status line, failure toasts, batch completion.
  const seenJobs = useRef<Set<string> | null>(null)
  useEffect(() => {
    const finished = studioJobs.filter((j) => !isActive(j.job))
    if (!seenJobs.current) { seenJobs.current = new Set(finished.map((j) => j.id)); return }
    const seen = seenJobs.current
    const groups = new Set<string>()
    for (const { job, data } of finished) {
      if (seen.has(job.id)) continue
      seen.add(job.id)
      if (job.group) groups.add(job.group)
      if (job.state === 'failed') {
        setStatus({ kind: 'error', text: `${job.label}: ${job.error ?? 'failed'}` })
        toast.error(`${job.label} failed`, job.error)
      } else if (job.state === 'done' && data.total === 1 && job.startedAt && job.finishedAt) {
        setStatus({ kind: 'success', text: `${job.label} generated in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s` })
      }
    }
    for (const group of groups) {
      const members = studioJobs.filter((j) => j.job.group === group)
      if (!members.length || members.some((j) => isActive(j.job))) continue
      const done = members.filter((j) => j.job.state === 'done').length
      const cancelled = members.some((j) => j.job.state === 'cancelled')
      const { kind, folder: batchFolder } = members[0].data
      setStatus(cancelled
        ? { kind: 'error', text: `${BATCH_TITLES[kind]} cancelled after ${done} images` }
        : { kind: 'success', text: `${BATCH_TITLES[kind]} complete: ${done}/${members.length} images` })
      if (done && batchFolder) { setFolder(batchFolder); setPage(0); setSelected(new Set()) }
    }
  }, [studioJobs])

  /* ------------------------------------------------------------ model / presets */

  // Explicit handlers (legacy onModelChange / onLoraChange): an effect keyed on the
  // model would also fire on mount and clobber persisted or preset steps/cfg.
  const changeModel = (model: string) => {
    const m = modelInfo(model)
    setS((prev) => {
      if (!m) return { ...prev, model }
      // Qwen 2.1 turbo is opt-in: always start from the base schedule when switching to it.
      const useLora = !!m.turboLora && prev.useLora && !(model === 'qwen-image-2.1' && prev.model !== model)
      return {
        ...prev,
        model,
        useLora,
        ...modelDefaults(m, useLora),
        transparent: m.supportsTransparent ? prev.transparent : false,
      }
    })
  }

  const changeLora = (useLora: boolean) => {
    const m = modelInfo(s.model)
    set({ useLora, ...(m ? modelDefaults(m, useLora) : {}) })
  }

  const applyQwen21Preset = (p: (typeof QWEN21_PRESETS)[number]) => {
    setS((prev) => {
      const next = { ...prev, useLora: p.useLora, steps: p.steps, cfg: p.cfg }
      if (p.negative && !prev.negative.includes(p.negative)) {
        next.negative = prev.negative.trim() ? `${prev.negative.trim()}, ${p.negative}` : p.negative
      }
      if (p.negative) next.negativeEnabled = true
      return next
    })
    toast.info(`Qwen 2.1: ${p.useLora ? 'turbo' : 'base'} ${p.steps} steps, CFG ${p.cfg}`)
  }

  /** Legacy applyQwen21Size: aspect mode sets base size; custom W/H scales the area to base². */
  const applyQwen21Size = (base: number) => {
    if (s.useAspect) { set({ baseSize: base }); return }
    const w = s.width || 1024
    const h = s.height || 1024
    const fit = Math.min(Math.sqrt((base * base) / (w * h)), 2048 / Math.max(w, h))
    set({ width: Math.max(64, Math.floor((w * fit) / 64) * 64), height: Math.max(64, Math.floor((h * fit) / 64) * 64) })
  }

  /* ------------------------------------------------------------ requests */

  /** Request for the current settings; prompt/negative default to the raw (unresolved) text. */
  const buildRequest = (prompt?: string, negative?: string): GenerateRequest => {
    const cur = settingsRef.current
    const m = modelInfo(cur.model)
    const req: GenerateRequest = { prompt: prompt ?? cur.prompt, num_inference_steps: cur.steps }
    if (cur.useAspect) { req.aspect_ratio = cur.aspect; req.base_size = cur.baseSize }
    else { req.width = cur.width; req.height = cur.height }
    const neg = negative ?? cur.negative
    if (cur.negativeEnabled && neg.trim()) req.negative_prompt = neg
    if (m?.cfg && cur.cfg > 0) req.cfg_scale = cur.cfg
    if (cur.seed >= 0) req.seed = cur.seed
    if (m?.turboLora && cur.useLora) req.use_lora = true
    if (m?.supportsTransparent && cur.transparent) req.transparent = true
    if (cur.upscale) {
      req.upscale = true
      req.upscale_factor = cur.upscaleFactor
      req.upscale_model = cur.upscaleModel
    }
    if (m?.supportsUserLoras && cur.loras.length) req.loras = cur.loras
    return req
  }

  /** Queue images as GPU jobs (one per image, one group per batch); settings are snapshotted now. */
  const enqueueImages = (kind: StudioJobKind, specs: ImageSpec[], opts: { model?: string; folder?: string; rows?: BatchRow[] } = {}) => {
    const cur = settingsRef.current
    const model = opts.model ?? cur.model
    const total = specs.length
    const group = total > 1 ? newGroup(kind) : undefined
    specs.forEach((spec, index) => {
      enqueueStudioJob(client, {
        studio: 'generate',
        kind,
        model,
        request: spec.request,
        ...requestDims(spec.request),
        index,
        total,
        variables: spec.variables,
        rows: opts.rows,
        names: spec.names,
        folder: opts.folder,
      }, { label: spec.label, group, delayMs: index > 0 ? cur.debounce : 0 })
    })
    setHiddenLatest(null)
    setStatus({ kind: 'info', text: total > 1 ? `Queued ${total} images` : `Queued ${specs[0]?.label.toLowerCase() ?? 'image'}` })
  }

  const batchLabel = (kind: StudioJobKind, i: number, total: number) => `${BATCH_TITLES[kind]} ${i + 1}/${total}`

  const generate = () => {
    const template = s.prompt.trim()
    if (!template) { setStatus({ kind: 'error', text: 'Please enter a prompt' }); return }
    // Random [built-ins] resolve for single images too (legacy generate()).
    enqueueImages('single', [{ request: buildRequest(interpolatePrompt(template, {}), interpolatePrompt(s.negative, {})), label: 'Image' }])
  }

  const runSimpleBatch = () => {
    const template = s.prompt.trim()
    if (!template) { setStatus({ kind: 'error', text: 'Please enter a prompt' }); return }
    if (hasJsonVariables(template)) { setStatus({ kind: 'error', text: '{variables} require JSON batch mode. Use [] for random values.' }); return }
    const count = Math.floor(s.simpleCount)
    if (!(count >= 1 && count <= 100)) { setStatus({ kind: 'error', text: 'Count must be between 1 and 100' }); return }
    enqueueImages('simple', Array.from({ length: count }, (_, i) => ({
      request: buildRequest(interpolatePrompt(template, {}), interpolatePrompt(s.negative, {})),
      label: batchLabel('simple', i, count),
    })), { folder: `Simple ${new Date().toLocaleString()}` })
  }

  const jsonState = useMemo(() => validateBatchJson(s.batchJson), [s.batchJson])

  const runJsonBatch = () => {
    if (!jsonState?.ok) { setStatus({ kind: 'error', text: 'Please enter valid JSON' }); return }
    const template = s.prompt.trim()
    if (!template) { setStatus({ kind: 'error', text: 'Please enter a prompt template with {variables}' }); return }
    const rows = s.batchShuffle ? shuffle(jsonState.rows) : jsonState.rows
    const refs = nameReferences(template)
    const total = rows.length
    enqueueImages('json', rows.map((row, i) => ({
      request: buildRequest(interpolatePrompt(template, row, rows, i), interpolatePrompt(s.negative, row, rows, i)),
      label: typeof row.name === 'string' && row.name ? `${row.name} (${i + 1}/${total})` : batchLabel('json', i, total),
      variables: row,
      names: refs.length && rows[0]?.name != null
        ? refs.map((offset) => ({ offset, name: String(rows[(((i + offset) % total) + total) % total]?.name ?? '?') }))
        : undefined,
    })), { folder: `Batch ${new Date().toLocaleString()}`, rows })
  }

  const listPrompts = useMemo(
    () => s.listText.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => expandPrompt(l)).slice(0, 32),
    [s.listText],
  )

  const runListBatch = () => {
    if (!listPrompts.length) { setStatus({ kind: 'error', text: 'Add at least one prompt line' }); return }
    enqueueImages('list', listPrompts.map((p, i) => ({
      request: buildRequest(interpolatePrompt(p, {}), interpolatePrompt(s.negative, {})),
      label: batchLabel('list', i, listPrompts.length),
    })), { folder: `List ${new Date().toLocaleString()}` })
  }

  /** The request that produced `item` (older items without one: current settings + its prompt). */
  const itemRequest = (item: MediaItem): { model: string; request: GenerateRequest } => {
    const known = item.model ? modelInfo(item.model) : undefined
    return { model: known ? known.id : s.model, request: readStudioMeta(item).request ?? buildRequest(item.prompt) }
  }

  /** Same settings as `item`, new random seed. */
  const vary = (item: MediaItem) => {
    const { model, request } = itemRequest(item)
    enqueueImages('vary', [{ request: { ...request, seed: randomSeed() }, label: 'Variation', variables: readStudioMeta(item).variables }], { model })
    setViewerIndex(null)
  }

  /** `count` images with seeds base+1…base+count, filed in their own folder for comparison. */
  const sweep = (item: MediaItem, count: number) => {
    const { model, request } = itemRequest(item)
    const base = item.seed ?? request.seed ?? randomSeed()
    const variables = readStudioMeta(item).variables
    enqueueImages('sweep', Array.from({ length: count }, (_, i) => ({
      request: { ...request, seed: base + i + 1 },
      label: `Seed ${base + i + 1}`,
      variables,
    })), { model, folder: `Sweep ${base} · ${new Date().toLocaleString()}` })
    setViewerIndex(null)
  }

  const cancelAll = () => {
    for (const { job } of activeJobs) jobs.cancel(job.id)
  }

  /* ------------------------------------------------------------ gallery */

  const sortedImages = useMemo(() => [...allImages].sort((a, b) => b.createdAt - a.createdAt), [allImages])
  const folders = useMemo(() => {
    const counts = new Map<string, number>()
    for (const it of sortedImages) {
      const f = readStudioMeta(it).folder
      if (f) counts.set(f, (counts.get(f) ?? 0) + 1)
    }
    return [...counts.entries()]
  }, [sortedImages])
  const activeFolder = folder !== 'all' && folders.some(([f]) => f === folder) ? folder : 'all'
  const filtered = useMemo(
    () => (activeFolder === 'all' ? sortedImages : sortedImages.filter((it) => readStudioMeta(it).folder === activeFolder)),
    [sortedImages, activeFolder],
  )
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages - 1)
  const pageItems = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)

  const goToPage = (p: number) => {
    setPage(p)
    galleryRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const chooseFolder = (f: string) => { setFolder(f); setPage(0); setSelected(new Set()) }

  const toggleSelect = (item: MediaItem) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
    return next
  })

  const selectAll = () => setSelected(
    pageItems.every((it) => selected.has(it.id)) ? new Set() : new Set(pageItems.map((it) => it.id)),
  )

  const removeItems = async (ids: string[]) => {
    await library.removeMany(ids)
    const gone = new Set(ids)
    setSelected((prev) => new Set([...prev].filter((id) => !gone.has(id))))
  }

  const deleteSelected = async () => {
    if (!selected.size || !confirm(`Delete ${selected.size} image(s)?`)) return
    await removeItems([...selected])
    toast.success('Images deleted')
  }

  const clearShown = async () => {
    if (!filtered.length) return
    const scope = activeFolder === 'all' ? 'all' : `"${activeFolder}"`
    if (!confirm(`Delete ${scope === 'all' ? 'all' : `the ${scope}`} ${filtered.length} image(s)?`)) return
    try {
      await removeItems(filtered.map((it) => it.id))
      toast.success('Gallery cleared')
    } catch (e) {
      toast.error('Could not clear the gallery', errorMessage(e))
    }
  }

  const deleteOne = async (item: MediaItem) => {
    if (confirmDeletes && !confirm('Delete this image?')) return
    await removeItems([item.id])
    if (viewerIndex != null) {
      const remaining = filtered.length - 1
      setViewerIndex(remaining <= 0 ? null : Math.min(viewerIndex, remaining - 1))
    }
    toast.success('Image deleted')
  }

  const downloadZip = async () => {
    if (!filtered.length) { toast.info('No images to download'); return }
    try {
      const used = new Map<string, number>()
      const entries: { name: string; blob: Blob; date: Date }[] = []
      for (const it of filtered) {
        setZipLabel(`Loading ${entries.length + 1}/${filtered.length}…`)
        const file = studioFilename(it)
        const n = used.get(file) ?? 0
        used.set(file, n + 1)
        const dot = file.lastIndexOf('.')
        entries.push({ name: n ? `${file.slice(0, dot)}_${n}${file.slice(dot)}` : file, blob: await itemBlob(it), date: new Date(it.createdAt) })
      }
      const zip = await createZip(entries, (done, total) => setZipLabel(`Zipping ${done}/${total}…`))
      const base = activeFolder === 'all' ? 'all-images' : activeFolder.replace(/[<>:"/\\|?*]/g, '_')
      downloadBlob(zip, `${base}.zip`)
      toast.success(`Downloaded ${entries.length} images as ZIP`)
    } catch (e) {
      toast.error('Failed to create ZIP', errorMessage(e))
    } finally {
      setZipLabel(null)
    }
  }

  const openViewer = (item: MediaItem) => {
    const i = filtered.findIndex((it) => it.id === item.id)
    if (i >= 0) setViewerIndex(i)
  }

  const reuse = (item: MediaItem) => {
    const request = readStudioMeta(item).request
    if (!request) {
      if (item.prompt) { set({ prompt: item.prompt }); toast.info('Prompt restored') }
      return
    }
    const known = item.model ? modelInfo(item.model) : undefined
    setS((prev) => ({
      ...prev,
      model: known ? known.id : prev.model,
      prompt: request.prompt ?? prev.prompt,
      negative: request.negative_prompt ?? prev.negative,
      negativeEnabled: !!request.negative_prompt,
      seed: request.seed ?? -1,
      useAspect: !(request.width && request.height),
      aspect: request.aspect_ratio ?? prev.aspect,
      baseSize: request.base_size ?? prev.baseSize,
      width: request.width ?? prev.width,
      height: request.height ?? prev.height,
      steps: request.num_inference_steps ?? prev.steps,
      cfg: request.cfg_scale ?? (known ? known.cfgDefault : prev.cfg),
      useLora: !!request.use_lora,
      transparent: !!request.transparent,
      upscale: !!request.upscale,
      upscaleFactor: request.upscale_factor ?? prev.upscaleFactor,
      upscaleModel: request.upscale_model ?? prev.upscaleModel,
      loras: request.loras ?? [],
    }))
    setViewerIndex(null)
    toast.info('Settings applied')
  }

  const handoff = (item: MediaItem, to: '/edit' | '/vision') => {
    handOffItem(to === '/edit' ? 'edit' : 'vision', item)
    void navigate({ to })
  }

  const copyRequest = (kind: SnippetKind) => {
    void navigator.clipboard.writeText(requestSnippet(kind, client.url(`/generate/${s.model}`), buildRequest()))
      .then(() => toast.success('Copied to clipboard'))
  }

  const savePrompt = (history: typeof promptHistory, text: string, what: string) => {
    if (!text.trim()) { toast.info(`No ${what} to save`); return }
    toast.info(history.add(text.trim()) ? `${what[0].toUpperCase()}${what.slice(1)} saved` : 'Already in history')
  }

  const toggleHighlight = (name: string) => setHighlights((prev) => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name)
    else next.add(name)
    return next
  })

  const availableModels = useMemo(() => {
    const ids = health?.available_image_models
    if (!ids?.length) return IMAGE_MODELS
    return IMAGE_MODELS.filter((m) => ids.includes(m.id))
  }, [health])

  // Latest finished studio image, derived from the job feed so it survives navigating away and back.
  const latestJob = useMemo(() => studioJobs.reduce<StudioJob | undefined>(
    (best, j) => (j.job.state === 'done' && j.job.itemIds.length && (!best || (j.job.finishedAt ?? 0) > (best.job.finishedAt ?? 0)) ? j : best),
    undefined,
  ), [studioJobs])
  const latestItem = latestJob ? allImages.find((it) => it.id === latestJob.job.itemIds[0]) : undefined
  const heroItem = latestItem && latestItem.id !== hiddenLatest ? latestItem : undefined
  /** Running studio image, else the next queued one. */
  const heroJob = activeJobs.find((j) => j.job.state === 'running') ?? activeJobs[activeJobs.length - 1]
  const viewerItem = viewerIndex != null ? filtered[viewerIndex] : undefined
  /** Target of Vary / Seed sweep commands. */
  const lastImage = viewerItem ?? latestItem ?? sortedImages.find((it) => it.source === 'studio')
  /** Batches (job groups) with work left, oldest first. */
  const batches = useMemo(() => {
    const groups = new Map<string, StudioJob[]>()
    for (const j of studioJobs) {
      if (!j.job.group) continue
      const list = groups.get(j.job.group)
      if (list) list.push(j)
      else groups.set(j.job.group, [j])
    }
    return [...groups].filter(([, items]) => items.some((j) => isActive(j.job))).reverse()
  }, [studioJobs])
  const pendingTiles = currentPage === 0 ? activeJobs.filter((j) => activeFolder === 'all' || j.data.folder === activeFolder) : []

  usePrimaryAction({ label: 'Generate', run: generate })
  useCommands([
    { id: 'studio.vary', label: 'Vary last image (new seed)', group: 'Studio', keywords: 'variation random seed again', disabled: !lastImage, run: () => { if (lastImage) vary(lastImage) } },
    { id: 'studio.sweep', label: 'Seed sweep ×4 from last image', group: 'Studio', keywords: 'seeds compare variations', disabled: !lastImage, run: () => { if (lastImage) sweep(lastImage, 4) } },
    { id: 'studio.sweep8', label: 'Seed sweep ×8 from last image', group: 'Studio', keywords: 'seeds compare variations', disabled: !lastImage, run: () => { if (lastImage) sweep(lastImage, 8) } },
    { id: 'studio.clearGallery', label: activeFolder === 'all' ? 'Clear Studio gallery' : `Clear gallery folder "${activeFolder}"`, group: 'Studio', keywords: 'delete images', disabled: !filtered.length, run: () => void clearShown() },
    { id: 'studio.downloadZip', label: 'Download gallery as ZIP', group: 'Studio', keywords: 'export archive', disabled: !filtered.length || zipLabel != null, run: () => void downloadZip() },
    { id: 'studio.toggleNegative', label: s.negativeEnabled ? 'Disable negative prompt' : 'Enable negative prompt', group: 'Studio', run: () => set({ negativeEnabled: !settingsRef.current.negativeEnabled }) },
    { id: 'studio.cancelAll', label: 'Cancel queued and running Studio images', group: 'Studio', keywords: 'stop abort', disabled: !activeJobs.length, run: cancelAll },
  ])

  const activeQwenPreset = QWEN21_PRESETS.find((p) => p.useLora === s.useLora && p.steps === s.steps && p.cfg === s.cfg)
  const isQwen21 = s.model === 'qwen-image-2.1'
  const renderDims = dimensionsFor(s.aspect, s.baseSize)

  const toggleSection = (id: string, fallback: boolean) => setOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? fallback) }))
  const collapsible = (id: string, title: ReactNode, children: ReactNode, defaultOpen = false, action?: ReactNode) => {
    const isOpen = open[id] ?? defaultOpen
    return (
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <button className="flex flex-1 items-center gap-1.5 text-left text-sm font-semibold text-ink" onClick={() => toggleSection(id, defaultOpen)}>
            <ChevronDown size={14} className={clsx('text-ink-faint transition-transform', !isOpen && '-rotate-90')} />
            {title}
          </button>
          {action}
        </div>
        {isOpen && children}
      </section>
    )
  }

  const divider = <div className="my-4 h-px bg-line" />
  const debounceSelect = (
    <div className="flex items-center gap-2">
      <span className="text-[11.5px] text-ink-faint">Delay between images</span>
      <Select className="h-8 w-28" value={s.debounce} onChange={(e) => set({ debounce: Number(e.target.value) })}>
        {DEBOUNCE_OPTIONS.map((ms) => <option key={ms} value={ms}>{ms ? `${ms} ms` : 'none'}</option>)}
      </Select>
    </div>
  )
  const generateLabel = gpuBusy ? `Queue (${gpuBusy} ahead)` : 'Generate'

  return (
    <div className="flex h-full">
      {/* Controls */}
      <div className="scroll-area w-[400px] shrink-0 border-r border-line p-5">
        <Section title="Model">
          <Select value={s.model} onChange={(e) => changeModel(e.target.value)}>
            {availableModels.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </Select>
          {info?.note && <p className="text-[11.5px] leading-relaxed text-ink-faint">{info.note}</p>}
        </Section>

        {divider}

        <Section
          title="Prompt"
          action={
            <div className="flex items-center gap-0.5">
              <EnhancePrompt kind="image" value={s.prompt} onChange={(prompt) => set({ prompt })} />
              <IconButton onClick={() => setHelpOpen(true)} title="Variables help"><HelpCircle size={14} /></IconButton>
              <IconButton onClick={() => setVarsOpen(true)} title="Highlight variables"><Search size={14} /></IconButton>
              <IconButton onClick={() => savePrompt(promptHistory, s.prompt, 'prompt')} title="Save to history"><Save size={14} /></IconButton>
              <IconButton onClick={() => set({ prompt: '' })} title="Clear"><Eraser size={14} /></IconButton>
            </div>
          }
        >
          <Textarea
            value={s.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            rows={5}
            placeholder={`Describe the image… ([location], [20-35], {name} variables supported · ${MOD_KEY}+Enter to generate)`}
          />
          <div className="flex flex-wrap gap-1.5">
            {PROMPT_PRESETS.map((p) => (
              <Chip
                key={p.label}
                title={p.prompt}
                onClick={() => set({ prompt: p.prompt, transparent: info?.supportsTransparent ? !!p.transparent : false })}
              >
                {p.label}
              </Chip>
            ))}
          </div>
          {collapsible('promptHistory', <>Prompt history <span className="font-normal text-ink-faint">({promptHistory.entries.length})</span></>, (
            <HistoryList
              history={promptHistory}
              empty="No prompt history yet — save prompts with the save button."
              onApply={(text) => { set({ prompt: text }); toast.info('Prompt loaded') }}
            />
          ))}
        </Section>

        {divider}

        <Section
          title="Negative prompt"
          action={
            <div className="flex items-center gap-1">
              <IconButton onClick={() => savePrompt(negHistory, s.negative, 'negative prompt')} title="Save to history"><Save size={14} /></IconButton>
              <Switch checked={s.negativeEnabled} onChange={(v) => set({ negativeEnabled: v })} />
            </div>
          }
        >
          {s.negativeEnabled && (
            <>
              <Textarea value={s.negative} onChange={(e) => set({ negative: e.target.value })} rows={2} placeholder="What to avoid…" />
              <div className="flex gap-1.5">
                <Chip onClick={() => set({ negative: QWEN21_TEXTURE_NEGATIVE })}>Qwen texture cleanup</Chip>
                <Chip onClick={() => set({ negative: DEFAULT_NEGATIVE })} title={DEFAULT_NEGATIVE}>Generic quality</Chip>
              </div>
              {!info?.cfg && <p className="text-[11px] text-ink-faint">This model ignores negative prompts (no CFG).</p>}
            </>
          )}
          {collapsible('negHistory', <>Negative history <span className="font-normal text-ink-faint">({negHistory.entries.length})</span></>, (
            <HistoryList
              history={negHistory}
              empty="No negative prompt history yet."
              onApply={(text) => { set({ negative: text, negativeEnabled: true }); toast.info('Negative prompt loaded') }}
            />
          ))}
        </Section>

        {divider}

        <Section title="Size" action={<Switch checked={s.useAspect} onChange={(v) => set({ useAspect: v })} label="Aspect" />}>
          {s.useAspect ? (
            <>
              <AspectPicker value={s.aspect} onChange={(a) => set({ aspect: a })} baseSize={s.baseSize} />
              <Slider label="Base size" value={s.baseSize} min={256} max={2048} step={64} onValueChange={(v) => set({ baseSize: v })} format={(v) => `${v}px`} />
            </>
          ) : (
            <>
              <div className="flex items-end gap-2">
                <div className="flex-1"><Label>Width</Label><Input type="number" min={64} max={2048} step={64} value={s.width} onChange={(e) => set({ width: Number(e.target.value) })} /></div>
                <Button variant="secondary" size="md" icon={<ArrowLeftRight size={14} />} onClick={() => set({ width: s.height, height: s.width })} title="Swap width and height" />
                <div className="flex-1"><Label>Height</Label><Input type="number" min={64} max={2048} step={64} value={s.height} onChange={(e) => set({ height: Number(e.target.value) })} /></div>
              </div>
              <div className="flex items-center gap-2 text-[11.5px] text-ink-faint">
                <span
                  className="inline-block rounded-[3px] border border-ink-dim"
                  style={s.width >= s.height
                    ? { width: 18, height: Math.max(4, Math.round((18 * s.height) / (s.width || 1))) }
                    : { width: Math.max(4, Math.round((18 * s.width) / (s.height || 1))), height: 18 }}
                />
                {s.width === s.height ? 'Square' : s.width > s.height ? 'Landscape' : 'Portrait'} · {s.width}×{s.height}
              </div>
            </>
          )}
          {isQwen21 && (
            <div>
              <Label>Qwen 2.1 size</Label>
              <div className="flex flex-wrap gap-1.5">
                {QWEN21_SIZES.map((q) => (
                  <Chip key={q.value} title={q.title} active={s.useAspect && s.baseSize === q.value} onClick={() => applyQwen21Size(q.value)}>{q.label}</Chip>
                ))}
              </div>
            </div>
          )}
        </Section>

        {isQwen21 && (
          <>
            {divider}
            <Section title="Qwen 2.1">
              <div>
                <Label>Settings</Label>
                <div className="flex flex-wrap gap-1.5">
                  {QWEN21_PRESETS.map((p) => (
                    <Chip key={p.id} title={p.title} active={activeQwenPreset?.id === p.id} onClick={() => applyQwen21Preset(p)}>{p.label}</Chip>
                  ))}
                </div>
              </div>
              <Switch checked={s.transparent} onChange={(v) => set({ transparent: v })} label="Transparent background (RGBA PNG)" />
            </Section>
          </>
        )}

        {divider}

        <Section title="Sampling">
          <Slider label="Steps" value={s.steps} min={1} max={100} onValueChange={(v) => set({ steps: v })} />
          <Slider label={info?.cfg ? 'CFG scale' : 'CFG scale (ignored)'} value={s.cfg} min={0} max={20} step={0.5} onValueChange={(v) => set({ cfg: v })} format={(v) => v.toFixed(1)} />
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label hint="-1 = random">Seed</Label>
              <Input type="number" min={-1} value={s.seed} onChange={(e) => set({ seed: Number(e.target.value) })} />
            </div>
            <Button variant="secondary" size="md" icon={<Dice5 size={15} />} onClick={() => set({ seed: Math.floor(Math.random() * 2 ** 31) })} title="Pick a fixed random seed" />
            <Button variant="secondary" size="md" onClick={() => set({ seed: -1 })} title="Random seed every image">−1</Button>
          </div>
          {info?.turboLora && (
            <Switch checked={s.useLora} onChange={changeLora} label={info.turboLora.label} />
          )}
        </Section>

        {info?.supportsUserLoras && (
          <>
            {divider}
            <Section
              title={
                <span className="flex items-center gap-2">
                  LoRAs
                  {s.loras.length > 0 && <span className="rounded-full bg-accent/20 px-1.5 py-px text-[10.5px] font-semibold text-accent">{s.loras.length} active</span>}
                </span>
              }
              action={
                <div className="flex items-center gap-1">
                  {s.loras.length > 0 && <Button variant="ghost" size="sm" onClick={() => set({ loras: [] })} title="Turn all LoRAs off">Clear</Button>}
                  <span className="text-[11px] text-ink-faint">{loraData?.loras.length ?? 0} installed</span>
                  <IconButton onClick={() => void refetchLoras()} title="Reload LoRA list from server">
                    <RefreshCw size={13} className={clsx(lorasFetching && 'animate-spin')} />
                  </IconButton>
                </div>
              }
            >
              {lorasError ? <p className="text-[11.5px] text-bad">Could not load LoRA list.</p>
                : loraData?.loras.length || s.loras.length ? (
                  <div className="flex flex-col gap-1.5">
                    {[
                      ...(loraData?.loras ?? []).map((l) => ({ name: l.name, note: `${l.size_mb} MB`, missing: false })),
                      // Active (e.g. from reused settings) but not installed: still sent, so keep it switchable.
                      ...(loraData ? s.loras.filter((x) => !loraData.loras.some((l) => l.name === x.name)).map((x) => ({ name: x.name, note: 'not installed', missing: true })) : []),
                    ].map((l) => {
                      const active = s.loras.find((x) => x.name === l.name)
                      return (
                        <div key={l.name} className={clsx('flex flex-col gap-2 rounded-lg border px-2.5 py-2', active ? 'border-accent/50 bg-accent/10' : 'border-line')}>
                          <div className="flex items-center justify-between gap-2">
                            <Switch
                              checked={!!active}
                              onChange={(on) => set({ loras: on ? [...s.loras, { name: l.name, scale: 1 }] : s.loras.filter((x) => x.name !== l.name) })}
                              label={<span className={clsx('break-all text-[12.5px]', active ? 'text-ink' : 'text-ink-dim')}>{l.name}</span>}
                            />
                            <span className={clsx('shrink-0 text-[10.5px]', l.missing ? 'text-warn' : 'text-ink-faint')}>{l.note}</span>
                          </div>
                          {active && (
                            <Slider
                              label="Scale"
                              value={active.scale}
                              min={0}
                              max={2}
                              step={0.05}
                              onValueChange={(v) => set({ loras: s.loras.map((x) => (x.name === l.name ? { ...x, scale: v } : x)) })}
                              format={(v) => `× ${v.toFixed(2)}`}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : <p className="text-[11.5px] text-ink-faint">No LoRAs installed — drop .safetensors files into data/loras.</p>}
            </Section>
          </>
        )}

        {divider}

        <Section title="Upscale">
          <Switch checked={s.upscale} onChange={(v) => set({ upscale: v })} label="ESRGAN upscale after generation" />
          {s.upscale && (
            <div className="flex gap-2">
              <div className="flex-1">
                <Label>Factor</Label>
                <Select value={s.upscaleFactor} onChange={(e) => set({ upscaleFactor: Number(e.target.value) })}>
                  {[1.5, 2, 3, 4].map((f) => <option key={f} value={f}>{f}×</option>)}
                </Select>
              </div>
              <div className="flex-1">
                <Label>Model</Label>
                <Select value={s.upscaleModel} onChange={(e) => set({ upscaleModel: e.target.value === 'sharp' ? 'sharp' : 'clean' })} title="clean removes grain/halftone texture; sharp keeps fine detail">
                  <option value="clean">Clean</option>
                  <option value="sharp">Sharp</option>
                </Select>
              </div>
            </div>
          )}
        </Section>

        {divider}

        {collapsible('simpleBatch', <><Layers size={14} /> Simple batch</>, (
          <>
            <p className="text-[11.5px] text-ink-faint">Generate N images with fresh random <code>[variables]</code> each time.</p>
            <div className="flex items-center gap-2">
              <Input className="w-20" type="number" min={1} max={100} value={s.simpleCount} onChange={(e) => set({ simpleCount: Number(e.target.value) })} />
              <Button variant="primary" className="flex-1" icon={<Zap size={15} />} onClick={runSimpleBatch}>{gpuBusy ? 'Queue' : 'Generate'} {s.simpleCount || ''}</Button>
            </div>
            {debounceSelect}
          </>
        ))}

        <div className="h-4" />

        {collapsible('jsonBatch', <><ListChecks size={14} /> JSON batch</>, (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11.5px] text-ink-faint">JSON data for <code>{'{variables}'}</code></span>
              <IconButton
                title="Save to history"
                onClick={() => {
                  if (!s.batchJson.trim()) { toast.info('No JSON to save'); return }
                  if (!jsonState?.ok) { toast.error('Invalid JSON — fix before saving'); return }
                  savePrompt(jsonHistory, s.batchJson, 'JSON')
                }}
              >
                <Save size={14} />
              </IconButton>
            </div>
            <Textarea
              rows={6}
              className="font-mono text-[12px]"
              value={s.batchJson}
              onChange={(e) => set({ batchJson: e.target.value })}
              placeholder={'[\n  {"name": "Character1", "outfit": "Red dress"},\n  {"name": "Character2", "outfit": "Blue suit"}\n]'}
            />
            {jsonState && (
              <p className={clsx('text-[11.5px]', jsonState.ok ? 'text-good' : 'text-bad')}>
                {jsonState.ok ? `Valid JSON: ${jsonState.rows.length} items with variables: ${jsonState.keys.join(', ')}` : jsonState.error}
              </p>
            )}
            <div className="flex items-center gap-3">
              <Button variant="primary" className="flex-1" icon={<Zap size={15} />} disabled={!jsonState?.ok} onClick={runJsonBatch}>
                {gpuBusy ? 'Queue' : 'Generate'} batch{jsonState?.ok ? ` (${jsonState.rows.length})` : ''}
              </Button>
              <Switch checked={s.batchShuffle} onChange={(v) => set({ batchShuffle: v })} label="Shuffle" />
            </div>
            {debounceSelect}
            {collapsible('jsonHistory', <>JSON history <span className="font-normal text-ink-faint">({jsonHistory.entries.length})</span></>, (
              <HistoryList
                history={jsonHistory}
                empty="No JSON history yet."
                render={summarizeBatchJson}
                onApply={(text) => { set({ batchJson: text }); toast.info('JSON loaded from history') }}
              />
            ))}
          </>
        ))}

        <div className="h-4" />

        {collapsible('listBatch', <><Layers size={14} /> Prompt list</>, (
          <>
            <p className="text-[11.5px] text-ink-faint">
              One prompt per line. <code className="rounded bg-bg px-1">{'{red|blue}'}</code> expands alternatives (max 32 images).
            </p>
            <Textarea rows={4} value={s.listText} onChange={(e) => set({ listText: e.target.value })} placeholder={'a red fox\n{orange|grey} cat on a {couch|windowsill}'} />
            <Button variant="primary" icon={<Zap size={15} />} disabled={!listPrompts.length} onClick={runListBatch}>
              {gpuBusy ? 'Queue' : 'Run'} {listPrompts.length || ''} job{listPrompts.length === 1 ? '' : 's'}
            </Button>
          </>
        ))}

        <div className="sticky bottom-0 -mx-5 mt-5 border-t border-line bg-panel/95 px-5 py-4 backdrop-blur">
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              icon={<Sparkles size={16} />}
              onClick={generate}
              title={`${MOD_KEY}+Enter · ${gpuBusy ? 'adds to the GPU queue' : 'generate now'}`}
            >
              {generateLabel}
            </Button>
            {activeJobs.length > 0 && (
              <Button variant="danger" size="lg" icon={<X size={16} />} onClick={cancelAll} title="Cancel every queued and running Studio image">
                Stop {activeJobs.length}
              </Button>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            <Copy size={12} className="text-ink-faint" />
            <span className="mr-1 text-[11px] text-ink-faint">Copy request</span>
            <Button variant="ghost" size="sm" onClick={() => copyRequest('curl')}>cURL</Button>
            <Button variant="ghost" size="sm" onClick={() => copyRequest('json')}>JSON</Button>
            <Button variant="ghost" size="sm" onClick={() => copyRequest('python')}>Python</Button>
          </div>
          {status && (
            <div className={clsx(
              'mt-2 rounded-lg px-2.5 py-1.5 text-[11.5px]',
              status.kind === 'error' ? 'bg-bad/15 text-bad' : status.kind === 'success' ? 'bg-good/15 text-good' : 'bg-panel-3 text-ink-dim',
            )}>
              {status.text}
            </div>
          )}
        </div>
      </div>

      {/* Results */}
      <div className="scroll-area flex-1 p-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {batches.map(([group, items]) => <BatchPanel key={group} group={group} items={items} />)}

          {heroJob ? (
            <ActiveHero {...heroJob} queued={activeJobs.length - 1} />
          ) : heroItem && (
            <Panel className="overflow-hidden">
              <div className="grid place-items-center bg-bg p-3">
                <button onClick={() => openViewer(heroItem)} title="Open viewer" className="cursor-zoom-in">
                  <img src={heroItem.url} alt="" className="max-h-[60vh] max-w-full object-contain" />
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-1.5 border-t border-line px-3 py-2">
                <span className="mr-auto truncate text-[11px] text-ink-faint">
                  {[heroItem.model, heroItem.width && heroItem.height ? `${heroItem.width}×${heroItem.height}` : null, heroItem.seed != null ? `seed ${heroItem.seed}` : null].filter(Boolean).join(' · ')}
                </span>
                <Button size="sm" variant="ghost" icon={<Maximize2 size={13} />} onClick={() => openViewer(heroItem)}>View</Button>
                <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={() => downloadItem(heroItem, studioFilename(heroItem))}>Download</Button>
                <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => setVisionItem(heroItem)}>Vision</Button>
                <Button size="sm" variant="ghost" icon={<Wand2 size={13} />} onClick={() => handoff(heroItem, '/edit')}>Edit</Button>
                <Button size="sm" variant="ghost" icon={<RotateCcw size={13} />} onClick={() => reuse(heroItem)}>Use settings</Button>
                <Button size="sm" icon={<Dice5 size={13} />} onClick={() => vary(heroItem)} title="Same settings, new random seed">Vary</Button>
                <Button size="sm" icon={<Rows3 size={13} />} onClick={() => sweep(heroItem, 4)} title="4 images with seeds base+1…base+4">Sweep ×4</Button>
                <Button size="sm" onClick={() => sweep(heroItem, 8)} title="8 images with seeds base+1…base+8">×8</Button>
                <IconButton onClick={() => setHiddenLatest(heroItem.id)} title="Hide preview"><X size={15} /></IconButton>
              </div>
              {heroItem.prompt && (
                <div className="border-t border-line px-4 py-2.5 text-[12.5px] leading-relaxed">
                  <span className="mr-1.5 text-[11px] font-semibold uppercase text-accent">Prompt:</span>
                  <PromptView prompt={heroItem.prompt} variables={readStudioMeta(heroItem).variables} rows={latestJob?.data.rows} highlights={highlights} />
                </div>
              )}
              {heroItem.negativePrompt?.trim() && (
                <div className="border-t border-line px-4 py-2.5 text-[12.5px] leading-relaxed">
                  <span className="mr-1.5 text-[11px] font-semibold uppercase text-bad">Negative:</span>
                  {heroItem.negativePrompt}
                </div>
              )}
            </Panel>
          )}

          <div ref={galleryRef}>
            {collapsible('gallery', <>Gallery <span className="font-normal text-ink-faint">({filtered.length}{activeJobs.length ? ` · ${activeJobs.length} in progress` : ''})</span></>, (
              <>
                {folders.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <Chip active={activeFolder === 'all'} onClick={() => chooseFolder('all')}>All ({sortedImages.length})</Chip>
                    {folders.map(([f, n]) => (
                      <Chip key={f} active={activeFolder === f} onClick={() => chooseFolder(f)}>{f} ({n})</Chip>
                    ))}
                  </div>
                )}
                {pendingTiles.length > 0 && (
                  <JustifiedGrid items={pendingTiles} columns={4} ratioOf={(j) => tileRatio(j.data)}>
                    {(j) => <PendingTile {...j} />}
                  </JustifiedGrid>
                )}
                {(pageItems.length > 0 || pendingTiles.length === 0) && (
                  <ArtifactGrid
                    items={pageItems}
                    columns={4}
                    onOpen={openViewer}
                    onReuse={reuse}
                    onDelete={(item) => void deleteOne(item)}
                    selected={selected}
                    onToggleSelect={toggleSelect}
                    extraActions={(item) => (
                      <>
                        <IconButton onClick={() => vary(item)} title="Vary (same settings, new seed)"><Dice5 size={14} /></IconButton>
                        <IconButton onClick={() => setVisionItem(item)} title="Vision analysis"><Eye size={14} /></IconButton>
                      </>
                    )}
                    empty={{ title: 'No images yet', detail: 'Describe something and hit Generate. Results are saved to your local library.' }}
                  />
                )}
                {totalPages > 1 && <Pagination page={currentPage} total={totalPages} onPage={goToPage} />}
              </>
            ), true, (
              <div className="flex flex-wrap justify-end gap-1.5">
                <Button variant="ghost" size="sm" icon={<FileArchive size={14} />} disabled={!filtered.length || zipLabel != null} onClick={() => void downloadZip()}>
                  {zipLabel ?? 'Download ZIP'}
                </Button>
                <Button variant="ghost" size="sm" disabled={!pageItems.length} onClick={selectAll}>
                  {pageItems.length && pageItems.every((it) => selected.has(it.id)) ? 'Select none' : 'Select all'}
                </Button>
                {selected.size > 0 && (
                  <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => void deleteSelected()}>Delete ({selected.size})</Button>
                )}
                <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} disabled={!filtered.length} onClick={() => void clearShown()}>Clear all</Button>
              </div>
            ))}
          </div>

          <footer className="flex items-center justify-center gap-2 pb-4 pt-2 text-[10.5px] text-ink-faint">
            Renders at {s.useAspect ? `${renderDims.width}×${renderDims.height} (${s.aspect})` : `${s.width}×${s.height}`} · {s.steps} steps
          </footer>
        </div>
      </div>

      <StudioViewer
        items={filtered}
        index={viewerIndex}
        onIndex={setViewerIndex}
        onClose={() => setViewerIndex(null)}
        onReuse={reuse}
        onVary={vary}
        onSweep={sweep}
        onVision={setVisionItem}
        onEdit={(item) => handoff(item, '/edit')}
        onDelete={(item) => void deleteOne(item)}
        highlights={highlights}
      />
      <VisionDialog item={visionItem} onClose={() => setVisionItem(null)} onOpenInVision={(item) => handoff(item, '/vision')} />
      <VariablesHelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <HighlightVarsDialog
        open={varsOpen}
        onClose={() => setVarsOpen(false)}
        template={s.prompt}
        selected={highlights}
        onToggle={toggleHighlight}
        onClear={() => setHighlights(new Set())}
      />
    </div>
  )
}

/** Legacy pagination: ←, up to 7 page numbers with first/last + ellipses, →. */
function Pagination({ page, total, onPage }: { page: number; total: number; onPage: (p: number) => void }) {
  const maxVisible = 7
  let start = Math.max(0, page - Math.floor(maxVisible / 2))
  const end = Math.min(total - 1, start + maxVisible - 1)
  if (end - start < maxVisible - 1) start = Math.max(0, end - maxVisible + 1)
  const pages: number[] = []
  for (let i = start; i <= end; i++) pages.push(i)
  const btn = (p: number) => (
    <Button key={p} size="sm" variant={p === page ? 'primary' : 'ghost'} onClick={() => onPage(p)}>{p + 1}</Button>
  )
  return (
    <div className="flex items-center justify-center gap-1">
      <IconButton disabled={page === 0} onClick={() => onPage(page - 1)} title="Previous page"><ChevronLeft size={15} /></IconButton>
      {start > 0 && btn(0)}
      {start > 1 && <span className="px-1 text-ink-faint">…</span>}
      {pages.map(btn)}
      {end < total - 2 && <span className="px-1 text-ink-faint">…</span>}
      {end < total - 1 && btn(total - 1)}
      <IconButton disabled={page === total - 1} onClick={() => onPage(page + 1)} title="Next page"><ChevronRight size={15} /></IconButton>
    </div>
  )
}
