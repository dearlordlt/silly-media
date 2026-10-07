/**
 * Edit jobs: every edit (batch entry or regenerate) runs on the app-wide GPU
 * queue. A job's `run` is self-contained (source data URL + settings are
 * snapshotted at enqueue time) so it keeps going when the page unmounts; it
 * saves the result to the library linked to its original and reports it via
 * `ctx.addItem`.
 */
import type { Img2ImgRequest } from '../../lib/types'
import type { SillyClient } from '../../lib/api'
import { library } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { fromBackendProgress, jobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { errorMessage, toast } from '../../lib/hooks'
import { stripDataUrl } from '../../lib/media'
import { QWEN21_MODEL } from './presets'
import type { SizeMode } from './presets'

export type UpscaleModel = 'clean' | 'sharp'

/** Sampling settings snapshotted for a batch / stored on every edit. */
export interface RunSettings {
  model: string
  steps: number
  cfg: number
  useLora: boolean
  upscale: boolean
  upscaleFactor: number
  upscaleModel: UpscaleModel
  transparent: boolean
  sizeMode: SizeMode
  outWidth?: number
  outHeight?: number
  /** Reference images (data URLs), qwen-image-2.1 only. */
  references: string[]
}

/** The prompt side of one edit. */
export interface EditPrompt {
  label: string
  prompt: string
  negative: string
  basePrompt?: string
  clothedPrompt?: string
  /** Reference-set run: which set image was image 2. */
  refSet?: { setId: string; setName: string; itemId: string; label: string }
  /** The edit ran on this library item (e.g. a naked base step) instead of the original. */
  sourceItemId?: string
}

/** Payload of an edit job, read back by the page for placeholders / batch progress. */
export interface EditJobData {
  originalId: string
  label: string
  /** Image shown on the placeholder tile (the original's URL or a legacy data URL). */
  preview: string
  /** Regenerate: id of the edit being replaced in place. */
  replaces?: string
}

function isEditJobData(d: unknown): d is EditJobData {
  return typeof d === 'object' && d !== null
    && 'originalId' in d && typeof d.originalId === 'string'
    && 'label' in d && typeof d.label === 'string'
    && 'preview' in d && typeof d.preview === 'string'
}

export function editJobData(job: Job): EditJobData | null {
  return isEditJobData(job.data) ? job.data : null
}

export const isActive = (job: Job): boolean => job.state === 'queued' || job.state === 'running'

function buildRequest(image: string, prompt: string, negativePrompt: string, seed: number | undefined, s: RunSettings): Img2ImgRequest {
  const req: Img2ImgRequest = {
    image: stripDataUrl(image),
    prompt,
    negative_prompt: negativePrompt || ' ',
    num_inference_steps: s.steps,
    true_cfg_scale: s.cfg,
    use_lora: s.useLora,
  }
  if (seed != null) req.seed = seed
  if (s.upscale) { req.upscale = true; req.upscale_factor = s.upscaleFactor; req.upscale_model = s.upscaleModel }
  if (s.model === QWEN21_MODEL) {
    req.transparent = s.transparent
    if (s.outWidth && s.outHeight) { req.width = s.outWidth; req.height = s.outHeight }
    if (s.references.length) req.reference_images = s.references.map(stripDataUrl)
  }
  return req
}

/** Dimensions, and whether a PNG/WebP has any non-opaque pixel (checked on a ≤256px copy). */
async function inspectImage(blob: Blob): Promise<{ width: number; height: number; hasAlpha: boolean }> {
  let bmp: ImageBitmap
  try { bmp = await createImageBitmap(blob) } catch { return { width: 0, height: 0, hasAlpha: false } }
  const { width, height } = bmp
  let hasAlpha = false
  if (blob.type === 'image/png' || blob.type === 'image/webp') {
    const scale = Math.min(1, 256 / Math.max(width, height))
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.drawImage(bmp, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) { hasAlpha = true; break }
      }
    }
  }
  bmp.close()
  return { width, height, hasAlpha }
}

