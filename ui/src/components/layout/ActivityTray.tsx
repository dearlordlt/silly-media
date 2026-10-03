/**
 * Header activity tray: one pill that combines GPU state (loaded models,
 * backend health) with the app-wide job queue, opening a popover with the
 * running / queued / recently finished jobs.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { clsx } from 'clsx'
import { create } from 'zustand'
import {
  AlertTriangle, ArrowDown, ArrowUp, AudioLines, Ban, Bell, BellOff, Box, Boxes, CheckCircle2,
  ChevronDown, Clapperboard, Clock, Cpu, Film, Gamepad2, Hourglass, ImagePlus, Loader2, MessageSquare,
  Mic2, Music2, RotateCcw, ScanEye, Trash2, Wand2, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { jobs, notificationsEnabled, setNotifications, useJobs } from '../../lib/jobs'
import type { Job, JobPage } from '../../lib/jobs'
import { useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { useHealth } from '../../lib/query'
import { toast } from '../../lib/hooks'
import { useElapsed } from '../Progress'
import { Button, IconButton, ProgressBar } from '../ui/primitives'

export type JobRoute = '/studio' | '/edit' | '/assets' | '/audio' | '/music' | '/video' | '/3d' | '/vision' | '/chat'

/** Route, name and icon of every page that can own jobs. */
export const PAGE_META: Record<JobPage, { to: JobRoute; label: string; Icon: LucideIcon }> = {
  studio: { to: '/studio', label: 'Studio', Icon: ImagePlus },
  edit: { to: '/edit', label: 'Edit', Icon: Wand2 },
  assets: { to: '/assets', label: 'Game Assets', Icon: Gamepad2 },
  audio: { to: '/audio', label: 'Speech', Icon: Mic2 },
  music: { to: '/music', label: 'Music', Icon: Music2 },
  video: { to: '/video', label: 'Video', Icon: Clapperboard },
  '3d': { to: '/3d', label: '3D Models', Icon: Boxes },
  vision: { to: '/vision', label: 'Vision', Icon: ScanEye },
  chat: { to: '/chat', label: 'Chat', Icon: MessageSquare },
}

interface TrayState {
  open: boolean
  /** When the tray was last opened; finished jobs after this are "unseen". */
  seenAt: number
  setOpen: (open: boolean) => void
}

/** Tray visibility (shared so the palette and the home page can open it). */
export const useTray = create<TrayState>()((set) => ({
  open: false,
  seenAt: Date.now(),
  setOpen: (open) => set(open ? { open, seenAt: Date.now() } : { open }),
}))

const isFinished = (j: Job) => j.state === 'done' || j.state === 'failed' || j.state === 'cancelled'

