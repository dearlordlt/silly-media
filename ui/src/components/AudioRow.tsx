/**
 * Compact full-width row for audio items: inline play/pause, a waveform with
 * progress + click-to-seek, duration, title, voice/model, time and actions.
 *
 * Waveform peaks are decoded once per item and cached in `item.meta.peaks`
 * (with the duration backfilled), so later renders never decode again.
 * Only one row (or viewer) plays at a time.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { clsx } from 'clsx'
import { Check, Download, Heart, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { downloadItem, itemBlob, library } from '../lib/library'
import type { MediaItem } from '../lib/library'
import { useApp } from '../lib/store'
import { IconButton } from './ui/primitives'
import { itemTitle, modelLabel, relativeTime, removeItem, voiceLabel } from './itemMeta'

const PEAK_COUNT = 120

/* ------------------------------------------------------- single playback */

let playing: HTMLMediaElement | null = null

/** Call from a media element's `play` event: pauses whatever else was playing. */
export function claimPlayback(el: HTMLMediaElement): void {
  if (playing && playing !== el) playing.pause()
  playing = el
}

/* ----------------------------------------------------------------- peaks */

function isPeaks(v: unknown): v is number[] {
  return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'number')
}

let decoder: OfflineAudioContext | null = null
let decodeQueue: Promise<unknown> = Promise.resolve()
/** One decode per item per session; failures stay cached (as null) so they aren't retried. */
const peakJobs = new Map<string, Promise<number[] | null>>()

function computePeaks(buf: AudioBuffer): number[] {
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c))
  const block = Math.max(1, Math.floor(buf.length / PEAK_COUNT))
  // Stride through long blocks: peaks stay representative at a fraction of the work.
  const stride = Math.max(1, Math.floor(block / 2048))
  const raw: number[] = []
  for (let i = 0; i < PEAK_COUNT; i++) {
    const end = Math.min(buf.length, (i + 1) * block)
    let max = 0
    for (const data of channels) {
      for (let j = i * block; j < end; j += stride) {
        const v = Math.abs(data[j])
        if (v > max) max = v
      }
    }
    raw.push(max)
  }
  const top = Math.max(...raw) || 1
  return raw.map((v) => Math.round((v / top) * 100) / 100)
}

/** Decode (serialized, once) and persist peaks + duration on the item. */
function loadPeaks(item: MediaItem): Promise<number[] | null> {
  const existing = peakJobs.get(item.id)
  if (existing) return existing
  const job = decodeQueue.then(async () => {
    const bytes = await (await itemBlob(item)).arrayBuffer()
    decoder ??= new OfflineAudioContext(1, 1, 44100)
    const buf = await decoder.decodeAudioData(bytes)
    const peaks = computePeaks(buf)
    const latest = library.get(item.id)
    if (latest) {
      await library.update(item.id, {
        meta: { ...latest.meta, peaks },
        ...(latest.durationSeconds == null && Number.isFinite(buf.duration) ? { durationSeconds: buf.duration } : {}),
      })
    }
    return peaks
  }).catch(() => null)
  decodeQueue = job
  peakJobs.set(item.id, job)
  return job
}

/* -------------------------------------------------------------- waveform */

function Waveform({ peaks, progress, onSeek }: { peaks: number[] | null; progress: number; onSeek: (fraction: number) => void }) {
  const clipId = useId()
  const bars = peaks ?? Array.from({ length: PEAK_COUNT }, () => 0.06)
  const w = bars.length
  // One path for all bars; drawn twice (base + clipped progress) instead of 2×120 elements.
  const d = bars.map((v, i) => {
    const h = Math.max(6, v * 100)
    return `M${i + 0.15} ${(100 - h) / 2}h0.7v${h}h-0.7z`
  }).join('')
  return (
    <svg
      viewBox={`0 0 ${w} 100`}
      preserveAspectRatio="none"
      className={clsx('h-9 min-w-0 flex-1 cursor-pointer', !peaks && 'animate-pulse')}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)))
      }}
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <defs>
        <clipPath id={clipId}><rect x={0} y={0} width={progress * w} height={100} /></clipPath>
      </defs>
      <path d={d} className="fill-ink-faint/45" />
      <path d={d} className="fill-accent" clipPath={`url(#${clipId})`} />
    </svg>
  )
}

