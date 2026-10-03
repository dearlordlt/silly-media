/**
 * Prompt template engine for Studio batches — a typed port of legacy ui.html
 * (`interpolatePrompt`, `validateBatchJson`, `parsePromptTemplate`,
 * `highlightStoredPrompt`). Semantics are intentionally identical:
 *
 *  - `{name}`        value from the current JSON batch row
 *  - `{name+N}`      value from the row N positions away (circular)
 *  - `[builtin]`     random pick from BUILTIN_VARS, fresh per image
 *  - `[N-M]`         random integer in [N, M]
 *  - `[hairstyle-color]`, `[X-creature]` combo built-ins
 */
import { BUILTIN_VARS } from './builtins'

export type BatchRow = Record<string, unknown>

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

export function capitalizeWords(str: string): string {
  return str.replace(/\b\w/g, (c) => c.toUpperCase())
}

export function randomBuiltin(key: string): string | null {
  const values = BUILTIN_VARS[key.toLowerCase()]
  return values?.length ? values[Math.floor(Math.random() * values.length)] : null
}

/** "with long wavy hair" + "blonde" → "with long wavy blonde hair". */
function hairstyleWithColor(): string {
  const style = randomBuiltin('hairstyle') ?? ''
  const color = randomBuiltin('haircolor') ?? ''
  if (style.includes(' hair')) return style.replace(' hair', ` ${color} hair`)
  if (style.startsWith('with a ')) return `with a ${color} ${style.slice(7)} hair`
  if (style.startsWith('with an ')) return `with a ${color} ${style.slice(8)} hair`
  if (style.startsWith('with ')) return `with ${color} ${style.slice(5)} hair`
  return style
}

/** Resolve every variable in `template`. `rows`/`index` enable `{var±N}` references. */
export function interpolatePrompt(template: string, variables: BatchRow, rows?: BatchRow[], index = 0): string {
  let result = template.replace(/\[hairstyle-color\]/gi, () => hairstyleWithColor())

  result = result.replace(/\[(\w+)-creature\]/gi, (match, prefix: string) =>
    prefix.toLowerCase() === 'hairstyle' ? match : `${prefix} ${capitalizeWords(randomBuiltin('creature') ?? '')}`)

  result = result.replace(/\[(\d+)-(\d+)\]/g, (match, min: string, max: string) => {
    const lo = parseInt(min, 10)
    const hi = parseInt(max, 10)
    if (lo > hi) return match
    return String(Math.floor(Math.random() * (hi - lo + 1)) + lo)
  })

  result = result.replace(/\[(\w+)\]/g, (match, key: string) => {
    const value = randomBuiltin(key)
    if (value === null) return match
    const k = key.toLowerCase()
    return k === 'creature' || k === 'race' ? capitalizeWords(value) : value
  })

  result = result.replace(/\{(\w+)([+-]\d+)?\}/g, (match, key: string, offset: string | undefined) => {
    if (offset && rows?.length) {
      const total = rows.length
      const target = rows[(((index + parseInt(offset, 10)) % total) + total) % total]
      return target && hasOwn(target, key) ? String(target[key]) : match
    }
    return hasOwn(variables, key) ? String(variables[key]) : match
  })

  return result
}

/** True when the template uses `{json}` variables (not allowed in Simple Batch). */
export const hasJsonVariables = (template: string) => /\{(\w+)([+-]\d+)?\}/.test(template)

export type BatchJsonResult =
  | { ok: true; rows: BatchRow[]; keys: string[] }
  | { ok: false; error: string }

/** Validate the JSON Batch textarea. Returns null for empty input. */
export function validateBatchJson(text: string): BatchJsonResult | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    const data: unknown = JSON.parse(trimmed)
    if (!Array.isArray(data)) throw new Error('JSON must be an array of objects')
    if (data.length === 0) throw new Error('Array is empty')
    const rows: BatchRow[] = []
    for (const item of data) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Each item must be an object')
      rows.push(Object.fromEntries(Object.entries(item)))
    }
    const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))]
    return { ok: true, rows, keys }
  } catch (e) {
    let message = e instanceof Error ? e.message : String(e)
    if (e instanceof SyntaxError) {
      const m = message.match(/position (\d+)/)
      if (m) {
        const lines = trimmed.substring(0, parseInt(m[1], 10)).split('\n')
        message = `Syntax error at line ${lines.length}, column ${lines[lines.length - 1].length + 1}: ${message}`
      }
    }
    return { ok: false, error: message }
  }
}

