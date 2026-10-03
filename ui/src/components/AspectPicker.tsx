import { clsx } from 'clsx'
import { ArrowLeftRight } from 'lucide-react'
import type { AspectRatio } from '../lib/types'

export type Orientation = 'portrait' | 'square' | 'landscape'

const ALL: AspectRatio[] = ['9:16', '2:3', '3:4', '4:5', '1:1', '5:4', '4:3', '3:2', '16:9', '21:9']

export function parseRatio(r: AspectRatio): [number, number] {
  const [w, h] = r.split(':').map(Number)
  return [w, h]
}

export function orientationOf(r: AspectRatio): Orientation {
  const [w, h] = parseRatio(r)
  return w === h ? 'square' : w > h ? 'landscape' : 'portrait'
}

/** Mirror of backend `calculate_dimensions` (src/silly_media/schemas.py): keep ~base² pixels, floor to 64. */
export function dimensionsFor(r: AspectRatio, baseSize: number): { width: number; height: number } {
  const [w, h] = parseRatio(r)
  const ratio = w / h
  const height = Math.floor(Math.sqrt((baseSize * baseSize) / ratio))
  const width = Math.floor(height * ratio)
  return { width: Math.floor(width / 64) * 64, height: Math.floor(height / 64) * 64 }
}

/** The same ratio with width and height swapped, if it is one of the presets. */
function flipped(r: AspectRatio, options: AspectRatio[]): AspectRatio | null {
  const [w, h] = parseRatio(r)
  const f = `${h}:${w}`
  return options.find((o) => o === f) ?? null
}

const GROUPS: { key: Orientation; label: string }[] = [
  { key: 'portrait', label: 'Portrait' },
  { key: 'square', label: 'Square' },
  { key: 'landscape', label: 'Landscape' },
]

/**
 * Aspect-ratio chooser with true-shape glyphs grouped by orientation, a
 * portrait/landscape swap, and the exact output size the backend will render.
 */
export function AspectPicker({ value, onChange, baseSize, options = ALL }: {
  value: AspectRatio
  onChange: (r: AspectRatio) => void
  /** When set, shows the resolved pixel size (aspect + base size mode). */
  baseSize?: number
  options?: AspectRatio[]
}) {
  const swap = flipped(value, options)
  const dims = baseSize ? dimensionsFor(value, baseSize) : null
  const orient = orientationOf(value)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-1.5">
        {GROUPS.map((g) => {
          const group = options.filter((o) => orientationOf(o) === g.key)
          if (!group.length) return null
          return (
            <div key={g.key} className={clsx('flex flex-col gap-1', g.key === 'square' ? 'shrink-0' : 'min-w-0 flex-1')}>
              <span className="px-0.5 text-[10px] uppercase tracking-wide text-ink-faint">{g.label}</span>
              <div className="flex gap-1">
                {group.map((r) => <RatioButton key={r} ratio={r} active={r === value} onClick={() => onChange(r)} />)}
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex items-center justify-between rounded-lg border border-line bg-bg px-2.5 py-1.5">
        <span className="text-[12px] text-ink">
          <span className="font-semibold">{value}</span>
          <span className="text-ink-dim"> · {orient}</span>
          {dims && <span className="text-ink-dim"> · {dims.width} × {dims.height}px</span>}
        </span>
        <button
          type="button"
          disabled={!swap}
          onClick={() => swap && onChange(swap)}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-ink-dim hover:bg-panel-2 hover:text-ink disabled:opacity-35"
          title={swap ? `Swap to ${swap}` : 'No swapped preset'}
        >
          <ArrowLeftRight size={12} /> Swap
        </button>
      </div>
    </div>
  )
}

function RatioButton({ ratio, active, onClick }: { ratio: AspectRatio; active: boolean; onClick: () => void }) {
  const [w, h] = parseRatio(ratio)
  const box = 20
  const scale = box / Math.max(w, h)
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${ratio} (${orientationOf(ratio)})`}
      className={clsx(
        'flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg border px-1 py-1.5 transition-colors',
        active ? 'border-accent bg-accent/15 text-ink' : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
      )}
    >
      <span className="grid h-[22px] w-[22px] place-items-center">
        <span
          className={clsx('rounded-[2px] border-[1.5px]', active ? 'border-accent bg-accent/30' : 'border-current')}
          style={{ width: Math.max(6, w * scale), height: Math.max(6, h * scale) }}
        />
      </span>
      <span className="text-[10.5px] leading-none">{ratio}</span>
    </button>
  )
}
