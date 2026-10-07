/**
 * Edit result helpers (metadata getters, filenames), placeholder tiles for
 * queued/running edits, and the result viewer with A/B compare (split slider
 * or side by side), prev/next, regenerate, reuse and "edit again" — ported
 * from ui-img2img.html's image modal. The grid itself is the shared
 * ArtifactGrid.
 */
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { clsx } from 'clsx'
import { AlertTriangle, ChevronLeft, ChevronRight, ChevronsLeftRight, Download, Hourglass, Loader2, RefreshCw, RotateCcw, Trash2, Wand2, X } from 'lucide-react'
import type { MediaItem } from '../../lib/library'
import type { LoraSpec } from '../../lib/types'
import { downloadItem, itemExtension } from '../../lib/library'
import { jobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { useElapsed, useQueuePosition } from '../../components/Progress'
import { Modal } from '../../components/ui/Modal'
import { Button, IconButton, ProgressBar, Segmented } from '../../components/ui/primitives'
import { editJobData } from './editJobs'

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

/** User LoRAs an edit ran with ([] for older items). */
export function metaLoras(item: MediaItem): LoraSpec[] {
  const v = item.meta?.loras
  if (!Array.isArray(v)) return []
  return v.filter((l): l is LoraSpec => !!l && typeof l.name === 'string' && typeof l.scale === 'number')
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

/** Download / ZIP entry name for an edit: optional `NN_` index, sanitized label, the item's extension. */
export function safeFilename(name: string, ext: string, index?: number): string {
  const base = name.replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 60) || 'image'
  const prefix = index == null ? '' : `${String(index).padStart(2, '0')}_`
  return `${prefix}${base}.${ext}`
}

/* ---------------------------------------------------------- pending tiles */

/** Placeholder result tile for a queued / running / failed edit job. */
export function PendingEditTile({ job }: { job: Job }) {
  const data = editJobData(job)
  const running = job.state === 'running'
  const failed = job.state === 'failed'
  const position = useQueuePosition(job)
  const elapsed = useElapsed(job.startedAt, running)
  const p = job.progress
  const pct = p.fraction != null ? Math.round(p.fraction * 100) : null
  const status = failed ? job.error ?? 'Failed'
    : running ? [p.step != null && p.total ? `Step ${p.step}/${p.total}` : p.message ?? 'Loading model…', `${elapsed.toFixed(0)}s`].join(' · ')
    : position ? `Queued · #${position}` : 'Queued'

  return (
    <div className={clsx('group relative overflow-hidden rounded-xl border border-dashed bg-panel', failed ? 'border-bad/50' : 'border-accent/40')}>
      <div className="relative aspect-square w-full bg-bg">
        {data && <img src={data.preview} alt="" className="absolute inset-0 h-full w-full object-contain opacity-25 blur-[1px]" />}
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
          {failed ? <AlertTriangle size={20} className="text-bad" />
            : running ? <Loader2 size={20} className="animate-spin text-accent" />
            : <Hourglass size={20} className="text-ink-faint" />}
          <div className={clsx('line-clamp-3 text-[11.5px]', failed ? 'text-bad' : 'text-ink-dim')}>{status}</div>
          {failed && (
            <div className="flex gap-1.5">
              <Button size="sm" variant="secondary" icon={<RefreshCw size={12} />} onClick={() => jobs.retry(job.id)}>Retry</Button>
              <Button size="sm" variant="ghost" onClick={() => jobs.remove(job.id)}>Dismiss</Button>
            </div>
          )}
        </div>
        {!failed && (
          <button
            onClick={() => jobs.cancel(job.id)}
            title={running ? 'Cancel (stops waiting; the GPU may finish the current step)' : 'Remove from queue'}
            className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-md bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100"
          ><X size={13} /></button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 border-t border-line px-2 py-1.5">
        <div className="truncate text-[11.5px] text-ink-dim" title={job.detail}>{data?.replaces ? 'Regenerate: ' : ''}{data?.label ?? job.label}</div>
        <ProgressBar value={running ? pct ?? 0 : failed ? 100 : 0} />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ viewer */

export type CompareMode = 'edit' | 'split' | 'side'

const COMPARE_OPTIONS: { value: CompareMode; label: string }[] = [
  { value: 'edit', label: 'Edit' },
  { value: 'split', label: 'Compare' },
  { value: 'side', label: 'Side by side' },
]

const BOX = 'relative h-[62vh] w-full overflow-hidden rounded-lg'
const FILL = 'absolute inset-0 h-full w-full object-contain'

function Tag({ children, className }: { children: string; className?: string }) {
  return <span className={clsx('pointer-events-none absolute top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10.5px] font-medium text-white', className)}>{children}</span>
}

/** Original (left) vs edit (right) in one box, split by a draggable vertical divider (←/→ when focused). */
function SplitCompare({ original, edit, alpha }: { original: string; edit: string; alpha: boolean }) {
  const [pos, setPos] = useState(50)
  const box = useRef<HTMLDivElement>(null)
  const handle = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  // Focus the handle so ←/→ move the divider right away (prev/next stay on the buttons).
  useEffect(() => { handle.current?.focus({ preventScroll: true }) }, [])

  const moveTo = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (!r || !r.width) return
    setPos(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)))
  }

  return (
    <div
      ref={box}
      className={clsx(BOX, 'cursor-ew-resize touch-none select-none')}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        handle.current?.focus({ preventScroll: true })
        moveTo(e.clientX)
      }}
      onPointerMove={(e) => { if (dragging.current) moveTo(e.clientX) }}
      onPointerUp={() => { dragging.current = false }}
      onPointerCancel={() => { dragging.current = false }}
    >
      <img src={original} alt="Original" draggable={false} className={FILL} />
      <img
        src={edit} alt="Edit" draggable={false}
        className={clsx(FILL, 'bg-bg')}
        style={{ ...(alpha ? CHECKERBOARD : undefined), clipPath: `inset(0 0 0 ${pos}%)` }}
      />
      <div className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90 shadow-[0_0_6px_rgba(0,0,0,0.6)]" style={{ left: `${pos}%` }} />
      <div
        ref={handle}
        role="slider"
        tabIndex={0}
        aria-label="Compare divider"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        title="Drag, or use ← / → (Shift = bigger steps)"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
          e.preventDefault()
          const step = (e.shiftKey ? 10 : 2) * (e.key === 'ArrowLeft' ? -1 : 1)
          setPos((p) => Math.min(100, Math.max(0, p + step)))
        }}
        className="absolute top-1/2 grid h-9 w-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/80 bg-black/60 text-white outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{ left: `${pos}%` }}
      ><ChevronsLeftRight size={16} /></div>
      <Tag className="left-2">Original</Tag>
      <Tag className="right-2">Edit</Tag>
    </div>
  )
}

