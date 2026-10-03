/**
 * App-wide job queue and activity feed.
 *
 * Generation work is enqueued here instead of living in page state, so it keeps
 * running when you navigate away, queues behind whatever the GPU is doing, and
 * shows up in the header tray. `gpu` jobs run one at a time in FIFO order (the
 * backend only holds one model in VRAM anyway); `free` jobs start immediately
 * and are only tracked (e.g. streaming speech, vision questions).
 *
 * A job's `run` must be self-contained: it may outlive the component that
 * enqueued it, so it must not call that component's setState. Persist results
 * with `library.add` and report them via `ctx.addItem(id)`; pages render their
 * jobs with `usePageJobs(page)` / `useJob(id)`.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { kv } from './kv'

export type JobPage = 'studio' | 'edit' | 'assets' | 'audio' | 'music' | 'video' | '3d' | 'vision' | 'chat'
export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type JobLane = 'gpu' | 'free'

export interface JobProgress {
  /** 0..1 when known. */
  fraction?: number | null
  step?: number | null
  total?: number | null
  message?: string | null
}

export interface Job {
  id: string
  page: JobPage
  label: string
  detail?: string
  lane: JobLane
  state: JobState
  progress: JobProgress
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: string
  /** Library items produced, in order. */
  itemIds: string[]
  /** Page-defined payload (e.g. request echo, server job id, logs). */
  data?: unknown
  /** Page-defined grouping key (e.g. a batch id) for rendering queued work. */
  group?: string
}

export interface JobContext {
  readonly id: string
  readonly signal: AbortSignal
  report(p: JobProgress): void
  addItem(id: string): void
  setData(data: unknown): void
  /**
   * Poll `fetcher` (chained, never overlapping) while the job runs and report
   * what it returns; null results are ignored. Stops automatically when the job
   * settles; the returned function stops it earlier.
   */
  poll(fetcher: () => Promise<JobProgress | null>, intervalMs?: number): () => void
}

export interface JobSpec {
  page: JobPage
  label: string
  detail?: string
  lane?: JobLane
  group?: string
  data?: unknown
  run: (ctx: JobContext) => Promise<void>
}

/** Thrown (or returned via signal) when the user cancels; never reported as a failure. */
export class JobCancelled extends Error {
  constructor() { super('Cancelled') }
}

const HISTORY_LIMIT = 60
const NOTIFY_KEY = 'silly-jobs-notify'

const specs = new Map<string, JobSpec>()
const controllers = new Map<string, AbortController>()
let list: Job[] = []
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
  updateTitle()
}

function patch(id: string, p: Partial<Job>) {
  list = list.map((j) => (j.id === id ? { ...j, ...p } : j))
  emit()
}

function get(id: string): Job | undefined {
  return list.find((j) => j.id === id)
}

function trim() {
  const finished = list.filter((j) => j.state !== 'queued' && j.state !== 'running')
  if (finished.length <= HISTORY_LIMIT) return
  const drop = new Set(finished.slice(HISTORY_LIMIT).map((j) => j.id))
  list = list.filter((j) => !drop.has(j.id))
  for (const id of drop) specs.delete(id)
}

/* ---------- title + notifications ---------- */

const BASE_TITLE = typeof document !== 'undefined' ? document.title : 'Silly Media'
let unseenDone = 0

function updateTitle() {
  if (typeof document === 'undefined') return
  const active = list.filter((j) => j.state === 'running' || j.state === 'queued').length
  const prefix = active ? `(${active}) ` : unseenDone ? `✓ ${unseenDone} · ` : ''
  document.title = prefix + BASE_TITLE
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && unseenDone) { unseenDone = 0; updateTitle() }
  })
}