/** Persist an edit result, linked to its original. */
async function saveEdit(blob: Blob, originalId: string, entry: EditPrompt, seed: number | undefined, s: RunSettings, keep?: { id: string; createdAt: number }): Promise<MediaItem> {
  const { width, height, hasAlpha } = await inspectImage(blob)
  return library.add({
    ...keep,
    kind: 'image', source: 'edit', blob,
    name: entry.label,
    prompt: entry.prompt,
    negativePrompt: entry.negative,
    model: s.model, seed,
    width: width || undefined, height: height || undefined,
    meta: {
      originalId,
      label: entry.label,
      steps: s.steps, cfg: s.cfg, useLora: s.useLora,
      upscale: s.upscale, upscaleFactor: s.upscaleFactor, upscaleModel: s.upscaleModel,
      hasAlpha,
      ...(entry.basePrompt ? { basePrompt: entry.basePrompt } : {}),
      ...(entry.clothedPrompt ? { clothedPrompt: entry.clothedPrompt } : {}),
      ...(entry.refSet ? { refSetId: entry.refSet.setId, refSetName: entry.refSet.setName, refItemId: entry.refSet.itemId, refLabel: entry.refSet.label } : {}),
      ...(entry.sourceItemId ? { sourceItemId: entry.sourceItemId } : {}),
      ...(s.model === QWEN21_MODEL ? {
        transparent: s.transparent, sizeMode: s.sizeMode,
        ...(s.outWidth && s.outHeight ? { outWidth: s.outWidth, outHeight: s.outHeight } : {}),
        referenceCount: s.references.length,
      } : {}),
    },
  })
}

/** Queue one edit on the GPU lane; returns the job id. */
export function enqueueEdit({ client, image, entry, seed, settings, group, data, keep, onSaved }: {
  client: SillyClient
  /**
   * Source image as a data URL (snapshot), or a resolver awaited when the job
   * starts (a previous step's output; `sourceItemId` is stored so regenerate
   * reuses that step's image instead of the original).
   */
  image: string | ((signal: AbortSignal) => Promise<{ image: string; sourceItemId: string }>)
  entry: EditPrompt
  seed: number | undefined
  settings: RunSettings
  /** Batch id; regenerate jobs have none. */
  group?: string
  data: EditJobData
  /** Regenerate: replace this item, keeping its id + timestamp (grid / viewer position). */
  keep?: { id: string; createdAt: number }
  /** Called with the saved result (feeds later steps of a multi-step run). */
  onSaved?: (item: MediaItem, blob: Blob) => void
}): string {
  return jobs.enqueue({
    page: 'edit',
    label: keep ? `Regenerate: ${entry.label}` : `Edit: ${entry.label}`,
    detail: entry.prompt,
    group,
    data,
    run: async (ctx) => {
      let ok = false
      try {
        let source: string
        let sourceItemId: string | undefined
        if (typeof image === 'string') source = image
        else {
          ctx.report({ message: 'Waiting for the previous step' })
          const step = await image(ctx.signal)
          source = step.image
          sourceItemId = step.sourceItemId
        }
        const stop = ctx.poll(() => client.img2imgProgress().then(fromBackendProgress), 500)
        const blob = await client.img2img(settings.model, buildRequest(source, entry.prompt, entry.negative, seed, settings), ctx.signal)
        stop()
        ctx.report({ message: 'Saving' })
        if (keep && library.get(keep.id)) await library.remove(keep.id)
        const item = await saveEdit(blob, data.originalId, sourceItemId ? { ...entry, sourceItemId } : entry, seed, settings, keep)
        onSaved?.(item, blob)
        ctx.addItem(item.id)
        ok = true
        if (keep) toast.success('Regenerated successfully')
      } catch (e) {
        const aborted = ctx.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')
        if (!aborted) toast.error(keep ? 'Regeneration failed' : `Edit "${entry.label}" failed`, errorMessage(e))
        throw e
      } finally {
        if (group) announceBatchEnd(ctx.id, group, ok)
      }
    },
  })
}

/** Toast once when the last job of a batch settles (this job's state is not patched yet). */
function announceBatchEnd(selfId: string, group: string, selfOk: boolean) {
  const others = jobs.all().filter((j) => j.group === group && j.id !== selfId)
  if (others.some(isActive)) return
  const done = others.filter((j) => j.state === 'done').length + (selfOk ? 1 : 0)
  if (done > 0) toast.success(`Created ${done} edited image(s)`)
}
