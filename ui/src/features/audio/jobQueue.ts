/**
 * Helpers shared by the speech, music and video pages for running their work
 * on the app-wide job queue (`lib/jobs.ts`).
 */
import { ApiError } from '../../lib/api'
import { JobCancelled, throwIfCancelled, useJobs } from '../../lib/jobs'
import type { JobProgress } from '../../lib/jobs'
import type { JobStatus } from '../../lib/types'

/** Consecutive status-poll failures tolerated before a server job is reported failed. */
const MAX_POLL_FAILURES = 6
const POLL_MS = 900

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new JobCancelled()); return }
    const done = () => { signal.removeEventListener('abort', abort); resolve() }
    const abort = () => { clearTimeout(timer); reject(new JobCancelled()) }
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Poll an async backend job (`/music/status`, `/video/status`) until it completes.
 * Transient failures back off and retry (the job keeps running server-side);
 * a 404 means the server forgot the job. Throws on failure, `JobCancelled` on abort.
 */
export async function pollServerJob(
  signal: AbortSignal,
  fetchStatus: (signal: AbortSignal) => Promise<JobStatus>,
  onStatus: (status: JobStatus) => void,
): Promise<JobStatus> {
  let failures = 0
  for (;;) {
    throwIfCancelled(signal)
    let status: JobStatus | null = null
    try {
      status = await fetchStatus(signal)
    } catch (e) {
      if (signal.aborted) throw new JobCancelled()
      failures += 1
      if (e instanceof ApiError && e.status === 404) throw new Error('The server no longer knows this job (it may have restarted)')
      if (failures >= MAX_POLL_FAILURES) throw e
    }
    if (status) {
      failures = 0
      onStatus(status)
      if (status.status === 'completed') return status
      if (status.status === 'failed') throw new Error(status.error || 'Generation failed')
    }
    await sleep(failures ? POLL_MS * 2 ** Math.min(failures, 4) : POLL_MS, signal)
  }
}

/** Map a backend job status to queue progress. */
export function statusProgress(st: JobStatus, runningMessage = 'Generating'): JobProgress {
  if (st.status === 'queued') return { fraction: null, step: null, total: null, message: 'Waiting for the server' }
  const step = st.current_step ?? null
  const total = st.total_steps ?? null
  const fraction = st.progress != null ? Math.max(0, Math.min(1, st.progress)) : step != null && total ? step / total : null
  return { fraction, step, total, message: runningMessage }
}

/** GPU jobs queued or running app-wide (what a newly queued job waits behind). */
export function useGpuAhead(): number {
  return useJobs().filter((j) => j.lane === 'gpu' && (j.state === 'queued' || j.state === 'running')).length
}

/** Generate-button label: the action itself when idle, "Queue" when it would wait. */
export function queueLabel(idle: string, ahead: number): string {
  return ahead > 0 ? `Queue (${ahead} ahead)` : idle
}

/** Duration of a PCM WAV blob from its header (null for other formats). */
export async function wavDuration(blob: Blob): Promise<number | null> {
  const head = new DataView(await blob.slice(0, 8192).arrayBuffer())
  const tag = (o: number) => String.fromCharCode(head.getUint8(o), head.getUint8(o + 1), head.getUint8(o + 2), head.getUint8(o + 3))
  if (head.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null
  let byteRate = 0
  let offset = 12
  while (offset + 8 <= head.byteLength) {
    const id = tag(offset)
    const size = head.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 16 <= head.byteLength) byteRate = head.getUint32(offset + 16, true)
    if (id === 'data') {
      // Streaming encoders may leave the size unset; fall back to the bytes present.
      const bytes = size > 0 && size < 0xffffffff ? size : blob.size - offset - 8
      return byteRate > 0 ? bytes / byteRate : null
    }
    offset += 8 + size + (size % 2)
  }
  return null
}
