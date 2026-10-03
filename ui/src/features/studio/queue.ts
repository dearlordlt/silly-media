/**
 * Studio generations as app-wide GPU jobs: one job per image, a shared `group`
 * per batch. Everything a job needs is snapshotted into its `data` at enqueue
 * time, so it keeps running (and its result lands in the library) after the
 * page unmounts.
 */
import type { GenerateRequest } from '../../lib/types'
import type { SillyClient } from '../../lib/api'
import { JobCancelled, fromBackendProgress, jobs, throwIfCancelled } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { library } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import type { BatchRow } from './batch'
import type { StudioMeta } from './meta'

export type StudioJobKind = 'single' | 'simple' | 'json' | 'list' | 'vary' | 'sweep'

export interface StudioJobData {
  /** Marker telling studio generations apart from other studio-page jobs (e.g. Enhance prompt). */
  studio: 'generate'
  kind: StudioJobKind
  model: string
  request: GenerateRequest
  /** Expected render size (before upscale), for placeholder aspect ratios. */
  width: number
  height: number
  /** 0-based position within the batch (0 for single images). */
  index: number
  total: number
  /** JSON batch: the row the prompt was resolved from, and all rows (for highlighting). */
  variables?: BatchRow
  rows?: BatchRow[]
  /** JSON batch: `{name±N}` cast for this image. */
  names?: { name: string; offset: number }[]
  /** Gallery folder the result is filed under. */
  folder?: string
}

export function studioJobData(job: Job): StudioJobData | null {
  const d = job.data
  return job.page === 'studio' && typeof d === 'object' && d !== null && 'studio' in d && d.studio === 'generate'
    ? (d as StudioJobData)
    : null
}

export const isActive = (job: Job) => job.state === 'queued' || job.state === 'running'

export const BATCH_TITLES: Record<StudioJobKind, string> = {
  single: 'Image',
  simple: 'Simple batch',
  json: 'JSON batch',
  list: 'Prompt list',
  vary: 'Variation',
  sweep: 'Seed sweep',
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new JobCancelled()) }, { once: true })
  })
}

function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob)
  return new Promise<{ width: number; height: number }>((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  }).finally(() => URL.revokeObjectURL(url))
}

async function saveResult(blob: Blob, data: StudioJobData): Promise<MediaItem> {
  const { model, request, variables, folder } = data
  const dims = await imageSize(blob)
  const label = variables?.name
  const meta: StudioMeta = { request, ...(variables ? { variables } : {}), ...(folder ? { folder } : {}) }
  return library.add({
    kind: 'image',
    source: 'studio',
    blob,
    name: typeof label === 'string' && label ? label : `${model} · ${request.prompt.slice(0, 40)}`,
    prompt: request.prompt,
    negativePrompt: request.negative_prompt,
    model,
    seed: request.seed,
    width: dims.width,
    height: dims.height,
    meta: { ...meta },
  })
}

/** Queue one image. `delayMs` pauses before it starts (legacy batch debounce). */
export function enqueueStudioJob(client: SillyClient, data: StudioJobData, opts: { label: string; group?: string; delayMs?: number }): string {
  return jobs.enqueue({
    page: 'studio',
    label: opts.label,
    detail: data.request.prompt.slice(0, 80),
    group: opts.group,
    data,
    run: async (ctx) => {
      if (opts.delayMs) {
        ctx.report({ message: 'Pausing between images…' })
        await sleep(opts.delayMs, ctx.signal)
        ctx.report({ message: null })
      }
      throwIfCancelled(ctx.signal)
      ctx.poll(() => client.progress().then(fromBackendProgress))
      const blob = await client.generate(data.model, data.request, ctx.signal)
      throwIfCancelled(ctx.signal)
      const item = await saveResult(blob, data)
      ctx.addItem(item.id)
    },
  })
}

let groupSeq = 0
export const newGroup = (kind: StudioJobKind) => `studio-${kind}-${Date.now().toString(36)}-${(groupSeq++).toString(36)}`
