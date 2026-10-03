/** Display helpers for library items: readable titles, kind/model labels, relative times. */
import { library } from '../lib/library'
import type { MediaItem, MediaKind } from '../lib/library'

export const KIND_LABEL: Record<MediaKind, string> = { image: 'Image', audio: 'Audio', video: 'Video', model3d: '3D' }

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Name segments that carry no meaning on their own (clock times, indices, auto ids). */
const TIME_RE = /^\d{1,2}:\d{2}(:\d{2})?(\s?[ap]\.?m\.?)?$/i
const INDEX_RE = /^#?\d+$/
const AUTO_ID_RE = /^[a-z0-9]+[-_]\d{4}-\d{2}-\d{2}[-_\dT:.]*$/i

/** Prompt as a readable sentence: no LoRA tags or attention weights, tidy punctuation. */
export function cleanPrompt(prompt: string): string {
  const s = norm(
    prompt
      .replace(/<[^>]*>/g, ' ')
      .replace(/\(([^():]+):\s*[\d.]+\)/g, '$1')
      .replace(/[()[\]{}]/g, ' ')
      .replace(/\bBREAK\b/g, ' ')
      .replace(/\s*,\s*(,\s*)+/g, ', '),
  ).replace(/^[\s,.;:–—-]+|[\s,;:–—-]+$/g, '')
  return s ? s[0].toUpperCase() + s.slice(1) : ''
}

/** Model id → short label: last path segment without a weights extension. */
export function modelLabel(model: string | undefined): string | undefined {
  if (!model) return undefined
  const last = model.split(/[\\/]/).filter(Boolean).pop() ?? model
  return last.replace(/\.(safetensors|ckpt|gguf|bin|pt|pth)$/i, '') || undefined
}

/** The item's name segments minus auto-generated noise (model/source prefixes, times, indices, timestamps). */
function nameSegments(item: MediaItem): string[] {
  const noise = new Set([item.source, item.model, modelLabel(item.model), item.kind].filter(Boolean).map((s) => String(s).toLowerCase()))
  return norm(item.name)
    .split(' · ')
    .map((seg) => seg.replace(/(…|\.{2,})$/, '').trim())
    .filter((seg) => seg && !TIME_RE.test(seg) && !INDEX_RE.test(seg) && !AUTO_ID_RE.test(seg) && !noise.has(seg.toLowerCase()))
}

/**
 * Best human title: a meaningful name (e.g. an edit label) when there is one,
 * otherwise the prompt — names built from a truncated prompt lose to it.
 */
export function itemTitle(item: MediaItem): string {
  const prompt = item.prompt ? cleanPrompt(item.prompt) : ''
  const segs = nameSegments(item)
  const name = segs.join(' · ')
  if (!name) return prompt || `Untitled ${KIND_LABEL[item.kind].toLowerCase()}`
  if (!prompt) return name
  // Speech: the spoken text describes the clip; the voice is shown separately.
  if (item.kind === 'audio') return prompt
  const raw = norm(item.prompt ?? '').toLowerCase()
  const cleaned = prompt.toLowerCase()
  const derived = segs.some((s) => s.length >= 3 && (raw.includes(s.toLowerCase()) || cleaned.includes(s.toLowerCase())))
  return derived || name.length < 3 ? prompt : name
}

/** Voice for speech items (actor name or voice description), when recorded. */
export function voiceLabel(item: MediaItem): string | undefined {
  const actor = item.meta?.actor
  if (typeof actor === 'string' && actor) return actor
  const desc = item.meta?.voice_description
  if (typeof desc === 'string' && desc) return desc.length > 40 ? `${desc.slice(0, 40)}…` : desc
  return undefined
}

/** "just now", "5m ago", "3h ago", "yesterday", "4d ago", else a short date. */
export function relativeTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, (now - ts) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 172800) return 'yesterday'
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  const d = new Date(ts)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' })
}

/** Delete one item: the caller's handler when given, else confirm (per settings) + remove. */
export async function removeItem(item: MediaItem, confirmDeletes: boolean, onDelete?: (item: MediaItem) => void): Promise<void> {
  if (onDelete) { onDelete(item); return }
  if (confirmDeletes && !confirm('Delete this item?')) return
  await library.remove(item.id)
}