function ago(ts: number | undefined): string {
  if (!ts) return ''
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function duration(job: Job): string {
  if (!job.startedAt || !job.finishedAt) return ''
  const s = Math.round((job.finishedAt - job.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function ActivityTray() {
  const open = useTray((s) => s.open)
  const seenAt = useTray((s) => s.seenAt)
  const setOpen = useTray((s) => s.setOpen)
  const all = useJobs()
  const { data: health, isError } = useHealth()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  const running = all.filter((j) => j.state === 'running')
  const queuedCount = all.filter((j) => j.state === 'queued').length
  const unseen = all.filter((j) => isFinished(j) && j.state !== 'cancelled' && (j.finishedAt ?? 0) > seenAt)
  const unseenFailed = unseen.some((j) => j.state === 'failed')

  const loaded = health?.models_loaded ?? []
  const current = running[running.length - 1]
  const gpuText = isError ? 'Backend offline' : current ? current.label : loaded.length ? loaded.join(', ') : 'GPU idle'
  const tooltip = [
    isError ? 'Backend offline' : loaded.length ? `Loaded: ${loaded.join(', ')}` : 'No model in VRAM',
    running.length ? `${running.length} running` : null,
    queuedCount ? `${queuedCount} queued` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={tooltip}
        className={clsx(
          'relative flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[11.5px] transition-colors',
          open ? 'border-line-strong bg-panel-2' : 'border-line bg-bg hover:border-line-strong',
        )}
      >
        {running.length
          ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
          : <Cpu size={13} className={clsx('shrink-0', isError ? 'text-bad' : loaded.length ? 'text-accent-2' : 'text-ink-faint')} />}
        <span className={clsx(
          'max-w-[200px] truncate font-medium',
          isError ? 'text-bad' : running.length ? 'text-ink' : loaded.length ? 'text-accent-2' : 'text-ink-dim',
        )}>
          {gpuText}
        </span>
        {(running.length > 0 || queuedCount > 0) && (
          <span className="flex shrink-0 items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10.5px] font-semibold text-accent">
            {running.length > 0 && <span>{running.length} running</span>}
            {running.length > 0 && queuedCount > 0 && <span className="text-accent/60">·</span>}
            {queuedCount > 0 && <span>{queuedCount} queued</span>}
          </span>
        )}
        <ChevronDown size={12} className={clsx('shrink-0 text-ink-faint transition-transform', open && 'rotate-180')} />
        {unseen.length > 0 && !open && (
          <span className={clsx(
            'absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full ring-2 ring-panel',
            unseenFailed ? 'bg-bad' : 'bg-good',
          )} />
        )}
      </button>

      {open && <TrayPanel all={all} loaded={loaded} offline={isError} onClose={() => setOpen(false)} />}
    </div>
  )
}

function TrayPanel({ all, loaded, offline, onClose }: { all: Job[]; loaded: string[]; offline: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const items = useLibrary()
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const [notify, setNotify] = useState(notificationsEnabled)
  const notifySupported = typeof Notification !== 'undefined'

  const running = all.filter((j) => j.state === 'running')
  // `all` is newest-first; the queue reads in execution order (FIFO).
  const queued = all.filter((j) => j.state === 'queued').reverse()
  const gpuQueued = queued.filter((j) => j.lane === 'gpu')
  const finished = all.filter(isFinished)

  const goPage = (job: Job) => { onClose(); void navigate({ to: PAGE_META[job.page].to }) }
  const openItem = (id: string) => { onClose(); void navigate({ to: '/library', search: { item: id } }) }

  const toggleNotify = () => {
    const want = !notify
    // Must run inside the click: the permission prompt needs a user gesture.
    void setNotifications(want).then((ok) => {
      setNotify(ok)
      if (want && !ok) toast.error('Notifications blocked', 'Allow notifications for this site in the browser settings.')
    })
  }

  return (
    <div className="animate-in absolute right-0 top-full z-40 mt-2 flex max-h-[75vh] w-[440px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl shadow-black/50">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">Activity</div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-faint">
            <Cpu size={11} className={offline ? 'text-bad' : loaded.length ? 'text-accent-2' : undefined} />
            {offline ? 'Backend offline' : loaded.length ? `In VRAM: ${loaded.join(', ')}` : 'GPU idle — no model loaded'}
          </div>
        </div>
        <button
          onClick={toggleNotify}
          disabled={!notifySupported}
          title={notifySupported ? 'Desktop notification when a job finishes while this tab is in the background' : 'Notifications are not supported here'}
          className={clsx(
            'flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] transition-colors disabled:opacity-40',
            notify ? 'border-accent/40 bg-accent/15 text-ink' : 'border-line text-ink-dim hover:text-ink',
          )}
        >
          {notify ? <Bell size={12} className="text-accent" /> : <BellOff size={12} />}
          {notify ? 'Notifying' : 'Notify me'}
        </button>
      </div>

      <div className="scroll-area flex-1 px-3 py-2">
        {!all.length && (
          <div className="flex flex-col items-center gap-1.5 py-10 text-center">
            <Hourglass size={20} className="text-ink-faint" />
            <div className="text-[13px] font-medium text-ink-dim">Nothing queued</div>
            <div className="max-w-[260px] text-[11.5px] text-ink-faint">Generations from every page show up here and run one after another on the GPU.</div>
          </div>
        )}

        {running.length > 0 && (
          <TraySection title="Running">
            {running.map((j) => <RunningRow key={j.id} job={j} onOpen={() => goPage(j)} />)}
          </TraySection>
        )}

        {queued.length > 0 && (
          <TraySection
            title={`Queued · ${queued.length}`}
            action={<button onClick={() => jobs.cancelQueued()} className="text-[11px] text-ink-faint hover:text-bad">Cancel all</button>}
          >
            {queued.map((j) => {
              const pos = gpuQueued.indexOf(j)
              return (
                <QueuedRow
                  key={j.id} job={j} position={pos >= 0 ? pos + 1 : null}
                  canUp={pos > 0} canDown={pos >= 0 && pos < gpuQueued.length - 1}
                  onOpen={() => goPage(j)}
                />
              )
            })}
          </TraySection>
        )}

        {finished.length > 0 && (
          <TraySection
            title="Recent"
            action={<button onClick={() => jobs.clearFinished()} className="text-[11px] text-ink-faint hover:text-ink">Clear</button>}
          >
            {finished.map((j) => (
              <FinishedRow key={j.id} job={j} byId={byId} onOpen={() => goPage(j)} onItem={openItem} />
            ))}
          </TraySection>
        )}
      </div>
    </div>
  )
}

function TraySection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between px-1 pb-1.5">
        <span className="text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint">{title}</span>
        {action}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  )
}

function PageIcon({ page, className }: { page: JobPage; className?: string }) {
  const { Icon } = PAGE_META[page]
  return <Icon size={14} className={className} />
}

function JobTitle({ job, onOpen }: { job: Job; onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="min-w-0 text-left" title={`Open ${PAGE_META[job.page].label}`}>
      <div className="truncate text-[12.5px] font-medium text-ink hover:text-accent">{job.label}</div>
      {job.detail && <div className="truncate text-[11px] text-ink-faint">{job.detail}</div>}
    </button>
  )
}

function RunningRow({ job, onOpen }: { job: Job; onOpen: () => void }) {
  const elapsed = useElapsed(job.startedAt, true)
  const p = job.progress
  const pct = p.fraction != null ? Math.round(p.fraction * 100) : null
  const status = [p.message, p.step != null && p.total ? `${p.step}/${p.total}` : null, pct != null ? `${pct}%` : null].filter(Boolean).join(' · ') || 'Working…'
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
      <div className="flex items-start gap-2.5">
        <PageIcon page={job.page} className="mt-0.5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1"><JobTitle job={job} onOpen={onOpen} /></div>
        <span className="flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-ink-faint"><Clock size={11} /> {elapsed.toFixed(0)}s</span>
        <button
          onClick={() => jobs.cancel(job.id)}
          title="Cancel (stops waiting; the GPU may finish the current step)"
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-panel-2 hover:text-bad"
        >
          <X size={13} />
        </button>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <ProgressBar value={pct ?? 0} className="flex-1" />
        <span className="shrink-0 text-[10.5px] text-ink-dim">{status}</span>
      </div>
    </div>
  )
}

function QueuedRow({ job, position, canUp, canDown, onOpen }: {
  job: Job; position: number | null; canUp: boolean; canDown: boolean; onOpen: () => void
}) {
  return (
    <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-panel-2">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-panel-3 text-[10.5px] font-semibold text-ink-dim">
        {position ?? <Hourglass size={11} />}
      </span>
      <PageIcon page={job.page} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1"><JobTitle job={job} onOpen={onOpen} /></div>
      {position != null && (
        <>
          <IconButton className="h-6 w-6" disabled={!canUp} onClick={() => jobs.move(job.id, -1)} title="Run earlier"><ArrowUp size={12} /></IconButton>
          <IconButton className="h-6 w-6" disabled={!canDown} onClick={() => jobs.move(job.id, 1)} title="Run later"><ArrowDown size={12} /></IconButton>
        </>
      )}
      <IconButton className="h-6 w-6 hover:text-bad" onClick={() => jobs.cancel(job.id)} title="Remove from queue"><X size={12} /></IconButton>
    </div>
  )
}

function FinishedRow({ job, byId, onOpen, onItem }: {
  job: Job; byId: Map<string, MediaItem>; onOpen: () => void; onItem: (id: string) => void
}) {
  const produced = job.itemIds.map((id) => byId.get(id)).filter((i): i is MediaItem => !!i)
  const shown = produced.slice(0, 6)
  const meta = [ago(job.finishedAt), duration(job)].filter(Boolean).join(' · ')
  return (
    <div className="group rounded-lg px-2 py-1.5 hover:bg-panel-2">
      <div className="flex items-start gap-2.5">
        {job.state === 'done' && <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-good" />}
        {job.state === 'failed' && <AlertTriangle size={14} className="mt-0.5 shrink-0 text-bad" />}
        {job.state === 'cancelled' && <Ban size={14} className="mt-0.5 shrink-0 text-ink-faint" />}
        <div className={clsx('min-w-0 flex-1', job.state === 'cancelled' && 'opacity-60')}>
          <JobTitle job={job} onOpen={onOpen} />
        </div>
        <span className="shrink-0 pt-0.5 text-[10.5px] text-ink-faint">{job.state === 'cancelled' ? 'cancelled' : meta}</span>
        <button
          onClick={() => jobs.remove(job.id)}
          title="Remove from list"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-ink-faint opacity-0 hover:text-ink group-hover:opacity-100"
        >
          <X size={11} />
        </button>
      </div>

      {job.state === 'failed' && (
        <div className="ml-6 mt-1 flex items-start gap-2">
          <p className="line-clamp-2 min-w-0 flex-1 text-[11px] text-bad/90" title={job.error}>{job.error ?? 'Failed'}</p>
          <Button size="sm" variant="outline" className="h-6 shrink-0 px-2 text-[11px]" icon={<RotateCcw size={11} />} onClick={() => jobs.retry(job.id)}>
            Retry
          </Button>
        </div>
      )}

      {job.state === 'done' && shown.length > 0 && (
        <div className="ml-6 mt-1.5 flex items-center gap-1.5">
          {shown.map((item) => (
            <button
              key={item.id}
              onClick={() => onItem(item.id)}
              title={item.prompt || item.name || 'Open in library'}
              className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-line bg-bg transition hover:border-accent"
            >
              <ItemThumb item={item} />
            </button>
          ))}
          {produced.length > shown.length && (
            <button onClick={() => onItem(produced[shown.length].id)} className="text-[11px] text-ink-faint hover:text-ink">
              +{produced.length - shown.length}
            </button>
          )}
        </div>
      )}
      {job.state === 'done' && job.itemIds.length > 0 && !produced.length && (
        <div className="ml-6 mt-1 flex items-center gap-1 text-[11px] text-ink-faint"><Trash2 size={11} /> Results were deleted</div>
      )}
    </div>
  )
}

/** Small square preview of a library item (image/poster, else a kind icon). */
export function ItemThumb({ item }: { item: MediaItem }) {
  const src = item.thumbUrl ?? (item.kind === 'image' ? item.url : undefined)
  if (src) return <img src={src} alt="" loading="lazy" draggable={false} className="h-full w-full object-cover" />
  if (item.kind === 'video') return <video src={item.url} muted preload="metadata" className="h-full w-full object-cover" />
  const Icon = item.kind === 'audio' ? AudioLines : item.kind === 'model3d' ? Box : Film
  return <div className="grid h-full w-full place-items-center text-ink-faint"><Icon size={16} /></div>
}
