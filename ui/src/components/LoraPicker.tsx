/**
 * Stackable user LoRAs for one model (GET /loras?model=<id>), shared by Studio and Edit.
 * Renders nothing for models without LoRA support. `value` may hold LoRAs of other
 * model families (the selection is kept across model switches); only this model's
 * family is shown, and `activeLorasFor` filters what gets sent.
 */
import { clsx } from 'clsx'
import { RefreshCw } from 'lucide-react'
import type { LoraInfo, LoraSpec, ModelLorasResponse } from '../lib/types'
import { useModelLoras } from '../lib/query'
import { Button, IconButton, Section, Slider, Switch } from './ui/primitives'

/** The LoRAs from `value` that belong to this model's family (what a request should carry). */
export function activeLorasFor(value: LoraSpec[], data: ModelLorasResponse | undefined): LoraSpec[] {
  if (!data?.supported) return []
  return value.filter((x) => data.loras.some((l) => l.name === x.name))
}

function tooltip(l: LoraInfo): string {
  return [l.name, l.description, l.recommended && `Recommended: ${l.recommended}`, `${l.size_mb} MB`].filter(Boolean).join('\n')
}

export function LoraPicker({ model, value, onChange, mode }: {
  model: string
  value: LoraSpec[]
  onChange: (loras: LoraSpec[]) => void
  /** Hide LoRAs whose sidecar says they're not meant for this mode. */
  mode: 'generate' | 'edit'
}) {
  const { data, isError, refetch, isFetching } = useModelLoras(model)
  if (!data?.supported && !isError) return null

  const installed = (data?.loras ?? []).filter((l) => !l.modes || l.modes.includes(mode))
  const active = activeLorasFor(value, data)
  const others = value.filter((x) => !active.includes(x))
  const dir = data?.family && data.family !== 'z-image' ? `data/loras/${data.family}` : 'data/loras'

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          LoRAs
          {active.length > 0 && <span className="rounded-full bg-accent/20 px-1.5 py-px text-[10.5px] font-semibold text-accent">{active.length} active</span>}
        </span>
      }
      action={
        <div className="flex items-center gap-1">
          {active.length > 0 && <Button variant="ghost" size="sm" onClick={() => onChange(others)} title="Turn all LoRAs off">Clear</Button>}
          <span className="text-[11px] text-ink-faint">{installed.length} installed</span>
          <IconButton onClick={() => void refetch()} title="Reload LoRA list from server">
            <RefreshCw size={13} className={clsx(isFetching && 'animate-spin')} />
          </IconButton>
        </div>
      }
    >
      {isError ? <p className="text-[11.5px] text-bad">Could not load LoRA list.</p>
        : installed.length ? (
          <div className="flex flex-col gap-1.5">
            {installed.map((l) => {
              const on = active.find((x) => x.name === l.name)
              return (
                <div key={l.name} className={clsx('flex flex-col gap-2 rounded-lg border px-2.5 py-2', on ? 'border-accent/50 bg-accent/10' : 'border-line')} title={tooltip(l)}>
                  <div className="flex items-center justify-between gap-2">
                    <Switch
                      checked={!!on}
                      onChange={(enable) => onChange(enable
                        ? [...value, { name: l.name, scale: l.default_scale ?? 1 }]
                        : value.filter((x) => x.name !== l.name))}
                      label={<span className={clsx('break-all text-[12.5px]', on ? 'text-ink' : 'text-ink-dim')}>{l.display_name || l.name}</span>}
                    />
                    <span className="shrink-0 text-[10.5px] text-ink-faint">{l.size_mb} MB</span>
                  </div>
                  {on && (
                    <>
                      <Slider
                        label="Scale"
                        value={on.scale}
                        min={0}
                        max={2}
                        step={0.05}
                        onValueChange={(v) => onChange(value.map((x) => (x.name === l.name ? { ...x, scale: v } : x)))}
                        format={(v) => `× ${v.toFixed(2)}`}
                      />
                      {l.recommended && <p className="text-[10.5px] text-ink-faint">Recommended: {l.recommended}</p>}
                    </>
                  )}
                </div>
              )
            })}
          </div>
        ) : <p className="text-[11.5px] text-ink-faint">No LoRAs installed — drop .safetensors files into {dir}.</p>}
    </Section>
  )
}
