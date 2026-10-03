import { useEffect, useRef, useState } from 'react'
import { Clock, Cpu, Loader2 } from 'lucide-react'
import { ProgressBar } from './ui/primitives'
import { errorMessage } from '../lib/hooks'

export interface GenProgressState {
  active: boolean
  step: number
  totalSteps: number
  percent: number
  elapsed: number
}

/** Polls a synchronous generation progress endpoint (image / pixelart / sprite / img2img). */
export function useProgressPoll(poll: () => Promise<{ active: boolean; step?: number; total_steps?: number; percent?: number; elapsed?: number }>, enabled: boolean): GenProgressState {
  const [state, setState] = useState<GenProgressState>({ active: false, step: 0, totalSteps: 0, percent: 0, elapsed: 0 })
  const pollRef = useRef(poll)
  pollRef.current = poll

  useEffect(() => {
    if (!enabled) { setState({ active: false, step: 0, totalSteps: 0, percent: 0, elapsed: 0 }); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    // Chain polls (never overlap) so slow responses can't arrive out of order.
    const tick = async () => {
      try {
        const p = await pollRef.current()
        if (!cancelled) setState({ active: !!p.active, step: p.step ?? 0, totalSteps: p.total_steps ?? 0, percent: p.percent ?? 0, elapsed: p.elapsed ?? 0 })
      } catch { /* ignore transient poll errors */ }
      if (!cancelled) timer = setTimeout(tick, 250)
    }
    void tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [enabled])

  return state
}

/** Inline progress strip for a running synchronous generation. */
export function ProgressStrip({ state, label = 'Generating' }: { state: GenProgressState; label?: string }) {
  if (!state.active) return null
  return (
    <div className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent/5 px-3 py-2">
      <Loader2 size={15} className="animate-spin text-accent" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center justify-between text-[11.5px]">
          <span className="font-medium text-ink">{label}</span>
          <span className="text-ink-dim">
            {state.step}/{state.totalSteps} · {Math.round(state.percent)}%
          </span>
        </div>
        <ProgressBar value={state.percent} />
      </div>
      <span className="flex items-center gap-1 text-[11px] text-ink-faint"><Clock size={11} /> {state.elapsed.toFixed(1)}s</span>
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

/** Run an async generation with a friendly error toast. */
export async function runGeneration<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}
