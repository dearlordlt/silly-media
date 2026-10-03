import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ButtonHTMLAttributes, MouseEvent, ReactNode } from 'react'
import { clsx } from 'clsx'
import { useNavigate } from '@tanstack/react-router'
import { Boxes, Check, ChevronLeft, ChevronRight, Clapperboard, Download, Heart, RotateCcw, ScanEye, Send, Star, Trash2, Wand2 } from 'lucide-react'
import { HANDOFF_ROUTES, handOffItem, type HandoffTarget } from '../lib/handoff'
import { ModelViewer, renderGlbPoster } from './ModelViewer'
import type { MediaItem } from '../lib/library'
import { downloadItem, library } from '../lib/library'
import { formatBytes, formatDuration } from '../lib/media'
import { startItemDrag } from '../lib/drag'
import { useCommands } from '../lib/commands'
import type { Command } from '../lib/commands'
import { Modal } from './ui/Modal'
import { Button, EmptyState } from './ui/primitives'
import { useApp } from '../lib/store'
import { AudioRow, claimPlayback } from './AudioRow'
import { TagEditor } from './TagEditor'
import { KIND_LABEL, itemTitle, modelLabel, relativeTime, removeItem } from './itemMeta'

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

/* ------------------------------------------------------------- send to… */

const SEND_TARGETS: { target: HandoffTarget; label: string; icon: ReactNode; key: string; hint: string }[] = [
  { target: 'edit', label: 'Edit', icon: <Wand2 size={14} />, key: 'E', hint: 'Open in Edit as the source image' },
  { target: 'vision', label: 'Vision', icon: <ScanEye size={14} />, key: 'V', hint: 'Describe with Vision' },
  { target: 'video', label: 'Animate', icon: <Clapperboard size={14} />, key: 'A', hint: 'Animate (image to video)' },
  { target: '3d', label: '3D', icon: <Boxes size={14} />, key: '3', hint: 'Image to 3D model' },
]

