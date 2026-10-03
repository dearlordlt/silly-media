/** Studio-only views: highlighted prompt, saved-text lists, help/highlight/vision dialogs. */
import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { Star, X } from 'lucide-react'
import type { MediaItem } from '../../lib/library'
import { itemBlob } from '../../lib/library'
import { useClient, errorMessage } from '../../lib/hooks'
import { blobToDataUrl, stripDataUrl } from '../../lib/media'
import { Modal } from '../../components/ui/Modal'
import { Button, IconButton, Spinner } from '../../components/ui/primitives'
import type { BatchRow } from './batch'
import { highlightResolvedPrompt, parsePromptTemplate } from './batch'
import type { TextHistory } from './history'

/** Resolved prompt with built-in (green) and JSON (pink) values highlighted. */
export function PromptView({ prompt, variables, rows, highlights }: {
  prompt: string
  variables?: BatchRow
  rows?: BatchRow[]
  /** Built-in variable names the user chose to emphasise. */
  highlights: ReadonlySet<string>
}) {
  return (
    <span className="whitespace-pre-wrap break-words">
      {highlightResolvedPrompt(prompt, variables, rows).map((seg, i) => {
        if (!seg.type) return <span key={i}>{seg.text}</span>
        if (seg.type === 'json') return <span key={i} className="font-semibold text-accent">{seg.text}</span>
        return (
          <span
            key={i}
            className={clsx('font-semibold text-good', seg.varName && highlights.has(seg.varName) && 'rounded-sm bg-black/60 px-0.5')}
          >
            {seg.text}
          </span>
        )
      })}
    </span>
  )
}

/** Pinned/saved history list (prompt, negative prompt, batch JSON). */
export function HistoryList({ history, onApply, render, empty }: {
  history: TextHistory
  onApply: (text: string) => void
  render?: (text: string) => string
  empty: string
}) {
  if (!history.entries.length) return <p className="text-[11.5px] text-ink-faint">{empty}</p>
  return (
    <div className="flex flex-col gap-2">
      <div className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1">
        {history.sorted.map(({ entry, index }) => (
          <div
            key={`${index}-${entry.timestamp}`}
            className="group flex cursor-pointer items-center gap-1.5 rounded-lg border border-line px-2 py-1.5 hover:border-line-strong"
            title={entry.text}
            onClick={() => onApply(entry.text)}
          >
            <IconButton
              title={entry.favorite ? 'Unpin' : 'Pin'}
              onClick={(e) => { e.stopPropagation(); history.toggleFavorite(index) }}
            >
              <Star size={12} className={clsx(entry.favorite ? 'fill-warn text-warn' : 'text-ink-faint')} />
            </IconButton>
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-dim">{render ? render(entry.text) : entry.text}</span>
            <IconButton
              title="Remove"
              className="opacity-0 group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); history.remove(index) }}
            >
              <X size={12} />
            </IconButton>
          </div>
        ))}
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => { if (confirm('Clear all history?')) history.clear() }}
      >
        Clear history
      </Button>
    </div>
  )
}

const BUILTIN_HELP: [string, string][] = [
  ['[occupation]', 'teacher, nurse, waitress, police officer, etc.'],
  ['[location]', 'bedroom, beach, forest, city street, etc.'],
  ['[time]', 'at dawn, at sunset, at night, etc.'],
  ['[weather]', 'sunny, rainy, foggy, stormy, etc.'],
  ['[mood]', 'peaceful, dramatic, romantic, etc.'],
  ['[lighting]', 'soft natural light, neon lights, candlelight, etc.'],
  ['[color]', 'red, emerald, navy, gold, lavender, etc.'],
  ['[size]', 'small, medium, large'],
  ['[pose]', 'standing, sitting, dancing, kneeling, etc.'],
  ['[object]', 'chair, bed, table, stairs, swing, etc.'],
  ['[race]', 'caucasian, african, asian, latino, etc.'],
  ['[expression]', 'smiling, serious, laughing, seductive, etc.'],
  ['[hairstyle]', 'with long wavy hair, with a ponytail, with bangs, etc.'],
  ['[haircolor]', 'blonde, brunette, red, black, pink, etc.'],
  ['[hairstyle-color]', 'combines both: with long wavy blonde hair, with a red ponytail'],
  ['[bodytype]', 'petite body, slender figure, athletic build, hourglass figure, etc.'],
  ['[creature]', 'elf, orc, vampire, succubus, nymph, tiefling, catgirl, etc.'],
  ['[X-creature]', 'prefix + random creature: [female-creature] → female elf, [male-creature] → male orc'],
  ['[accessory]', 'glasses, hat, choker, tattoo, earrings, gloves, etc.'],
]

