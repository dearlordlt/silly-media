import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { useNavigate } from '@tanstack/react-router'
import { Boxes, Check, ChevronLeft, ChevronRight, Clapperboard, Download, Heart, RotateCcw, ScanEye, Star, Trash2, Wand2 } from 'lucide-react'
import { HANDOFF_ROUTES, handOffImage, type HandoffTarget } from '../lib/handoff'
import { ModelViewer, renderGlbPoster } from './ModelViewer'
import type { MediaItem } from '../lib/library'
import { itemFilename, library } from '../lib/library'
import { downloadBlob, formatBytes, formatDuration } from '../lib/media'
import { Modal } from './ui/Modal'
import { Button, EmptyState, IconButton } from './ui/primitives'
import { useApp } from '../lib/store'

/* ------------------------------------------------------------ aspect ratio */

/** Tiles are clamped to this range so a panorama can't monopolise a row;
 *  the media inside still uses its true ratio (object-contain), never stretched. */
const MIN_TILE_RATIO = 0.5
const MAX_TILE_RATIO = 2.4

const measured = new Map<string, number>()

function knownRatio(item: MediaItem): number | null {
  if (item.width && item.height) return item.width / item.height
  return measured.get(item.id) ?? null
}

/**
 * True width/height ratio of an item. Uses stored dimensions when present;
 * otherwise decodes the media metadata once and backfills the library record
 * so later renders are layout-stable from the first paint.
 */
function useMediaRatio(item: MediaItem): number {
  const [ratio, setRatio] = useState<number | null>(() => knownRatio(item))

  useEffect(() => {
    const known = knownRatio(item)
    if (known) { setRatio(known); return }
    if (item.kind !== 'image' && item.kind !== 'video') return
    let cancelled = false
    const done = (w: number, h: number) => {
      if (cancelled || !w || !h) return
      measured.set(item.id, w / h)
      setRatio(w / h)
      void library.update(item.id, { width: w, height: h })
    }
    if (item.kind === 'image') {
      const img = new Image()
      img.onload = () => done(img.naturalWidth, img.naturalHeight)
      img.src = item.url
    } else {
      const v = document.createElement('video')
      v.preload = 'metadata'
      v.muted = true
      v.onloadedmetadata = () => done(v.videoWidth, v.videoHeight)
      v.src = item.url
    }
    return () => { cancelled = true }
  }, [item])

  return ratio ?? 1
}

const tileRatio = (r: number) => Math.min(MAX_TILE_RATIO, Math.max(MIN_TILE_RATIO, r))

/** Pixel art / tiny sprites stay crisp instead of being smoothed when upscaled. */
const isTinyImage = (item: MediaItem) => item.kind === 'image' && !!item.width && item.width <= 256 && !!item.height && item.height <= 256

/* --------------------------------------------------------- justified grid */

/**
 * Justified rows: every tile in a row shares one height and its width is
 * proportional to the media's aspect ratio (flex-grow = ratio). A trailing
 * spacer stops the last, partial row from stretching.
 *
 * `columns` sets density: the target row height is (container width / columns).
 */