/** "Send to" button + menu for image tiles (stays open independently of hover). */
function SendToMenu({ item, onOpenChange }: { item: MediaItem; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const [open, setOpenState] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const setOpen = (v: boolean) => { setOpenState(v); onOpenChange(v) }
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      setOpenRef.current(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenRef.current(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <OverlayButton onClick={() => setOpen(!open)} title="Send to…" active={open}><Send size={13} /></OverlayButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-line bg-panel-2 py-1 shadow-2xl">
          {SEND_TARGETS.map((t) => (
            <button
              key={t.target}
              title={t.hint}
              onClick={() => {
                setOpen(false)
                handOffItem(t.target, item)
                void navigate({ to: HANDOFF_ROUTES[t.target] })
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-ink-dim hover:bg-panel-3 hover:text-ink"
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function OverlayButton({ children, active, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      {...rest}
      className={clsx(
        'grid h-7 w-7 place-items-center rounded-md text-white/85 transition-colors hover:bg-white/15 hover:text-white',
        active && 'bg-white/20 text-white',
        className,
      )}
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------- the tile */

export interface ArtifactTileProps {
  item: MediaItem
  onOpen: (item: MediaItem) => void
  onReuse?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  selected?: boolean
  /** The click event is passed so callers can implement Shift-click ranges. */
  onToggleSelect?: (item: MediaItem, e: MouseEvent) => void
  extraActions?: (item: MediaItem) => ReactNode
}

export function ArtifactTile({ item, onOpen, onReuse, onDelete, selected, onToggleSelect, extraActions }: ArtifactTileProps) {
  const ratio = useMediaRatio(item)
  const { confirmDeletes } = useApp()
  const [menuOpen, setMenuOpen] = useState(false)
  const title = itemTitle(item)
  const model = modelLabel(item.model)

  return (
    <div
      draggable
      onDragStart={(e) => startItemDrag(e, item)}
      className={clsx(
        'group relative flex flex-col rounded-xl border bg-panel transition-colors',
        selected ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong',
      )}
    >
      <div className="relative overflow-hidden rounded-t-[11px]">
        <button className="block w-full" onClick={() => onOpen(item)} aria-label={`Open ${title}`}>
          <div
            className={clsx('relative w-full bg-bg', item.kind === 'model3d' ? 'bg-[radial-gradient(ellipse_at_center,#232a3a_0%,#0f1219_75%)]' : 'checker')}
            style={{ aspectRatio: String(tileRatio(ratio)) }}
          >
            <MediaThumb item={item} />
          </div>
        </button>

        {/* Hover: the full prompt over a gradient; clicks fall through to the media. */}
        {item.prompt && (
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-end bg-gradient-to-t from-black/85 via-black/25 to-transparent p-2.5 opacity-0 transition-opacity group-hover:opacity-100">
            <p className="line-clamp-4 text-[11px] leading-snug text-white/90">{item.prompt}</p>
          </div>
        )}
      </div>

      {onToggleSelect && (
        <button
          onClick={(e) => { e.stopPropagation(); onToggleSelect(item, e) }}
          className={clsx(
            'absolute left-2 top-2 grid h-5 w-5 place-items-center rounded border transition-opacity',
            selected ? 'border-accent bg-accent text-white' : 'border-white/50 bg-black/50 text-transparent opacity-0 group-hover:opacity-100',
          )}
          aria-label={selected ? 'Deselect' : 'Select'}
          title="Select (Shift-click for a range)"
        >
          <Check size={12} />
        </button>
      )}

      {item.favorite && (
        <Star size={14} className={clsx('pointer-events-none absolute right-2 top-2 fill-warn text-warn drop-shadow transition-opacity', 'group-hover:opacity-0', menuOpen && 'opacity-0')} />
      )}

      <div className={clsx(
        'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-lg bg-black/60 p-0.5 backdrop-blur-sm transition-opacity',
        '[&_button]:text-white/85',
        menuOpen ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
      )}>
        {extraActions?.(item)}
        {onReuse && <OverlayButton onClick={() => onReuse(item)} title="Reuse settings"><RotateCcw size={13} /></OverlayButton>}
        <OverlayButton onClick={() => void library.update(item.id, { favorite: !item.favorite })} title={item.favorite ? 'Unfavourite' : 'Favourite'}>
          <Heart size={13} className={clsx(item.favorite && 'fill-warn text-warn')} />
        </OverlayButton>
        <OverlayButton onClick={() => downloadItem(item)} title="Download"><Download size={13} /></OverlayButton>
        {item.kind === 'image' && <SendToMenu item={item} onOpenChange={setMenuOpen} />}
        <OverlayButton onClick={() => void removeItem(item, confirmDeletes, onDelete)} title="Delete" className="hover:!text-bad">
          <Trash2 size={13} />
        </OverlayButton>
      </div>

      <div className="px-2.5 pb-2 pt-1.5">
        <div className="line-clamp-2 h-[2.6em] text-[12px] leading-[1.3] text-ink" title={item.prompt ?? title}>{title}</div>
        <div className="mt-1 flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[10.5px] text-ink-faint">
          <span className="shrink-0 rounded bg-panel-3 px-1.5 py-px font-medium text-ink-dim">{KIND_LABEL[item.kind]}</span>
          {model && <span className="min-w-0 truncate rounded border border-line px-1.5 py-px" title={item.model}>{model}</span>}
          <span className="ml-auto shrink-0 pl-1" title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}

/** Media fills its (correctly proportioned) box; contain guarantees no distortion. */
export function MediaThumb({ item }: { item: MediaItem }) {
  const fill = 'absolute inset-0 h-full w-full object-contain'
  if (item.kind === 'image') {
    return (
      <img
        src={item.thumbUrl ?? item.url} alt="" loading="lazy" decoding="async" draggable={false}
        className={clsx(fill, isTinyImage(item) && '[image-rendering:pixelated]')}
      />
    )
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
    return <img src={item.thumbUrl} alt="" loading="lazy" decoding="async" draggable={false} className="absolute inset-0 h-full w-full object-contain" />
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

/**
 * Grid of generated artifacts with preview + per-item actions. Visual media
 * flows in justified rows; audio renders as compact full-width rows. Mixed
 * lists keep their order (consecutive runs of each kind are grouped).
 */
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
  /** The click event is passed so callers can implement Shift-click ranges. */
  onToggleSelect?: (item: MediaItem, e: MouseEvent) => void
  extraActions?: (item: MediaItem) => ReactNode
}) {
  const [previewId, setPreviewId] = useState<string | null>(null)

  const runs = useMemo(() => {
    const out: { audio: boolean; items: MediaItem[] }[] = []
    for (const it of items) {
      const audio = it.kind === 'audio'
      const last = out[out.length - 1]
      if (last && last.audio === audio) last.items.push(it)
      else out.push({ audio, items: [it] })
    }
    return out
  }, [items])

  if (!items.length) {
    return <EmptyState title={empty?.title ?? 'Nothing here yet'} detail={empty?.detail} />
  }

  const open = onOpen ?? ((i: MediaItem) => setPreviewId(i.id))

  return (
    <>
      <div className="flex flex-col gap-3">
        {runs.map((run) => run.audio ? (
          <div key={run.items[0].id} className="flex flex-col gap-1.5">
            {run.items.map((item) => (
              <AudioRow
                key={item.id}
                item={item}
                onOpen={open}
                onReuse={onReuse}
                onDelete={onDelete}
                selected={selected?.has(item.id)}
                onToggleSelect={onToggleSelect}
                extraActions={extraActions}
              />
            ))}
          </div>
        ) : (
          <JustifiedGrid key={run.items[0].id} items={run.items} columns={columns} ratioOf={ratioForLayout}>
            {(item) => (
              <ArtifactTile
                item={item}
                onOpen={open}
                onReuse={onReuse}
                onDelete={onDelete}
                selected={selected?.has(item.id)}
                onToggleSelect={onToggleSelect}
                extraActions={extraActions}
              />
            )}
          </JustifiedGrid>
        ))}
      </div>

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

/**
 * Item viewer. Keys: ←/→ browse, F favourite, D download, E edit, V vision,
 * A animate, 3 image→3D (images only), Del delete. The same actions are in
 * the command palette while it is open.
 */
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

  const sendTo = (it: MediaItem, target: HandoffTarget) => {
    handOffItem(target, it)
    onClose()
    void navigate({ to: HANDOFF_ROUTES[target] })
  }

  const remove = async (it: MediaItem) => {
    if (confirmDeletes && !confirm('Delete this item?')) return
    const fallback = next ?? prev
    await library.remove(it.id)
    if (fallback && onSelect) onSelect(fallback)
    else onClose()
  }

  // Single source for keys + palette: [key, command].
  const actions: [string, Command][] = []
  if (item) {
    if (prev && onSelect) actions.push(['arrowleft', { id: 'library.viewer.prev', label: 'Previous item', group: 'Viewer', shortcut: '←', run: () => onSelect(prev) }])
    if (next && onSelect) actions.push(['arrowright', { id: 'library.viewer.next', label: 'Next item', group: 'Viewer', shortcut: '→', run: () => onSelect(next) }])
    actions.push(
      ['f', { id: 'library.viewer.favorite', label: item.favorite ? 'Unfavourite item' : 'Favourite item', group: 'Viewer', shortcut: 'F', run: () => void library.update(item.id, { favorite: !item.favorite }) }],
      ['d', { id: 'library.viewer.download', label: 'Download item', group: 'Viewer', shortcut: 'D', run: () => downloadItem(item) }],
    )
    if (item.kind === 'image') {
      for (const t of SEND_TARGETS) {
        actions.push([t.key.toLowerCase(), {
          id: `library.viewer.${t.target}`, label: `${t.label}: ${t.hint}`, group: 'Viewer', shortcut: t.key, keywords: 'send to', run: () => sendTo(item, t.target),
        }])
      }
    }
    actions.push(['delete', { id: 'library.viewer.delete', label: 'Delete item', group: 'Viewer', shortcut: 'Del', run: () => void remove(item) }])
  }

  useCommands(actions.map(([, c]) => c))

  const keyRef = useRef(actions)
  keyRef.current = actions
  const open = item != null
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return
      const hit = keyRef.current.find(([k]) => k === e.key.toLowerCase())
      if (!hit) return
      e.preventDefault()
      hit[1].run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (!item) return null

  const title = itemTitle(item)

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="max-w-[60ch] truncate" title={title}>{title}</span>
          <span className="shrink-0 rounded bg-panel-3 px-1.5 py-px text-[10.5px] font-medium text-ink-dim">{KIND_LABEL[item.kind]}</span>
          {index >= 0 && items && <span className="shrink-0 text-[11px] font-normal text-ink-faint">{index + 1} / {items.length}</span>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => void remove(item)} title="Delete (Del)">Delete</Button>
          <Button
            variant="ghost" size="sm"
            icon={<Heart size={14} className={clsx(item.favorite && 'fill-warn text-warn')} />}
            onClick={() => void library.update(item.id, { favorite: !item.favorite })}
            title={`${item.favorite ? 'Unfavourite' : 'Favourite'} (F)`}
          >
            {item.favorite ? 'Favourited' : 'Favourite'}
          </Button>
          <span className="flex-1" />
          {onReuse && <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={() => { onReuse(item); onClose() }}>Reuse settings</Button>}
          {item.kind === 'image' && SEND_TARGETS.map((t) => (
            <Button key={t.target} variant="outline" size="sm" icon={t.icon} onClick={() => sendTo(item, t.target)} title={`${t.hint} (${t.key})`}>{t.label}</Button>
          ))}
          <Button variant="primary" size="sm" icon={<Download size={14} />} onClick={() => downloadItem(item)} title="Download (D)">Download</Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[1fr_300px]">
        <div className={clsx('relative grid min-h-[50vh] place-items-center rounded-xl bg-bg p-3', item.kind !== 'model3d' && 'checker')}>
          {item.kind === 'image' && (
            <img src={item.url} alt="" className={clsx('max-h-[70vh] max-w-full object-contain', isTinyImage(item) && 'min-w-[256px] [image-rendering:pixelated]')} />
          )}
          {item.kind === 'video' && <video src={item.url} controls autoPlay loop className="max-h-[70vh] max-w-full rounded-lg" />}
          {item.kind === 'audio' && <audio src={item.url} controls autoPlay className="w-full" onPlay={(e) => claimPlayback(e.currentTarget)} />}
          {item.kind === 'model3d' && (
            <div className="h-[70vh] w-full">
              <ModelViewer key={item.id} src={item.url} toolbar className="h-full w-full" />
            </div>
          )}
          {prev && onSelect && (
            <button onClick={() => onSelect(prev)} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80" aria-label="Previous" title="Previous (←)">
              <ChevronLeft size={18} />
            </button>
          )}
          {next && onSelect && (
            <button onClick={() => onSelect(next)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/60 p-2 text-white hover:bg-black/80" aria-label="Next" title="Next (→)">
              <ChevronRight size={18} />
            </button>
          )}
        </div>
        <div className="space-y-4">
          <div>
            <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint">Tags</div>
            <TagEditor key={item.id} tags={item.tags} onChange={(tags) => void library.update(item.id, { tags })} />
          </div>
          <dl className="space-y-3 text-[12.5px]">
            <Row label="Source" value={item.source} />
            <Row label="Model" value={item.model} />
            <Row label="Size" value={formatBytes(item.size)} />
            {item.width && item.height ? <Row label="Dimensions" value={`${item.width} × ${item.height}`} /> : null}
            {item.seed != null && <Row label="Seed" value={String(item.seed)} />}
            {item.durationSeconds != null && <Row label="Duration" value={formatDuration(item.durationSeconds)} />}
            <Row label="Created" value={new Date(item.createdAt).toLocaleString()} />
            {item.name && item.name !== title && <Row label="Name" value={item.name} />}
            {item.prompt && <Row label="Prompt" value={item.prompt} mono copy />}
            {item.negativePrompt && <Row label="Negative" value={item.negativePrompt} mono copy />}
          </dl>
        </div>
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
