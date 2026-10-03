/**
 * Media library backed by the local app server (per-profile SQLite + files).
 *
 * Every generated artifact (image / audio / video / 3d model) is stored there
 * with its metadata; this module keeps an in-memory index of the metadata
 * (files stay on disk and are loaded by URL), and follows changes made by other
 * tabs of the same profile over SSE.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { APP_API, CLIENT_ID, appFetch } from './appApi'
import type { ItemRecord } from './appApi'
import { downloadUrl } from './media'

export type MediaKind = 'image' | 'audio' | 'video' | 'model3d'

export interface MediaItem {
  id: string
  kind: MediaKind
  /** Feature that produced it: studio, edit, audio, music, video, three3d, assets, vision… */
  source: string
  name: string
  prompt?: string
  negativePrompt?: string
  model?: string
  seed?: number
  width?: number
  height?: number
  durationSeconds?: number
  meta?: Record<string, unknown>
  createdAt: number
  favorite: boolean
  tags: string[]
  mime: string
  /** File size in bytes. */
  size: number
  /** Same-origin URL of the file (supports Range, immutable). */
  url: string
  /** Preview image (rendered 3D poster, downscaled image), when one exists. */
  thumbUrl?: string
}

export type NewMediaItem = {
  kind: MediaKind
  source: string
  blob: Blob
  name?: string
  prompt?: string
  negativePrompt?: string
  model?: string
  seed?: number
  width?: number
  height?: number
  durationSeconds?: number
  meta?: Record<string, unknown>
  favorite?: boolean
  tags?: string[]
  /** Preview to store alongside (e.g. a 3D poster); large images get one automatically. */
  thumb?: Blob
  id?: string
  createdAt?: number
}

export type MediaPatch = Partial<Pick<MediaItem, 'name' | 'favorite' | 'meta' | 'width' | 'height' | 'durationSeconds' | 'tags' | 'prompt'>>

const opt = <T,>(v: T | null): T | undefined => (v == null ? undefined : v)

function fromRecord(r: ItemRecord): MediaItem {
  return {
    id: r.id,
    kind: r.kind,
    source: r.source,
    name: r.name,
    prompt: opt(r.prompt),
    negativePrompt: opt(r.negativePrompt),
    model: opt(r.model),
    seed: opt(r.seed),
    width: opt(r.width),
    height: opt(r.height),
    durationSeconds: opt(r.durationSeconds),
    meta: opt(r.meta),
    createdAt: r.createdAt,
    favorite: r.favorite,
    tags: r.tags,
    mime: r.mime,
    size: r.size,
    url: `${APP_API}/files/${encodeURIComponent(r.id)}`,
    thumbUrl: r.thumbVersion != null ? `${APP_API}/thumbs/${encodeURIComponent(r.id)}?v=${r.thumbVersion}` : undefined,
  }
}

const listeners = new Set<() => void>()
let cache: MediaItem[] = []

function emit() { for (const l of listeners) l() }

function upsert(item: MediaItem) {
  const i = cache.findIndex((x) => x.id === item.id)
  if (i < 0) cache = [item, ...cache].sort((a, b) => b.createdAt - a.createdAt)
  else cache = cache.map((x) => (x.id === item.id ? item : x))
  emit()
}

function drop(ids: Iterable<string>) {
  const gone = new Set(ids)
  const next = cache.filter((x) => !gone.has(x.id))
  if (next.length !== cache.length) { cache = next; emit() }
}

/** Encode `[uint32 BE json length][json][file]` (see local app-api contract). */
function frame(meta: Record<string, unknown>, blob: Blob): Blob {
  const json = new TextEncoder().encode(JSON.stringify(meta))
  const head = new Uint8Array(4)
  new DataView(head.buffer).setUint32(0, json.length)
  return new Blob([head, json, blob])
}

const THUMB_MAX = 640

/** Downscaled WebP preview for large images; null when not worth it or unsupported. */
async function makeThumb(blob: Blob): Promise<Blob | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const scale = THUMB_MAX / Math.max(bmp.width, bmp.height)
    if (scale >= 0.8) { bmp.close(); return null }
    const w = Math.round(bmp.width * scale)
    const h = Math.round(bmp.height * scale)
    const canvas = new OffscreenCanvas(w, h)
    const ctx = canvas.getContext('2d')
    if (!ctx) { bmp.close(); return null }
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bmp, 0, 0, w, h)
    bmp.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.86 })
  } catch {
    return null
  }
}

async function putThumb(id: string, thumb: Blob): Promise<MediaItem> {
  const rec = await appFetch<ItemRecord>(`/items/${encodeURIComponent(id)}/thumb`, {
    method: 'PUT', body: thumb, headers: { 'Content-Type': thumb.type || 'image/png' },
  })
  const item = fromRecord(rec)
  upsert(item)
  return item
}

