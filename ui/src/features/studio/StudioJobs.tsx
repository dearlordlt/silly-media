/** Studio views of queued/running generation jobs: gallery placeholders, the "latest" hero and batch progress. */
import { Clock, Hourglass, Loader2, X } from 'lucide-react'
import { jobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { useElapsed, useQueuePosition } from '../../components/Progress'
import { Button, Panel, ProgressBar } from '../../components/ui/primitives'
import { BATCH_TITLES, isActive } from './queue'
import type { StudioJobData } from './queue'

/** A studio generation job with its parsed data (`id` = job id, for keyed grids). */
export interface StudioJob { id: string; job: Job; data: StudioJobData }

/** Same clamp the gallery applies to tiles (very tall/wide images get letterboxed). */
export const tileRatio = (data: StudioJobData) => Math.min(2.4, Math.max(0.5, (data.width || 1) / (data.height || 1)))

function useJobStatus(job: Job) {
  const running = job.state === 'running'
  const elapsed = useElapsed(job.startedAt, running)
  const position = useQueuePosition(job)
  const p = job.progress
  const pct = p.fraction != null ? Math.round(p.fraction * 100) : null
  const steps = p.step != null && p.total ? `${p.step}/${p.total}` : null
  return { running, elapsed, position, pct, steps, message: p.message }
}

function CancelButton({ job }: { job: Job }) {
  return (
    <button
      onClick={() => jobs.cancel(job.id)}
      title={job.state === 'running' ? 'Cancel (stops waiting; the GPU may finish the current step)' : 'Remove from queue'}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-black/50 text-white/80 hover:bg-black/70 hover:text-white"
    >
      <X size={13} />
    </button>
  )
}

/** JSON batch `{name±N}` cast, current name emphasised. */
function CastNames({ names }: { names: { name: string; offset: number }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
      {names.map((n, i) => (
        <span key={n.offset} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-ink-faint">+</span>}
          {n.offset === 0
            ? <span className="font-semibold text-accent">{n.name}</span>
            : <span className="text-ink-dim">{n.name}<sup className="text-ink-faint">{n.offset > 0 ? `+${n.offset}` : n.offset}</sup></span>}
        </span>
      ))}
    </div>
  )
}

/** Gallery placeholder for a queued/running image, sized like the tile it becomes. */
export function PendingTile({ job, data }: StudioJob) {
  const { running, elapsed, position, pct, steps, message } = useJobStatus(job)
  return (
    <div className="relative overflow-hidden rounded-xl border border-accent/40 bg-panel">
      <div className="relative w-full" style={{ aspectRatio: String(tileRatio(data)) }}>
        <div className={running ? 'shimmer absolute inset-0' : 'absolute inset-0 bg-panel-2'} />
        <div className="absolute inset-0 flex flex-col justify-between p-2">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1 rounded-md bg-black/55 px-1.5 py-0.5 text-[10.5px] font-medium text-white">
              {running ? <Loader2 size={11} className="animate-spin" /> : <Hourglass size={11} />}
              {running ? 'Generating' : position ? `Queued · #${position}` : 'Queued'}
            </span>
            <CancelButton job={job} />
          </div>
          {running && (
            <div className="self-center text-center">
              <div className="text-2xl font-semibold tabular-nums text-ink">{pct != null ? `${pct}%` : '…'}</div>
              <div className="text-[11px] text-ink-dim">{message ?? steps ?? 'Waiting for backend'}</div>
            </div>
          )}
          <ProgressBar value={running ? pct ?? 0 : 0} />
        </div>
      </div>
      <div className="border-t border-line px-2 py-1.5">
        <div className="truncate text-[11.5px] text-ink-dim" title={data.request.prompt}>{job.label}</div>
        <div className="flex items-center justify-between gap-2 truncate text-[10.5px] text-ink-faint">
          <span>{data.width}×{data.height}{data.request.upscale ? ` ↑${data.request.upscale_factor ?? 2}×` : ''}{steps ? ` · step ${steps}` : ''}</span>
          {running && <span className="flex items-center gap-1"><Clock size={10} /> {elapsed.toFixed(0)}s</span>}
        </div>
      </div>
    </div>
  )
}

/** "Latest" hero while a studio job is queued or running. */
export function ActiveHero({ job, data, queued }: StudioJob & { queued: number }) {
  const { running, elapsed, position, pct, steps, message } = useJobStatus(job)
  const ratio = (data.width || 1) / (data.height || 1)
  return (
    <Panel className="overflow-hidden">
      <div className="grid place-items-center bg-bg p-3">
        <div className="relative overflow-hidden rounded-lg" style={{ width: `min(100%, ${(60 * ratio).toFixed(2)}vh)`, aspectRatio: `${data.width} / ${data.height}` }}>
          <div className={running ? 'shimmer absolute inset-0' : 'absolute inset-0 bg-panel-2'} />
          <div className="absolute inset-0 grid place-items-center p-6">
            <div className="flex w-full max-w-xs flex-col items-center gap-2 text-center">
              {running ? <Loader2 size={22} className="animate-spin text-accent" /> : <Hourglass size={22} className="text-ink-faint" />}
              <div className="text-3xl font-semibold tabular-nums text-ink">{running ? (pct != null ? `${pct}%` : '…') : 'Queued'}</div>
              <div className="text-[12px] text-ink-dim">
                {running
                  ? [message ?? (steps ? `Step ${steps}` : 'Waiting for the backend — the first run loads the model'), `${elapsed.toFixed(0)}s`].join(' · ')
                  : position ? `#${position} in the GPU queue` : 'Waiting for the GPU'}
              </div>
              <ProgressBar value={running ? pct ?? 0 : 0} className="mt-1" />
            </div>
          </div>
          <div className="absolute right-2 top-2"><CancelButton job={job} /></div>
        </div>
      </div>
      <div className="flex items-start gap-3 border-t border-line px-4 py-2.5 text-[12.5px] leading-relaxed">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-ink-faint">
            <span className="font-semibold uppercase text-accent">{job.label}</span>
            <span>{data.model} · {data.width}×{data.height}{data.request.seed != null ? ` · seed ${data.request.seed}` : ''}</span>
            {queued > 0 && <span>· {queued} more queued</span>}
          </div>
          {data.names && <CastNames names={data.names} />}
          <div className="line-clamp-3 text-ink-dim">{data.request.prompt}</div>
        </div>
      </div>
    </Panel>
  )
}

/** Progress of one batch (jobs sharing a group), newest-first input. */
export function BatchPanel({ group, items }: { group: string; items: StudioJob[] }) {
  const first = items[items.length - 1].data
  const total = items.length
  const done = items.filter((j) => j.job.state === 'done').length
  const failed = items.filter((j) => j.job.state === 'failed').length
  const cancelled = items.filter((j) => j.job.state === 'cancelled').length
  const settled = done + failed + cancelled
  const current = items.find((j) => j.job.state === 'running') ?? [...items].reverse().find((j) => isActive(j.job))
  const fraction = current?.job.state === 'running' ? current.job.progress.fraction ?? 0 : 0
  const queued = items.filter((j) => j.job.state === 'queued').length
  return (
    <Panel className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-3 text-[12.5px]">
        <span className="font-semibold">{BATCH_TITLES[first.kind]}{first.folder ? <span className="ml-2 font-normal text-ink-faint">{first.folder}</span> : null}</span>
        <div className="flex items-center gap-3">
          <span className="text-ink-dim">
            {done} / {total} done{failed ? ` · ${failed} failed` : ''}{cancelled ? ` · ${cancelled} cancelled` : ''}
          </span>
          {queued > 0 && (
            <Button variant="ghost" size="sm" icon={<X size={13} />} onClick={() => jobs.cancelQueued({ page: 'studio', group })}>
              Cancel remaining ({queued})
            </Button>
          )}
        </div>
      </div>
      <ProgressBar value={((settled + fraction) / total) * 100} />
      {current && (
        <>
          {current.data.names && <CastNames names={current.data.names} />}
          <div className="flex items-start justify-between gap-3 text-[11.5px] text-ink-faint">
            <span className="line-clamp-3">
              <span className="mr-1.5 text-ink-dim">#{current.data.index + 1}</span>
              {current.job.progress.message ? `${current.job.progress.message} ` : ''}{current.data.request.prompt}
            </span>
          </div>
        </>
      )}
    </Panel>
  )
}
