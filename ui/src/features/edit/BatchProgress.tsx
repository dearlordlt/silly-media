/**
 * Batch progress for the editor, driven by the batch's queued jobs: overall
 * batch fill, per-step progress of the running edit, timing (work time per
 * finished edit, average) and cancel-remaining / stop-current controls.
 */
import { Clock, Hourglass, Loader2, Square, X } from 'lucide-react'
import { jobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { useElapsed, useQueuePosition } from '../../components/Progress'
import { Button, IconButton, Panel, ProgressBar } from '../../components/ui/primitives'
import { editJobData } from './editJobs'

function fmt(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
  return `${seconds.toFixed(1)}s`
}

/** `batch` = one batch's jobs, newest first (as `usePageJobs` returns them). */
export function BatchProgress({ group, batch, onDismiss }: { group: string; batch: Job[]; onDismiss: () => void }) {
  const ordered = [...batch].reverse()
  const total = ordered.length
  const running = ordered.find((j) => j.state === 'running')
  const queued = ordered.filter((j) => j.state === 'queued')
  const done = ordered.filter((j) => j.state === 'done')
  const failed = ordered.filter((j) => j.state === 'failed').length
  const cancelled = ordered.filter((j) => j.state === 'cancelled').length
  const settled = done.length + failed + cancelled
  const finished = !running && !queued.length
  const position = useQueuePosition(running ? undefined : queued[0])
  const elapsed = useElapsed(running?.startedAt, !!running)

  const work = done.reduce((s, j) => s + (j.finishedAt && j.startedAt ? (j.finishedAt - j.startedAt) / 1000 : 0), 0)
  const avg = done.length ? fmt(work / done.length) : '--'
  const p = running?.progress
  const batchPct = finished ? 100 : ((settled + (p?.fraction ?? 0)) / total) * 100
  const current = running ?? queued[0]
  const currentLabel = current ? editJobData(current)?.label ?? current.label : ''
  const extra = [failed ? `${failed} failed` : null, cancelled ? `${cancelled} cancelled` : null].filter(Boolean).join(', ')

  return (
    <Panel className="flex flex-col gap-3 p-3">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink">
            {running ? <Loader2 size={13} className="shrink-0 animate-spin text-accent" /> : !finished && <Hourglass size={13} className="shrink-0 text-ink-faint" />}
            <span className="truncate">
              {finished
                ? `${done.length} / ${total} - Done!${extra ? ` (${extra})` : ''}`
                : `${settled + 1} / ${total} - ${currentLabel}`}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <span className="text-ink-faint">{Math.round(batchPct)}%</span>
            {queued.length > 0 && (
              <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => jobs.cancelQueued({ page: 'edit', group })} title="Drop the edits still waiting in the queue">
                Cancel remaining ({queued.length})
              </Button>
            )}
            {running && (
              <Button size="sm" variant="ghost" icon={<Square size={11} />} onClick={() => jobs.cancel(running.id)} title="Stop waiting for the running edit (the GPU may finish the current step)">
                Stop current
              </Button>
            )}
            {finished && <IconButton onClick={onDismiss} title="Dismiss"><X size={13} /></IconButton>}
          </span>
        </div>
        <ProgressBar value={batchPct} />
      </div>
      <div className="grid grid-cols-2 gap-4 text-[11px]">
        <div>
          <div className="mb-1 text-ink-faint">Step progress</div>
          <ProgressBar value={finished ? 100 : p?.fraction != null ? p.fraction * 100 : 0} />
          <div className="mt-1 text-ink-dim">
            {finished ? 'Complete'
              : running ? (p?.step != null && p.total ? `Step ${p.step} / ${p.total}` : p?.message ?? 'Loading model…')
              : `Waiting for the GPU${position ? ` · #${position} in queue` : ''}`}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 text-ink-faint"><Clock size={11} /> Timing</div>
          <div className="text-ink-dim">work: {fmt(work + (running ? elapsed : 0))} (avg: {avg})</div>
          <div className="text-ink-dim">{finished ? 'Done' : running ? `current: ${fmt(elapsed)}` : 'queued'}</div>
        </div>
      </div>
    </Panel>
  )
}