export const library = {
  all: () => cache,
  get: (id: string) => cache.find((i) => i.id === id),
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },

  async add(input: NewMediaItem): Promise<MediaItem> {
    const { blob, thumb, ...rest } = input
    const meta = { ...rest, name: rest.name ?? '', mime: blob.type || 'application/octet-stream' }
    const rec = await appFetch<ItemRecord>('/items', {
      method: 'POST', body: frame(meta, blob), headers: { 'Content-Type': 'application/x-silly-item' },
    })
    const item = fromRecord(rec)
    upsert(item)
    if (thumb) return putThumb(item.id, thumb)
    if (item.kind === 'image') {
      // Grid previews: don't make every tile decode a 2K PNG. Best-effort, off the critical path.
      void makeThumb(blob).then((t) => (t ? putThumb(item.id, t) : null)).catch(() => undefined)
    }
    return item
  },

  async update(id: string, patch: MediaPatch & { thumb?: Blob }): Promise<void> {
    const { thumb, ...fields } = patch
    if (Object.keys(fields).length) {
      upsert(fromRecord(await appFetch<ItemRecord>(`/items/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(fields) })))
    }
    if (thumb) await putThumb(id, thumb)
  },

  async remove(id: string): Promise<void> {
    await appFetch<void>(`/items/${encodeURIComponent(id)}`, { method: 'DELETE' })
    drop([id])
  },

  async removeMany(ids: string[]): Promise<void> {
    if (!ids.length) return
    await appFetch<{ deleted: number }>('/items/delete', { method: 'POST', body: JSON.stringify({ ids }) })
    drop(ids)
  },

  async clear(kind?: MediaKind): Promise<void> {
    await appFetch<{ deleted: number }>(`/items${kind ? `?kind=${kind}` : ''}`, { method: 'DELETE' })
    drop(cache.filter((i) => !kind || i.kind === kind).map((i) => i.id))
  },
}

/** The item's file as a Blob (fetched; the browser cache usually serves it). */
export async function itemBlob(item: Pick<MediaItem, 'url'>): Promise<Blob> {
  const res = await fetch(item.url)
  if (!res.ok) throw new Error(`Could not load file (${res.status})`)
  return res.blob()
}

const KIND_EXT: Record<MediaKind, string> = { image: 'png', audio: 'wav', video: 'mp4', model3d: 'glb' }
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac', 'audio/ogg': 'ogg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'model/gltf-binary': 'glb',
}

/** File extension for the item's MIME type, else its kind's default. */
export function itemExtension(item: Pick<MediaItem, 'mime' | 'kind'>): string {
  return MIME_EXT[item.mime] ?? KIND_EXT[item.kind]
}

/** Safe download filename with the right extension (from MIME, else kind). */
export function itemFilename(item: MediaItem): string {
  const stem = (item.name || item.source || item.kind)
    .replace(/[^\w.\- ]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60) || item.kind
  return `${stem}-${item.id.slice(0, 6)}.${itemExtension(item)}`
}

/** Download the stored file (server sets Content-Disposition; no blob round-trip). */
export function downloadItem(item: MediaItem, filename = itemFilename(item)): void {
  downloadUrl(`${item.url}?download=${encodeURIComponent(filename)}`, filename)
}

export type LibraryStatus = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string }

let status: LibraryStatus = { state: 'loading' }

async function fetchAll(): Promise<MediaItem[]> {
  const { items } = await appFetch<{ items: ItemRecord[] }>('/items')
  return items.map(fromRecord)
}

/** SSE payloads from /app-api/events. */
interface ItemEvent { op: 'add' | 'update' | 'delete'; id: string; item?: ItemRecord; client?: string }
interface ClearEvent { ids: string[]; client?: string }

function follow() {
  const es = new EventSource(`${APP_API}/events`)
  let dropped = false
  es.addEventListener('error', () => { dropped = true })
  // Events sent while disconnected (server restart, sleep) are lost: resync.
  es.addEventListener('open', () => {
    if (!dropped) return
    dropped = false
    fetchAll().then((items) => { cache = items; emit() }, () => undefined)
  })
  es.addEventListener('item', (e) => {
    const ev: ItemEvent = JSON.parse(e.data)
    if (ev.client === CLIENT_ID) return
    if (ev.op === 'delete') drop([ev.id])
    else if (ev.item) upsert(fromRecord(ev.item))
  })
  es.addEventListener('clear', (e) => {
    const ev: ClearEvent = JSON.parse(e.data)
    if (ev.client !== CLIENT_ID) drop(ev.ids)
  })
}

/** Load the index and start following other tabs. Called once at boot. */
export async function initLibrary(): Promise<void> {
  try {
    cache = await fetchAll()
    status = { state: 'ready' }
    follow()
  } catch (e) {
    status = { state: 'error', message: e instanceof Error ? e.message : String(e) }
  }
  emit()
}

const EMPTY: MediaItem[] = []

export function useLibrary(kind?: MediaKind): MediaItem[] {
  const items = useSyncExternalStore(library.subscribe, () => cache, () => EMPTY)
  // Stable identity per (cache, kind) so consumers' memo/effect deps don't churn.
  return useMemo(() => (kind ? items.filter((i) => i.kind === kind) : items), [items, kind])
}

/** Hydration state of the library (loading / ready / failed). */
export function useLibraryStatus(): LibraryStatus {
  return useSyncExternalStore(library.subscribe, () => status, () => status)
}

/** All tags in use, most used first. */
export function useLibraryTags(): string[] {
  const items = useLibrary()
  return useMemo(() => {
    const counts = new Map<string, number>()
    for (const i of items) for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t)
  }, [items])
}