export function notificationsEnabled(): boolean {
  return kv.getItem(NOTIFY_KEY) === '1' && typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

/** Ask for permission (needs a user gesture) and remember the choice. */
export async function setNotifications(on: boolean): Promise<boolean> {
  if (!on || typeof Notification === 'undefined') { kv.setItem(NOTIFY_KEY, '0'); emit(); return false }
  const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  kv.setItem(NOTIFY_KEY, perm === 'granted' ? '1' : '0')
  emit()
  return perm === 'granted'
}

function announce(job: Job) {
  if (typeof document === 'undefined' || document.visibilityState === 'visible') return
  if (job.state === 'done') unseenDone++
  if (!notificationsEnabled()) return
  const title = job.state === 'done' ? `✓ ${job.label}` : `✗ ${job.label}`
  const body = job.state === 'done' ? (job.itemIds.length > 1 ? `${job.itemIds.length} results ready` : 'Ready') : job.error ?? 'Failed'
  const n = new Notification(title, { body, tag: job.id, icon: '/ui/favicon.svg' })
  n.onclick = () => { window.focus(); n.close() }
}

/* ---------- scheduler ---------- */

function pump() {
  if (list.some((j) => j.lane === 'gpu' && j.state === 'running')) return
  // `list` is newest-first; the GPU lane is FIFO.
  const next = [...list].reverse().find((j) => j.lane === 'gpu' && j.state === 'queued')
  if (next) void start(next.id)
}

async function start(id: string) {
  const spec = specs.get(id)
  if (!spec) return
  const ac = new AbortController()
  controllers.set(id, ac)
  const stops = new Set<() => void>()
  patch(id, { state: 'running', startedAt: Date.now(), progress: {}, error: undefined })

  const ctx: JobContext = {
    id,
    signal: ac.signal,
    report: (p) => { if (!ac.signal.aborted) patch(id, { progress: { ...get(id)?.progress, ...p } }) },
    addItem: (itemId) => patch(id, { itemIds: [...(get(id)?.itemIds ?? []), itemId] }),
    setData: (data) => patch(id, { data }),
    poll: (fetcher, intervalMs = 800) => {
      let alive = true
      let timer: ReturnType<typeof setTimeout>
      const tick = async () => {
        try {
          const p = await fetcher()
          if (alive && p) ctx.report(p)
        } catch { /* progress is cosmetic; the job itself reports failures */ }
        if (alive) timer = setTimeout(() => void tick(), intervalMs)
      }
      const stop = () => { alive = false; clearTimeout(timer); stops.delete(stop) }
      stops.add(stop)
      timer = setTimeout(() => void tick(), intervalMs)
      return stop
    },
  }

  try {
    await spec.run(ctx)
    if (ac.signal.aborted) throw new JobCancelled()
    patch(id, { state: 'done', finishedAt: Date.now(), progress: { ...get(id)?.progress, fraction: 1 } })
  } catch (e) {
    const cancelled = ac.signal.aborted || e instanceof JobCancelled || (e instanceof DOMException && e.name === 'AbortError')
    patch(id, {
      state: cancelled ? 'cancelled' : 'failed',
      finishedAt: Date.now(),
      error: cancelled ? undefined : e instanceof Error ? e.message : String(e),
    })
  } finally {
    for (const stop of [...stops]) stop()
    controllers.delete(id)
    const job = get(id)
    if (job && job.state !== 'cancelled') announce(job)
    trim()
    emit()
    pump()
  }
}

let seq = 0

export const jobs = {
  /** Queue (gpu lane, default) or start (free lane) a job; returns its id. */
  enqueue(spec: JobSpec): string {
    const id = `job-${Date.now().toString(36)}-${(seq++).toString(36)}`
    specs.set(id, spec)
    const job: Job = {
      id, page: spec.page, label: spec.label, detail: spec.detail, lane: spec.lane ?? 'gpu', group: spec.group,
      data: spec.data, state: 'queued', progress: {}, createdAt: Date.now(), itemIds: [],
    }
    list = [job, ...list]
    emit()
    if (job.lane === 'free') void start(id)
    else pump()
    return id
  },

  /** Queued: dropped from the queue. Running: aborts the request (the backend may still finish the step). */
  cancel(id: string) {
    const job = get(id)
    if (!job) return
    if (job.state === 'queued') { patch(id, { state: 'cancelled', finishedAt: Date.now() }); pump() }
    else if (job.state === 'running') controllers.get(id)?.abort()
  },

  /** Cancel every queued job (optionally only one page's / group's). Running jobs keep going. */
  cancelQueued(filter?: { page?: JobPage; group?: string }) {
    const now = Date.now()
    list = list.map((j) => (j.state === 'queued' && (!filter?.page || j.page === filter.page) && (!filter?.group || j.group === filter.group)
      ? { ...j, state: 'cancelled' as const, finishedAt: now } : j))
    emit()
  },

  /** Re-run a finished job with the same spec (new id). */
  retry(id: string): string | null {
    const spec = specs.get(id)
    return spec ? jobs.enqueue(spec) : null
  },

  /** Move a queued job earlier (-1) or later (+1) in the GPU queue. */
  move(id: string, delta: -1 | 1) {
    const queued = [...list].reverse().filter((j) => j.state === 'queued' && j.lane === 'gpu')
    const i = queued.findIndex((j) => j.id === id)
    const k = i + delta
    if (i < 0 || k < 0 || k >= queued.length) return
    const a = list.findIndex((j) => j.id === queued[i].id)
    const b = list.findIndex((j) => j.id === queued[k].id)
    const next = [...list]
    ;[next[a], next[b]] = [next[b], next[a]]
    list = next
    emit()
  },

  remove(id: string) {
    const job = get(id)
    if (!job || job.state === 'running') return
    list = list.filter((j) => j.id !== id)
    specs.delete(id)
    emit()
  },

  clearFinished() {
    const keep = list.filter((j) => j.state === 'queued' || j.state === 'running')
    for (const j of list) if (!keep.includes(j)) specs.delete(j.id)
    list = keep
    emit()
  },

  all: () => list,
  get,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },
}

/** All jobs, newest first. */
export function useJobs(): Job[] {
  return useSyncExternalStore(jobs.subscribe, jobs.all, jobs.all)
}

/** A page's jobs, newest first (stable identity while unchanged). */
export function usePageJobs(page: JobPage): Job[] {
  const all = useJobs()
  return useMemo(() => all.filter((j) => j.page === page), [all, page])
}

export function useJob(id: string | null | undefined): Job | undefined {
  const all = useJobs()
  return useMemo(() => (id ? all.find((j) => j.id === id) : undefined), [all, id])
}

/** Queued + running counts (for badges). */
export function useJobCounts(): { running: number; queued: number } {
  const all = useJobs()
  return useMemo(() => ({
    running: all.filter((j) => j.state === 'running').length,
    queued: all.filter((j) => j.state === 'queued').length,
  }), [all])
}

/** Map a backend ProgressResponse-like payload to JobProgress (null when idle). */
export function fromBackendProgress(p: { active: boolean; step?: number; total_steps?: number; percent?: number }): JobProgress | null {
  if (!p.active) return null
  const fraction = p.percent != null ? p.percent / 100 : p.step != null && p.total_steps ? p.step / p.total_steps : null
  return { fraction, step: p.step ?? null, total: p.total_steps ?? null }
}

/** Throw JobCancelled if the job was cancelled (use between steps of multi-step jobs). */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new JobCancelled()
}