/** One-line description of a saved JSON batch (history list). */
export function summarizeBatchJson(json: string): string {
  const r = validateBatchJson(json)
  return r?.ok ? `${r.rows.length} items: ${r.keys.join(', ')}` : `${json.substring(0, 50)}...`
}

export function shuffle<T>(array: readonly T[]): T[] {
  const arr = [...array]
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

/** Distinct `{name±N}` offsets in the template (batch progress shows who is in the shot). */
export function nameReferences(template: string): number[] {
  const refs = new Set<number>()
  for (const m of template.matchAll(/\{name([+-]\d+)?\}/g)) refs.add(m[1] ? parseInt(m[1], 10) : 0)
  return [...refs].sort((a, b) => a - b)
}

export interface TemplateVariables { json: string[]; ref: string[]; builtin: string[] }

/** Variables used by a template, grouped like the legacy "Highlight Variables" modal. */
export function parsePromptTemplate(template: string): TemplateVariables {
  const uniq = (xs: string[]) => [...new Set(xs)]
  return {
    json: uniq([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1])),
    ref: uniq([...template.matchAll(/\{(\w+[+-]\d+)\}/g)].map((m) => m[1])),
    builtin: uniq(
      [...template.matchAll(/\[(\w+(?:-\w+)?)\]/g)]
        .map((m) => m[1])
        .filter((name) => BUILTIN_VARS[name] !== undefined || /^\d+-\d+$/.test(name)),
    ),
  }
}

export interface PromptSegment {
  text: string
  /** Unset for plain text. */
  type?: 'json' | 'builtin'
  /** Built-in vocabulary the value came from (for user-selected highlighting). */
  varName?: string
}

let builtinIndex: Map<string, string> | null = null
function builtinValueIndex(): Map<string, string> {
  if (!builtinIndex) {
    builtinIndex = new Map()
    for (const [name, values] of Object.entries(BUILTIN_VARS)) {
      for (const v of values) builtinIndex.set(v.toLowerCase(), name)
    }
  }
  return builtinIndex
}

/**
 * Split an already-resolved prompt into segments, marking substrings that came
 * from built-in vocabularies or JSON row values (longest match wins, no overlaps).
 */
export function highlightResolvedPrompt(prompt: string, variables?: BatchRow, rows?: BatchRow[]): PromptSegment[] {
  const builtins = builtinValueIndex()
  const jsonValues = new Set<string>()
  const addValues = (row: BatchRow) => {
    for (const v of Object.values(row)) if (typeof v === 'string' && v) jsonValues.add(v.toLowerCase())
  }
  if (variables) addValues(variables)
  rows?.forEach(addValues)

  const matches: { value: string; varName?: string; type: 'json' | 'builtin' }[] = []
  for (const [value, varName] of builtins) matches.push({ value, varName, type: 'builtin' })
  for (const value of jsonValues) if (!builtins.has(value)) matches.push({ value, type: 'json' })
  matches.sort((a, b) => b.value.length - a.value.length)

  const lower = prompt.toLowerCase()
  const hits: { start: number; end: number; type: 'json' | 'builtin'; varName?: string }[] = []
  for (const m of matches) {
    let idx = 0
    while ((idx = lower.indexOf(m.value, idx)) !== -1) {
      const end = idx + m.value.length
      if (!hits.some((h) => !(end <= h.start || idx >= h.end))) hits.push({ start: idx, end, type: m.type, varName: m.varName })
      idx++
    }
  }
  hits.sort((a, b) => a.start - b.start)

  const out: PromptSegment[] = []
  let last = 0
  for (const h of hits) {
    if (h.start > last) out.push({ text: prompt.slice(last, h.start) })
    out.push({ text: prompt.slice(h.start, h.end), type: h.type, varName: h.varName })
    last = h.end
  }
  if (last < prompt.length) out.push({ text: prompt.slice(last) })
  return out
}