export function JustifiedGrid<T extends { id: string }>({ items, columns = 4, gap = 12, ratioOf, children }: {
  items: T[]
  columns?: number
  gap?: number
  ratioOf: (item: T) => number
  children: (item: T) => ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowHeight = Math.max(110, Math.round((width - gap * (columns - 1)) / columns) || 200)

  return (
    <div ref={ref} className="flex flex-wrap" style={{ gap }}>
      {items.map((item) => {
        const r = tileRatio(ratioOf(item))
        return (
          <div key={item.id} className="min-w-0" style={{ flexGrow: r, flexBasis: r * rowHeight, maxWidth: r * rowHeight * 1.75 }}>
            {children(item)}
          </div>
        )
      })}
      <div aria-hidden style={{ flexGrow: 1e6, flexBasis: 0, height: 0 }} />
    </div>
  )
}

/* -------------------------------------------------------------- the tile */

export interface ArtifactTileProps {
  item: MediaItem
  onOpen: (item: MediaItem) => void
  onReuse?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  selected?: boolean
  onToggleSelect?: (item: MediaItem) => void
  extraActions?: (item: MediaItem) => ReactNode
}

export function ArtifactTile({ item, onOpen, onReuse, onDelete, selected, onToggleSelect, extraActions }: ArtifactTileProps) {
  const ratio = useMediaRatio(item)
  const { confirmDeletes } = useApp()

  const remove = async () => {
    if (onDelete) { onDelete(item); return }
    if (confirmDeletes && !confirm('Delete this item?')) return
    await library.remove(item.id)
  }

  return (
    <div className={clsx(
      'group relative overflow-hidden rounded-xl border bg-panel transition-colors',
      selected ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong',
    )}>
      <button className="block w-full" onClick={() => onOpen(item)} title={item.prompt ?? item.name}>
        <div
          className={clsx('relative w-full bg-bg', item.kind === 'model3d' ? 'bg-[radial-gradient(ellipse_at_center,#232a3a_0%,#0f1219_75%)]' : 'checker')}
          style={{ aspectRatio: String(tileRatio(ratio)) }}
        >
          <MediaThumb item={item} />
        </div>
      </button>

      {onToggleSelect && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(item) }}
          className={clsx(
            'absolute left-2 top-2 grid h-5 w-5 place-items-center rounded border transition-opacity',
            selected ? 'border-accent bg-accent text-white' : 'border-white/50 bg-black/50 text-transparent opacity-0 group-hover:opacity-100',
          )}
          aria-label={selected ? 'Deselect' : 'Select'}
        >
          <Check size={12} />
        </button>
      )}
      {item.favorite && <Star size={14} className="absolute right-2 top-2 fill-warn text-warn drop-shadow" />}

      <div className="flex items-center justify-between gap-1 border-t border-line px-2 py-1.5">
        <div className="min-w-0">
          <div className="truncate text-[11.5px] text-ink-dim">{item.name || item.source}</div>
          <div className="truncate text-[10.5px] text-ink-faint">
            {item.width && item.height ? `${item.width}×${item.height} · ` : ''}{new Date(item.createdAt).toLocaleString()}
          </div>
        </div>
        <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
          {extraActions?.(item)}
          {onReuse && <IconButton onClick={() => onReuse(item)} title="Reuse settings"><RotateCcw size={14} /></IconButton>}
          <IconButton onClick={() => void library.update(item.id, { favorite: !item.favorite })} title="Favourite">
            <Heart size={14} className={clsx(item.favorite && 'fill-warn text-warn')} />
          </IconButton>
          <IconButton onClick={() => void remove()} title="Delete"><Trash2 size={14} /></IconButton>
        </div>
      </div>
    </div>
  )
}

/** Media fills its (correctly proportioned) box; contain guarantees no distortion. */
export function MediaThumb({ item }: { item: MediaItem }) {
  const fill = 'absolute inset-0 h-full w-full object-contain'
  if (item.kind === 'image') {
    return <img src={item.url} alt="" loading="lazy" decoding="async" className={clsx(fill, isTinyImage(item) && '[image-rendering:pixelated]')} />
  }
  if (item.kind === 'video') {
    return (
      <video
        src={item.url} muted loop playsInline preload="metadata" className={fill}
        onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
        onMouseLeave={(e) => { e.currentTarget.pause(); e.currentTarget.currentTime = 0 }}
      />
    )
  }
  if (item.kind === 'audio') {
    return (
      <div className="absolute inset-0 grid place-items-center bg-gradient-to-br from-panel-2 to-panel-3">
        <div className="flex h-1/3 items-end gap-1">
          {[0.4, 0.8, 0.55, 1, 0.7, 0.35, 0.9, 0.5].map((h, i) => (
            <span key={i} className="w-1.5 rounded-full bg-accent/70" style={{ height: `${h * 100}%` }} />
          ))}
        </div>
      </div>
    )
  }
  return <ModelPoster item={item} />
}

/* --------------------------------------------------------------- 3D poster */