const clock = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return '0:00'
  const t = Math.round(s)
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`
}

/* ------------------------------------------------------------------- row */

export function AudioRow({ item, onOpen, onReuse, onDelete, selected, onToggleSelect, extraActions }: {
  item: MediaItem
  onOpen: (item: MediaItem) => void
  onReuse?: (item: MediaItem) => void
  onDelete?: (item: MediaItem) => void
  selected?: boolean
  onToggleSelect?: (item: MediaItem, e: MouseEvent) => void
  extraActions?: (item: MediaItem) => ReactNode
}) {
  const { confirmDeletes } = useApp()
  const rowRef = useRef<HTMLDivElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const pendingSeek = useRef<number | null>(null)
  const [isPlaying, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  const rawPeaks = item.meta?.peaks
  const peaks = isPeaks(rawPeaks) ? rawPeaks : null
  const duration = item.durationSeconds ?? mediaDuration

  // Decode peaks once the row scrolls into view.
  useEffect(() => {
    const el = rowRef.current
    if (peaks || !el) return
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return
      io.disconnect()
      void loadPeaks(item)
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => io.disconnect()
  }, [item, peaks])

  // Smooth progress while playing (timeupdate is only ~4 Hz).
  useEffect(() => {
    if (!isPlaying) return
    let raf = 0
    const tick = () => {
      if (audioRef.current) setTime(audioRef.current.currentTime)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [isPlaying])

  useEffect(() => () => {
    const el = audioRef.current
    if (el && playing === el) { el.pause(); playing = null }
  }, [])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (a.paused) void a.play().catch(() => undefined)
    else a.pause()
  }

  const seek = (fraction: number) => {
    const a = audioRef.current
    if (!a) return
    const d = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : duration
    if (d > 0) { a.currentTime = fraction * d; setTime(fraction * d) }
    else pendingSeek.current = fraction
    if (a.paused) void a.play().catch(() => undefined)
  }

  const title = itemTitle(item)
  const sub = [voiceLabel(item), modelLabel(item.model)].filter(Boolean).join(' · ')

  return (
    <div
      ref={rowRef}
      className={clsx(
        'group flex items-center gap-3 rounded-xl border bg-panel px-3 py-2 transition-colors',
        selected ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-line-strong',
      )}
    >
      <audio
        ref={audioRef}
        src={item.url}
        preload="none"
        onPlay={(e) => { claimPlayback(e.currentTarget); setPlaying(true) }}
        onPause={(e) => { setPlaying(false); setTime(e.currentTarget.currentTime) }}
        onEnded={(e) => { setPlaying(false); e.currentTarget.currentTime = 0; setTime(0) }}
        onLoadedMetadata={(e) => {
          const a = e.currentTarget
          if (Number.isFinite(a.duration)) setMediaDuration(a.duration)
          if (pendingSeek.current != null && Number.isFinite(a.duration)) {
            a.currentTime = pendingSeek.current * a.duration
            pendingSeek.current = null
          }
        }}
      />

      {onToggleSelect && (
        <button
          onClick={(e) => onToggleSelect(item, e)}
          className={clsx(
            'grid h-4 w-4 shrink-0 place-items-center rounded border transition-opacity',
            selected ? 'border-accent bg-accent text-white' : 'border-line-strong text-transparent opacity-40 group-hover:opacity-100',
          )}
          aria-label={selected ? 'Deselect' : 'Select'}
          title="Select (Shift-click for a range)"
        >
          <Check size={11} />
        </button>
      )}

      <button
        onClick={toggle}
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-white transition hover:brightness-110"
        aria-label={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <Pause size={15} className="fill-current" /> : <Play size={15} className="ml-0.5 fill-current" />}
      </button>

      <div className="min-w-0 max-w-xs shrink basis-1/3">
        <button
          onClick={() => onOpen(item)}
          className="block w-full truncate text-left text-[12.5px] text-ink hover:text-accent"
          title={item.prompt ?? item.name}
        >
          {title}
        </button>
        <div className="flex items-center gap-1.5 truncate text-[11px] text-ink-faint">
          {item.favorite && <Heart size={10} className="shrink-0 fill-warn text-warn" />}
          {sub && <span className="truncate" title={sub}>{sub}</span>}
          {sub && <span>·</span>}
          <span className="shrink-0" title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</span>
        </div>
      </div>

      <Waveform peaks={peaks} progress={duration > 0 ? Math.min(1, time / duration) : 0} onSeek={seek} />

      <span className="w-[5.5rem] shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-faint">
        {isPlaying || time > 0 ? `${clock(time)} / ` : ''}{clock(duration)}
      </span>

      <div className="flex shrink-0 items-center opacity-60 transition-opacity group-hover:opacity-100">
        {extraActions?.(item)}
        {onReuse && <IconButton onClick={() => onReuse(item)} title="Reuse settings"><RotateCcw size={14} /></IconButton>}
        <IconButton onClick={() => void library.update(item.id, { favorite: !item.favorite })} title={item.favorite ? 'Unfavourite' : 'Favourite'}>
          <Heart size={14} className={clsx(item.favorite && 'fill-warn text-warn')} />
        </IconButton>
        <IconButton onClick={() => downloadItem(item)} title="Download"><Download size={14} /></IconButton>
        <IconButton onClick={() => void removeItem(item, confirmDeletes, onDelete)} title="Delete"><Trash2 size={14} /></IconButton>
      </div>
    </div>
  )
}
