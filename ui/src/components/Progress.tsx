import { useEffect, useState } from 'react'
import { Clock, Cpu, Hourglass, Loader2, X } from 'lucide-react'
import { ProgressBar } from './ui/primitives'
import { jobs, useJobs } from '../lib/jobs'
import type { Job } from '../lib/jobs'

/** Seconds since `since`, ticking every 500ms while `active`. */
export function useElapsed(since: number | undefined, active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [active])
  return since ? Math.max(0, (active ? now : Date.now()) - since) / 1000 : 0
}

/** 1-based position of a queued GPU job, or null when not queued. */
export function useQueuePosition(job: Job | undefined): number | null {
  const all = useJobs()
  if (!job || job.state !== 'queued' || job.lane !== 'gpu') return null
  const queued = all.filter((j) => j.lane === 'gpu' && j.state === 'queued').reverse()
  return queued.findIndex((j) => j.id === job.id) + 1
}

/** Status strip for a queued or running job (renders nothing once finished). */
export function JobStrip({ job, label, onCancel }: { job: Job | undefined; label?: string; onCancel?: () => void }) {
  const running = job?.state === 'running'
  const elapsed = useElapsed(job?.startedAt, running)
  const position = useQueuePosition(job)
  if (!job || (job.state !== 'queued' && job.state !== 'running')) return null
  const p = job.progress
  const pct = p.fraction != null ? Math.round(p.fraction * 100) : null
  const cancel = onCancel ?? (() => jobs.cancel(job.id))
  return (
    <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
      {running ? <Loader2 size={15} className="shrink-0 animate-spin text-accent" /> : <Hourglass size={15} className="shrink-0 text-ink-faint" />}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
          <span className="truncate font-medium text-ink">{label ?? job.label}</span>
          <span className="shrink-0 text-ink-dim">
            {running
              ? [p.message, p.step != null && p.total ? `${p.step}/${p.total}` : null, pct != null ? `${pct}%` : null].filter(Boolean).join(' · ') || 'Working…'
              : position ? `Queued · #${position}` : 'Queued'}
          </span>
        </div>
        <ProgressBar value={running ? pct ?? 0 : 0} />
      </div>
      {running && <span className="flex shrink-0 items-center gap-1 text-[11px] text-ink-faint"><Clock size={11} /> {elapsed.toFixed(0)}s</span>}
      <button onClick={cancel} title={running ? 'Cancel (stops waiting; the GPU may finish the current step)' : 'Remove from queue'} className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-ink-faint hover:bg-panel-2 hover:text-ink">
        <X size={13} />
      </button>
    </div>
  )
}

/** Model-load indicator: shown while the VRAM manager is swapping/loading weights. */
export function ModelBadge({ model, loaded }: { model: string; loaded?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-bg px-2 py-1 text-[11px] text-ink-dim">
      <Cpu size={11} className={loaded ? 'text-good' : 'text-ink-faint'} />
      {model}
    </span>
  )
}