const posterInFlight = new Set<string>()
const posterFailed = new Set<string>()

/**
 * GLB tile: shows the stored poster, or renders one (queued, once) and saves it
 * to the library so it is instant on every later visit.
 */
function ModelPoster({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(() => posterFailed.has(item.id))

  useEffect(() => {
    if (item.thumbUrl || posterInFlight.has(item.id) || posterFailed.has(item.id)) return
    posterInFlight.add(item.id)
    void renderGlbPoster(item.url).then(async (blob) => {
      posterInFlight.delete(item.id)
      if (blob) await library.update(item.id, { thumb: blob })
      else { posterFailed.add(item.id); setFailed(true) }
    })
  }, [item.id, item.url, item.thumbUrl])

  if (item.thumbUrl) {
    return (
      <>
        <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" className="absolute inset-0 h-full w-full object-contain" />
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 font-mono text-[9.5px] text-white/85">3D</span>
      </>
    )
  }
  return (
    <div className="absolute inset-0 grid place-items-center text-ink-faint">
      <div className="flex flex-col items-center gap-1.5">
        <Boxes size={22} className={clsx(!failed && 'animate-pulse')} />
        <span className="font-mono text-[10px]">{failed ? 'GLB · no preview' : 'Rendering preview…'}</span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ grid facade */

/** Grid of generated artifacts with preview + per-item actions. */
export function ArtifactGrid({ items, onReuse, onDelete, columns = 4, empty, onOpen, selected, onToggleSelect, extraActions }: {
  items: MediaItem[]
  onReuse?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  /** Approximate number of tiles per row (density). */
  columns?: number
  empty?: { title: string; detail?: string }
  /** Replaces the built-in preview modal when set. */
  onOpen?: (item: MediaItem) => void
  selected?: ReadonlySet<string>
  onToggleSelect?: (item: MediaItem) => void
  extraActions?: (item: MediaItem) => ReactNode
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)

  if (!items.length) {
    return <EmptyState title={empty?.title ?? 'Nothing here yet'} detail={empty?.detail} />
  }

  return (
    <>
      <JustifiedGrid items={items} columns={columns} ratioOf={ratioForLayout}>
        {(item) => (
          <ArtifactTile
            item={item}
            onOpen={onOpen ?? ((i) => setPreviewId(i.id))}
            onReuse={onReuse}
            onDelete={onDelete}
            selected={selected?.has(item.id)}
            onToggleSelect={onToggleSelect}
            extraActions={extraActions}
          />
        )}
      </JustifiedGrid>

      {!onOpen && (
        <ArtifactModal
          item={items.find((i) => i.id === previewId) ?? null}
          items={items}
          onSelect={(i) => setPreviewId(i.id)}
          onClose={() => setPreviewId(null)}
          onReuse={onReuse}
        />
      )}
    </>
  )
}

/** Layout-time ratio (sync): stored/measured dimensions, else square until measured. */
export function ratioForLayout(item: MediaItem): number {
  return knownRatio(item) ?? 1
}

/* ------------------------------------------------------------------ modal */

export function ArtifactModal({ item, items, onSelect, onClose, onReuse }: {
  item: MediaItem | null
  /** Sibling items enabling prev/next (buttons + ←/→ keys). */
  items?: MediaItem[]
  onSelect?: (item: MediaItem) => void
  onClose: () => void
  onReuse?: (item: MediaItem) => void
}) {
  const { confirmDeletes } = useApp()
  const navigate = useNavigate()
  const index = item && items ? items.findIndex((i) => i.id === item.id) : -1
  const prev = index > 0 && items ? items[index - 1] : null
  const next = index >= 0 && items && index < items.length - 1 ? items[index + 1] : null

  useEffect(() => {
    if (!item || !onSelect) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft' && prev) onSelect(prev)
      if (e.key === 'ArrowRight' && next) onSelect(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [item, prev, next, onSelect])

  if (!item) return null

  const sendTo = (target: HandoffTarget) => {
    handOffImage(target, item.blob)
    onClose()
    void navigate({ to: HANDOFF_ROUTES[target] })
  }

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title={
        <span className="flex items-center gap-2">
          {item.name || `Generated ${item.kind}`}
          {index >= 0 && items && <span className="text-[11px] font-normal text-ink-faint">{index + 1} / {items.length}</span>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={async () => {
            if (confirmDeletes && !confirm('Delete this item?')) return
            const fallback = next ?? prev
            await library.remove(item.id)
            if (fallback && onSelect) onSelect(fallback)
            else onClose()
          }}>Delete</Button>
          {onReuse && <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={() => { onReuse(item); onClose() }}>Reuse settings</Button>}
          {item.kind === 'image' && (
            <>
              <Button variant="outline" size="sm" icon={<Wand2 size={14} />} onClick={() => sendTo('edit')} title="Open in Edit as the source image">Edit</Button>
              <Button variant="outline" size="sm" icon={<ScanEye size={14} />} onClick={() => sendTo('vision')} title="Describe with Vision">Vision</Button>
              <Button variant="outline" size="sm" icon={<Clapperboard size={14} />} onClick={() => sendTo('video')} title="Animate (image to video)">Animate</Button>
              <Button variant="outline" size="sm" icon={<Boxes size={14} />} onClick={() => sendTo('3d')} title="Image to 3D model">3D</Button>
            </>
          )}
          <Button variant="primary" size="sm" icon={<Download size={14} />} onClick={() => downloadBlob(item.blob, itemFilename(item))}>Download</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className={clsx('relative grid min-h-[50vh] place-items-center rounded-xl bg-bg p-3', item.kind !== 'model3d' && 'checker')}>
          {item.kind === 'image' && (
            <img src={item.url} alt="" className={clsx('max-h-[70vh] max-w-full object-contain', isTinyImage(item) && 'min-w-[256px] [image-rendering:pixelated]')} />
          )}
          {item.kind === 'video' && <video src={item.url} controls autoPlay loop className="max-h-[70vh] max-w-full rounded-lg" />}
          {item.kind === 'audio' && <audio src={item.url} controls autoPlay className="w-full" />}
          {item.kind === 'model3d' && (
            <div className="h-[70vh] w-full">
              <ModelViewer key={item.id} src={item.url} toolbar className="h-full w-full" />
            </div>
          )}
          {prev && onSelect && (
            <button onClick={() => onSelect(prev)} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80" aria-label="Previous">
              <ChevronLeft size={18} />
            </button>
          )}
          {next && onSelect && (
            <button onClick={() => onSelect(next)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80" aria-label="Next">
              <ChevronRight size={18} />
            </button>
          )}
        </div>
        <dl className="space-y-3 text-[12.5px]">
          <Row label="Source" value={item.source} />
          <Row label="Model" value={item.model} />
          <Row label="Size" value={formatBytes(item.blob.size)} />
          {item.width && item.height ? <Row label="Dimensions" value={`${item.width} × ${item.height}`} /> : null}
          {item.seed != null && <Row label="Seed" value={String(item.seed)} />}
          {item.durationSeconds != null && <Row label="Duration" value={formatDuration(item.durationSeconds)} />}
          <Row label="Created" value={new Date(item.createdAt).toLocaleString()} />
          {item.prompt && <Row label="Prompt" value={item.prompt} mono copy />}
          {item.negativePrompt && <Row label="Negative" value={item.negativePrompt} mono copy />}
        </dl>
      </div>
    </Modal>
  )
}

function Row({ label, value, mono, copy }: { label: string; value?: string | null; mono?: boolean; copy?: boolean }) {
  if (value == null || value === '') return null
  return (
    <div>
      <dt className="flex items-center justify-between text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">
        {label}
        {copy && (
          <button className="font-normal normal-case text-ink-faint hover:text-ink" onClick={() => void navigator.clipboard.writeText(value)}>copy</button>
        )}
      </dt>
      <dd className={clsx('break-words', mono && 'font-mono text-[11.5px] text-ink-dim')}>{value}</dd>
    </div>
  )
}