function HelpBlock({ children }: { children: string }) {
  return <pre className="whitespace-pre-wrap rounded-lg bg-bg p-3 font-mono text-[11.5px] text-ink-dim">{children}</pre>
}

export function VariablesHelpDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Batch mode variables" width="max-w-2xl">
      <div className="flex flex-col gap-4 text-[12.5px] text-ink-dim">
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold text-ink">JSON variables <code className="text-accent">{'{variable}'}</code></h4>
          <p>Use values from your JSON data:</p>
          <HelpBlock>{'Prompt: "{name} wearing {outfit}"\nJSON: [{"name": "Alice", "outfit": "red dress"}]\nResult: "Alice wearing red dress"'}</HelpBlock>
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold text-ink">Relative references <code className="text-accent">{'{variable+N}'}</code></h4>
          <p>Reference other items in the batch (circular):</p>
          <HelpBlock>{'Prompt: "{name} with {name+1}"\nJSON: [{"name": "Alice"}, {"name": "Bob"}, {"name": "Charlie"}]\nResults:\n  1: "Alice with Bob"\n  2: "Bob with Charlie"\n  3: "Charlie with Alice" (wraps around)'}</HelpBlock>
          <p><code>{'{name-1}'}</code> gets the previous item, <code>{'{name+2}'}</code> skips one, etc.</p>
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold text-ink">Random built-ins <code className="text-good">[variable]</code></h4>
          <p>Random values picked fresh for each image (also in single Generate and the negative prompt):</p>
          <table className="w-full text-[12px]">
            <tbody>
              {BUILTIN_HELP.map(([k, v]) => (
                <tr key={k} className="border-b border-line/60">
                  <td className="py-1 pr-3 font-mono text-good">{k}</td>
                  <td className="py-1">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold text-ink">Number ranges <code className="text-good">[N-M]</code></h4>
          <p>Random integer between N and M (inclusive):</p>
          <HelpBlock>{'"[race] woman, [20-35] years old, [expression]"\n→ "asian woman, 27 years old, smiling"'}</HelpBlock>
        </section>
        <section className="flex flex-col gap-2">
          <h4 className="font-semibold text-ink">Examples</h4>
          <HelpBlock>{'"{name} [hairstyle-color], [pose] in [location], [expression]"\n→ "Alice with a blonde ponytail, sitting in coffee shop, laughing"\n\n"[bodytype] [race] woman [hairstyle-color], [expression]"\n→ "curvy asian woman with long wavy red hair, seductive"\n\n"{name} [hairstyle-color], [bodytype] body, [pose] on [object]"\n→ "Alice with a messy brunette bun, athletic body, leaning on railing"'}</HelpBlock>
        </section>
      </div>
    </Modal>
  )
}

/** Legacy "Highlight Variables" (🔍): pick built-ins to emphasise in shown prompts. */
export function HighlightVarsDialog({ open, onClose, template, selected, onToggle, onClear }: {
  open: boolean
  onClose: () => void
  template: string
  selected: ReadonlySet<string>
  onToggle: (name: string) => void
  onClear: () => void
}) {
  const parsed = parsePromptTemplate(template.trim())
  const groups: { title: string; dot: string; names: string[]; wrap: (n: string) => string }[] = [
    { title: 'JSON variables', dot: 'bg-accent', names: parsed.json, wrap: (n) => `{${n}}` },
    { title: 'Relative references', dot: 'bg-accent-2', names: parsed.ref, wrap: (n) => `{${n}}` },
    { title: 'Built-in variables', dot: 'bg-good', names: parsed.builtin, wrap: (n) => `[${n}]` },
  ]
  const any = groups.some((g) => g.names.length)
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Highlight variables"
      width="max-w-lg"
      footer={<><Button variant="ghost" size="sm" onClick={onClear}>Clear all</Button><Button size="sm" onClick={onClose}>Close</Button></>}
    >
      {!template.trim() ? <p className="text-[12.5px] text-ink-faint">Enter a prompt first.</p>
        : !any ? <p className="text-[12.5px] text-ink-faint">No variables found in prompt.</p>
          : (
            <div className="flex flex-col gap-4">
              {groups.filter((g) => g.names.length).map((g) => (
                <div key={g.title}>
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-ink-dim">
                    <span className={clsx('h-2 w-2 rounded-full', g.dot)} />{g.title}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {g.names.map((n) => (
                      <button
                        key={n}
                        onClick={() => onToggle(n)}
                        className={clsx(
                          'rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors',
                          selected.has(n) ? 'border-accent bg-accent/20 text-ink' : 'border-transparent bg-bg text-ink-dim hover:bg-panel-2',
                        )}
                      >
                        {g.wrap(n)}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <p className="text-[11px] text-ink-faint">Selected built-ins get a dark highlight in the latest preview and the image viewer.</p>
            </div>
          )}
    </Modal>
  )
}

const VISION_PROMPT = `Describe this image in comprehensive detail. Include:

- The main subject(s) and their appearance
- If there is a person and they appear to be a known public figure, celebrity, or fictional character, identify who they might be
- For each person visible, estimate their age (provide your best guess as a specific number, e.g., "approximately 34 years old")
- Location: identify where this might be (known landmark, city, country, or fictional location from a movie/game/book). If you can't identify a specific place, describe what type of location it appears to be
- Colors, lighting, and atmosphere
- Any text visible in the image
- The overall mood or style
- Notable details that stand out

Be thorough and specific in your description.`

/** Legacy one-click "Vision" analysis of a gallery image. */
export function VisionDialog({ item, onClose, onOpenInVision }: {
  item: MediaItem | null
  onClose: () => void
  onOpenInVision: (item: MediaItem) => void
}) {
  const client = useClient()
  const [result, setResult] = useState<{ text?: string; error?: string } | null>(null)

  useEffect(() => {
    if (!item) return
    const ctrl = new AbortController()
    setResult(null)
    void (async () => {
      try {
        const image = stripDataUrl(await blobToDataUrl(await itemBlob(item)))
        const res = await client.vision({ image, query: VISION_PROMPT, temperature: 0.7 }, ctrl.signal)
        setResult({ text: res.response })
      } catch (e) {
        if (!ctrl.signal.aborted) setResult({ error: errorMessage(e) })
      }
    })()
    return () => ctrl.abort()
  }, [item, client])

  return (
    <Modal
      open={!!item}
      onClose={onClose}
      title="Vision analysis"
      width="max-w-5xl"
      footer={item && <Button size="sm" onClick={() => onOpenInVision(item)}>Open in Vision page</Button>}
    >
      {item && (
        <div className="grid gap-5 lg:grid-cols-[1fr_1fr]">
          <div className="grid place-items-center rounded-xl bg-bg p-3">
            <img src={item.url} alt="" className="max-h-[65vh] max-w-full object-contain" />
          </div>
          <div className="text-[13px] leading-relaxed text-ink-dim">
            {!result ? <div className="flex items-center gap-2 text-ink-faint"><Spinner /> Analyzing image…</div>
              : result.error ? <div className="text-bad">Error: {result.error}</div>
                : <div className="whitespace-pre-wrap">{result.text}</div>}
          </div>
        </div>
      )}
    </Modal>
  )
}