function SideBySide({ original, edit, alpha }: { original: string; edit: string; alpha: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className={BOX}>
        <img src={original} alt="Original" className={FILL} />
        <Tag className="left-2">Original</Tag>
      </div>
      <div className={BOX}>
        <img src={edit} alt="Edit" className={FILL} style={alpha ? CHECKERBOARD : undefined} />
        <Tag className="left-2">Edit</Tag>
      </div>
    </div>
  )
}

export function EditViewer({ items, index, onIndex, onClose, originalUrl, mode, onMode, regenJob, onRegenerate, onReuse, onEditAgain, onDelete }: {
  items: MediaItem[]
  index: number | null
  onIndex: (index: number) => void
  onClose: () => void
  /** URL of the original an edit was made from, if it still exists. */
  originalUrl: (item: MediaItem) => string | null
  mode: CompareMode
  onMode: (mode: CompareMode) => void
  /** Queued / running regenerate job of an item, if any. */
  regenJob: (item: MediaItem) => Job | undefined
  onRegenerate: (item: MediaItem) => void
  onReuse: (item: MediaItem) => void
  onEditAgain: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
}) {
  const item = index == null ? null : items[index] ?? null
  const count = items.length
  const original = item ? originalUrl(item) : null

  useEffect(() => {
    if (index == null || !count) return
    const onKey = (e: KeyboardEvent) => {
      // The split slider consumes ←/→ while focused.
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') onIndex((index - 1 + count) % count)
      if (e.key === 'ArrowRight') onIndex((index + 1) % count)
      if ((e.key === 'c' || e.key === 'C') && original) onMode(mode === 'edit' ? 'split' : 'edit')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, count, onIndex, original, mode, onMode])

  if (!item || index == null) return null

  const shown: CompareMode = original ? mode : 'edit'
  const hasAlpha = metaFlag(item, 'hasAlpha')
  const regen = regenJob(item)
  const regenPct = regen?.progress.fraction != null ? Math.round(regen.progress.fraction * 100) : null
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
            loading={regen?.state === 'running'} disabled={!item.prompt || !!regen}
            onClick={() => onRegenerate(item)}
            title="Re-run this edit with the same settings and replace it (queued)"
          >{regen ? (regen.state === 'queued' ? 'Queued…' : regenPct != null ? `${regenPct}%` : 'Regenerating…') : 'Regenerate'}</Button>
          <Button variant="primary" size="sm" icon={<Download size={14} />} onClick={() => downloadItem(item, safeFilename(editLabel(item), itemExtension(item)))}>Download</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-3">
            {original ? (
              <Segmented value={shown} onChange={onMode} options={COMPARE_OPTIONS} />
            ) : (
              <span className="text-[11.5px] text-ink-faint">Original not found — compare unavailable</span>
            )}
            {shown === 'split' && <span className="text-[11px] text-ink-faint">Drag the divider or use ← / →</span>}
            {original && <span className="ml-auto text-[11px] text-ink-faint">C toggles compare</span>}
          </div>
          <div className="relative rounded-xl bg-bg p-3">
            {shown === 'split' && original ? (
              <SplitCompare key={item.id} original={original} edit={item.url} alpha={hasAlpha} />
            ) : shown === 'side' && original ? (
              <SideBySide original={original} edit={item.url} alpha={hasAlpha} />
            ) : (
              <div className={BOX}>
                <img src={item.url} alt="" className={FILL} style={hasAlpha ? CHECKERBOARD : undefined} />
              </div>
            )}
            {count > 1 && (
              <>
                <IconButton className="absolute left-4 top-1/2 -translate-y-1/2 bg-black/50 text-white" onClick={() => onIndex((index - 1 + count) % count)} title="Previous (←)"><ChevronLeft size={18} /></IconButton>
                <IconButton className="absolute right-4 top-1/2 -translate-y-1/2 bg-black/50 text-white" onClick={() => onIndex((index + 1) % count)} title="Next (→)"><ChevronRight size={18} /></IconButton>
              </>
            )}
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
