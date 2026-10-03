/** Toasts + a tiny job-status poller shared by music/video. */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useApp } from './store'
import { ApiError, SillyClient } from './api'

/** Consecutive status-poll failures tolerated before a job is reported failed. */
const MAX_POLL_FAILURES = 6

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  title: string
  detail?: string
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: number) => void
}

let nextId = 1
export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = nextId++
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), t.kind === 'error' ? 9000 : 4500)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

export const toast = {
  info: (title: string, detail?: string) => useToasts.getState().push({ kind: 'info', title, detail }),
  success: (title: string, detail?: string) => useToasts.getState().push({ kind: 'success', title, detail }),
  error: (title: string, detail?: string) => useToasts.getState().push({ kind: 'error', title, detail }),
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  return String(e)
}

/** A SillyClient bound to the configured base URL (recreated when the base changes). */
export function useClient(): SillyClient {
  const base = useApp((s) => s.apiBase)
  const ref = useRef(new SillyClient(base))
  if (ref.current.base !== base.replace(/\/+$/, '')) ref.current = new SillyClient(base)
  return ref.current
}

/**
 * Poll an async job until it finishes. Returns null state until started.
 */
export interface PolledJob<T = unknown> {
  status: 'idle' | 'queued' | 'processing' | 'completed' | 'failed'
  progress: number
  currentStep: number | null
  totalSteps: number | null
  elapsedSeconds: number | null
  error: string | null
  data: T | null
}

export function useJobPoller<T>(
  jobId: string | null,
  fetchStatus: (id: string) => Promise<{
    status: string
    progress?: number | null
    current_step?: number | null
    total_steps?: number | null
    elapsed_seconds?: number | null
    error?: string | null
    data?: T | null
  }>,
  onDone?: (data: T | null) => void,
): PolledJob<T> {
  const [job, setJob] = useState<PolledJob<T>>({
    status: 'idle', progress: 0, currentStep: null, totalSteps: null, elapsedSeconds: null, error: null, data: null,
  })
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    // A new id must never expose the previous job's result: reset everything.
    setJob({ status: jobId ? 'queued' : 'idle', progress: 0, currentStep: null, totalSteps: null, elapsedSeconds: null, error: null, data: null })
    if (!jobId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    let failures = 0

    const tick = async () => {
      try {
        const s = await fetchStatus(jobId)
        if (cancelled) return
        failures = 0
        const status = s.status as PolledJob<T>['status']
        setJob({
          status,
          progress: s.progress ?? 0,
          currentStep: s.current_step ?? null,
          totalSteps: s.total_steps ?? null,
          elapsedSeconds: s.elapsed_seconds ?? null,
          error: s.error ?? null,
          data: s.data ?? null,
        })
        if (status === 'completed' || status === 'failed') { onDoneRef.current?.(s.data ?? null); return }
      } catch (e) {
        if (cancelled) return
        // The job keeps running server-side; tolerate blips. 404 = job gone.
        failures += 1
        const gone = e instanceof ApiError && e.status === 404
        if (gone || failures >= MAX_POLL_FAILURES) {
          setJob((j) => ({ ...j, status: 'failed', error: errorMessage(e) }))
          onDoneRef.current?.(null)
          return
        }
      }
      timer = setTimeout(tick, failures ? 900 * 2 ** Math.min(failures, 4) : 900)
    }
    void tick()
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId])

  return job
}
