/**
 * Edit result helpers (metadata getters, alpha detection, filenames) and the
 * result viewer with compare-to-original, prev/next, regenerate, reuse and
 * "edit again" — ported from ui-img2img.html's image modal. The grid itself
 * is the shared ArtifactGrid.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, Download, Eye, RefreshCw, RotateCcw, Trash2, Wand2 } from 'lucide-react'
import type { MediaItem } from '../../lib/library'
import { downloadBlob, extensionFor } from '../../lib/media'
import { Modal } from '../../components/ui/Modal'
import { Button, IconButton } from '../../components/ui/primitives'

/* ----------------------------------------------------------- edit metadata */

export function metaString(item: MediaItem, key: string): string | undefined {
  const v = item.meta?.[key]
  return typeof v === 'string' ? v : undefined
}

export function metaNumber(item: MediaItem, key: string): number | undefined {
  const v = item.meta?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function metaFlag(item: MediaItem, key: string): boolean {
  return item.meta?.[key] === true
}

/** Display label of an edit (chip label(s) / "Custom"), falling back to its prompt. */
export function editLabel(item: MediaItem): string {
  return metaString(item, 'label') ?? item.name ?? item.prompt?.slice(0, 30) ?? 'Edit'
}

/** Checkerboard backdrop so transparent (RGBA) results stay readable. */
export const CHECKERBOARD: CSSProperties = {
  backgroundImage: 'repeating-conic-gradient(#3a3a44 0% 25%, #24242b 0% 50%)',
  backgroundSize: '16px 16px',
}

/** True when a PNG/WebP image has any non-opaque pixel (checked on a ≤256px copy). */
export function imageHasAlpha(blob: Blob): Promise<boolean> {
  if (blob.type !== 'image/png' && blob.type !== 'image/webp') return Promise.resolve(false)
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, 256 / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      URL.revokeObjectURL(url)
      if (!ctx) { resolve(false); return }
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] < 255) { resolve(true); return }
      }
      resolve(false)
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false) }
    img.src = url
  })
}

export function safeFilename(name: string, blob: Blob, index?: number): string {
  const base = name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 60) || 'image'
  const prefix = index == null ? '' : `${String(index).padStart(2, '0')}_`
  return `${prefix}${base}.${extensionFor(blob.type)}`
}

/* ------------------------------------------------------------------ viewer */

export function EditViewer({ items, index, onIndex, onClose, originalUrl, regenerating, regenPercent, busy, onRegenerate, onReuse, onEditAgain, onDelete }: {
  items: MediaItem[]
  index: number | null
  onIndex: (index: number) => void
  onClose: () => void
  /** URL of the original an edit was made from, if it still exists. */
  originalUrl: (item: MediaItem) => string | null
  regenerating: boolean
  regenPercent: number
  /** A batch is running: regenerating would compete for the GPU. */
  busy: boolean
  onRegenerate: (item: MediaItem) => void
  onReuse: (item: MediaItem) => void
  onEditAgain: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
}) {
  const item = index == null ? null : items[index] ?? null
  const [compareId, setCompareId] = useState<string | null>(null)
  const count = items.length

  useEffect(() => {
    if (index == null || !count) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
      if (e.key === 'ArrowRight') onIndex((index + 1) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, count, onIndex])

  if (!item || index == null) return null

  const original = originalUrl(item)
  const showingOriginal = compareId === item.id && !!original
  const hasAlpha = metaFlag(item, 'hasAlpha')
  const q21 = item.model === 'qwen-image-2.1'
  const outW = metaNumber(item, 'outWidth')
  const outH = metaNumber(item, 'outHeight')
  const steps = metaNumber(item, 'steps')
  const cfg = metaNumber(item, 'cfg')

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title={<span className="flex items-center gap-2">{editLabel(item)} <span className="text-[11px] font-normal text-ink-faint">{index + 1} / {count}</span></span>}
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => onDelete(item)}>Delete</Button>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} disabled={!item.prompt} onClick={() => onReuse(item)} title="Load this prompt and its settings into the editor">Reuse prompt</Button>
          <Button variant="secondary" size="sm" icon={<Wand2 size={14} />} onClick={() => onEditAgain(item)} title="Use this result as a new source image">Edit again</Button>
          <Button
            variant="secondary" size="sm" icon={<RefreshCw size={14} />}
            loading={regenerating} disabled={!item.prompt || busy || regenerating}
            onClick={() => onRegenerate(item)}
            title="Re-run this edit with the same settings and replace it"
          >{regenerating ? `${Math.round(regenPercent)}%` : 'Regenerate'}</Button>
          <Button variant="primary" size="sm" icon={<Download size={14} />} onClick={() => downloadBlob(item.blob, safeFilename(editLabel(item), item.blob))}>Download</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="relative grid min-h-[50vh] place-items-center rounded-xl bg-bg p-3">
          <img
            src={showingOriginal && original ? original : item.url}
            alt=""
            className="max-h-[68vh] max-w-full object-contain"
            style={hasAlpha && !showingOriginal ? CHECKERBOARD : undefined}
          />
          {count > 1 && (
            <>
              <IconButton className="absolute left-2 top-1/2 -translate-y-1/2 bg-black/50 text-white" onClick={() => onIndex((index - 1 + count) % count)} title="Previous (←)"><ChevronLeft size={18} /></IconButton>
              <IconButton className="absolute right-2 top-1/2 -translate-y-1/2 bg-black/50 text-white" onClick={() => onIndex((index + 1) % count)} title="Next (→)"><ChevronRight size={18} /></IconButton>
            </>
          )}
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
            <Button
              size="sm" variant="secondary" icon={<Eye size={13} />}
              disabled={!original}
              title={original ? undefined : 'Original not found'}
              onClick={() => setCompareId(showingOriginal ? null : item.id)}
            >{showingOriginal ? 'Show Edit' : 'Show Original'}</Button>
          </div>
        </div>
        <dl className="space-y-3 text-[12.5px]">
          <Row label="Label" value={editLabel(item)} />
          <Row label="Prompt" value={item.prompt} mono />
          <Row label="Negative" value={item.negativePrompt} mono />
          <Row label="Steps / CFG" value={`${steps ?? '--'} / ${cfg ?? '--'}`} />
          <Row label="LoRA / Seed" value={`${metaFlag(item, 'useLora') ? 'Yes' : 'No'} / ${item.seed ?? 'Random'}`} />
          <Row label="Model" value={item.model} />
          {q21 && (
            <Row
              label="Size / Transparent / References"
              value={`${outW && outH ? `${outW}×${outH}` : 'Match input (~1MP)'} / ${metaFlag(item, 'transparent') ? 'Yes' : 'No'} / ${metaNumber(item, 'referenceCount') ?? 0}`}
            />
          )}
          {metaFlag(item, 'upscale') && <Row label="Upscale" value={`${metaNumber(item, 'upscaleFactor') ?? 2}× ${metaString(item, 'upscaleModel') ?? 'clean'}`} />}
          {item.width ? <Row label="Dimensions" value={`${item.width} × ${item.height}`} /> : null}
          <Row label="Date" value={new Date(item.createdAt).toLocaleString()} />
        </dl>
      </div>
    </Modal>
  )
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  if (value == null || value === '') return null
  return (
    <div>
      <dt className="text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className={clsx('break-words', mono && 'font-mono text-[11.5px] text-ink-dim')}>{value}</dd>
    </div>
  )
}
