import { clsx } from 'clsx'
import { RotateCcw } from 'lucide-react'
import { QUALITY_TIERS, USE_CASES, type ResolvedPreset, type Speed } from './presets'

const SPEED_TONE: Record<Speed, string> = {
  fast: 'text-good',
  medium: 'text-accent-2',
  slow: 'text-warn',
  'very slow': 'text-bad',
}

/** Use case grid + quality scale; `custom` means knobs were tweaked by hand afterwards. */
export function PresetPicker({ useCase, tier, resolved, custom, onUseCase, onTier, onReapply }: {
  useCase: string
  tier: number
  resolved: ResolvedPreset
  custom: boolean
  onUseCase: (id: string) => void
  onTier: (index: number) => void
  onReapply: () => void
}) {
  const t = QUALITY_TIERS[tier]
  const uc = USE_CASES.find((u) => u.id === useCase)
  const last = QUALITY_TIERS.length - 1

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="mb-1.5 text-[11.5px] font-medium uppercase tracking-wide text-ink-faint">What are you making?</div>
        <div className="grid grid-cols-3 gap-1.5">
          {USE_CASES.map((u) => (
            <button
              key={u.id}
              title={u.desc}
              onClick={() => onUseCase(u.id)}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-[12px] transition-colors',
                useCase === u.id ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
              )}
            >
              <span aria-hidden>{u.icon}</span>
              <span className="truncate">{u.label}</span>
            </button>
          ))}
        </div>
        {uc && <p className="mt-1.5 text-[11.5px] text-ink-faint">{uc.desc}</p>}
      </div>

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-faint">Quality / target</span>
          <span className="text-[12px] font-semibold text-ink">{t.label}</span>
        </div>
        <input
          type="range"
          min={0}
          max={last}
          step={1}
          value={tier}
          onChange={(e) => onTier(Number(e.target.value))}
          className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gradient-to-r from-good/50 via-accent/60 to-bad/50"
          aria-label="Quality tier"
        />
        <div className="mt-1 flex justify-between">
          {QUALITY_TIERS.map((q, i) => (
            <button
              key={q.id}
              onClick={() => onTier(i)}
              title={q.desc}
              className={clsx('w-0 flex-1 text-center text-[9.5px] leading-tight', i === tier ? 'font-semibold text-ink' : 'text-ink-faint hover:text-ink-dim')}
            >
              {q.short}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-ink-dim">{t.desc}</p>
      </div>

      <div className={clsx('rounded-lg border px-3 py-2 text-[11.5px]', custom ? 'border-warn/40 bg-warn/5' : 'border-line bg-bg')}>
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-ink-dim">
          <span><b className="text-ink">≈{resolved.faces.toLocaleString()}</b> faces</span>
          <span>octree <b className="text-ink">{resolved.octree}</b></span>
          <span><b className="text-ink">{resolved.steps}</b> steps</span>
          <span>texture <b className="text-ink">{resolved.texture ? 'on' : 'off'}</b></span>
          <span>speed <b className={SPEED_TONE[resolved.speed]}>{resolved.speed}</b></span>
        </div>
        {custom && (
          <div className="mt-1.5 flex items-center justify-between gap-2 text-warn">
            <span>Custom — mesh settings tweaked by hand.</span>
            <button onClick={onReapply} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-dim hover:bg-panel-2 hover:text-ink">
              <RotateCcw size={11} /> Re-apply preset
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
