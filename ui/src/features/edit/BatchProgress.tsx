/**
 * Batch progress for the editor, ported from ui-img2img.html: overall batch
 * fill, per-step progress of the running edit, and work-vs-idle timing
 * (idle = model loading, request overhead and the pause between edits).
 */
import { useEffect, useRef, useState } from 'react'
import { Clock, Loader2 } from 'lucide-react'
import type { ProgressResponse } from '../../lib/types'
import { Panel, ProgressBar } from '../../components/ui/primitives'

export interface BatchState {
  /** Edits saved so far. */
  done: number
  total: number
  /** 1-based index of the edit currently running. */
  current: number
  label: string
  finished: boolean
}

interface Snapshot {
  active: boolean
  step: number
  totalSteps: number
  percent: number
  work: number
  idle: number
  /** Seconds of the running inference (active) or of the current idle stretch. */
  current: number
}

const EMPTY: Snapshot = { active: false, step: 0, totalSteps: 0, percent: 0, work: 0, idle: 0, current: 0 }

function fmt(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`
  return `${seconds.toFixed(1)}s`
}

export function BatchProgress({ running, batch, poll }: {
  running: boolean
  batch: BatchState | null
  poll: () => Promise<ProgressResponse>
}) {
  const [snap, setSnap] = useState<Snapshot>(EMPTY)
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    if (!running) return
    let work = 0
    let idle = 0
    let inferenceStart: number | null = null
    let idleStart: number | null = Date.now()
    let wasActive = false
    let last: ProgressResponse = { active: false }
    let cancelled = false

    const compute = (now: number): Snapshot => {
      const currentWork = inferenceStart ? (now - inferenceStart) / 1000 : 0
      const currentIdle = idleStart ? (now - idleStart) / 1000 : 0
      return {
        active: last.active,
        step: last.step ?? 0,
        totalSteps: last.total_steps ?? 0,
        percent: last.active ? last.percent ?? 0 : 0,
        work: work + currentWork,
        idle: idle + currentIdle,
        current: last.active ? currentWork : currentIdle,
      }
    }

    setSnap(EMPTY)
    const timer = setInterval(async () => {
      try {
        const p = await pollRef.current()
        if (cancelled) return
        const now = Date.now()
        if (p.active && !wasActive) {
          if (idleStart) { idle += (now - idleStart) / 1000; idleStart = null }
          inferenceStart = now
        }
        if (!p.active && wasActive) {
          if (inferenceStart) { work += (now - inferenceStart) / 1000; inferenceStart = null }
          idleStart = now
        }
        wasActive = p.active
        last = p
        setSnap(compute(now))
      } catch { /* transient poll errors are ignored */ }
    }, 200)

    return () => {
      cancelled = true
      clearInterval(timer)
      // Freeze the final totals; an in-flight inference counts as work.
      const now = Date.now()
      if (inferenceStart) work += (now - inferenceStart) / 1000
      if (idleStart) idle += (now - idleStart) / 1000
      setSnap({ ...EMPTY, work, idle })
    }
  }, [running])

  if (!batch) return null
  const avg = batch.done > 0 ? fmt(snap.work / batch.done) : '--'
  const batchPct = batch.total ? ((batch.finished ? batch.done : batch.current - 1) / batch.total) * 100 : 0

  return (
    <Panel className="flex flex-col gap-3 p-3">
      <div>
        <div className="mb-1 flex items-center justify-between gap-2 text-[11.5px]">
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-ink">
            {running && <Loader2 size={13} className="shrink-0 animate-spin text-accent" />}
            <span className="truncate">
              {batch.finished
                ? `${batch.done} / ${batch.total} - Done!`
                : `${batch.current} / ${batch.total} - ${batch.label}`}
            </span>
          </span>
          <span className="shrink-0 text-ink-faint">{Math.round(batch.finished ? 100 : batchPct)}%</span>
        </div>
        <ProgressBar value={batch.finished ? 100 : batchPct} />
      </div>
      <div className="grid grid-cols-2 gap-4 text-[11px]">
        <div>
          <div className="mb-1 text-ink-faint">Step progress</div>
          <ProgressBar value={batch.finished ? 100 : snap.percent} />
          <div className="mt-1 text-ink-dim">
            {batch.finished ? 'Complete' : snap.active ? `Step ${snap.step} / ${snap.totalSteps}` : 'Waiting…'}
          </div>
        </div>
        <div>
          <div className="mb-1 flex items-center gap-1 text-ink-faint"><Clock size={11} /> Timing</div>
          <div className="text-ink-dim">work: {fmt(snap.work)} + idle: {fmt(snap.idle)} (avg: {avg})</div>
          <div className="text-ink-dim">
            {batch.finished ? 'Done' : snap.active ? fmt(snap.current) : `idle ${fmt(snap.current)}`}
          </div>
        </div>
      </div>
    </Panel>
  )
}
