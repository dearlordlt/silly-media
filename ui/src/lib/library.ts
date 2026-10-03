/**
 * Local media library persisted in IndexedDB.
 *
 * Every generated artifact (image / audio / video / 3d model) is stored here as
 * a blob plus its metadata so the app has a durable, cross-feature library that
 * survives reloads — the old per-page UIs each had their own throwaway lists.
 */
import { useMemo, useSyncExternalStore } from 'react'

export type MediaKind = 'image' | 'audio' | 'video' | 'model3d'

export interface MediaItem {
  id: string
  kind: MediaKind
  /** Feature that produced it: studio, edit, audio, music, video, three3d, assets, vision… */
  source: string
  blob: Blob
  url: string
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
  favorite?: boolean
  /** Persisted preview image (e.g. a rendered poster for 3D models). */
  thumb?: Blob
  /** Runtime object URL for `thumb`; never persisted. */
  thumbUrl?: string
}

/** Runtime-only fields stripped before writing to IndexedDB. */
function toRecord(item: MediaItem): Omit<MediaItem, 'url' | 'thumbUrl'> {
  const { url: _url, thumbUrl: _thumbUrl, ...record } = item
  return record
}

function withUrls(item: Omit<MediaItem, 'url' | 'thumbUrl'>): MediaItem {
  return { ...item, url: URL.createObjectURL(item.blob), thumbUrl: item.thumb ? URL.createObjectURL(item.thumb) : undefined }
}

function revokeUrls(item: MediaItem) {
  URL.revokeObjectURL(item.url)
  if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl)
}

const DB_NAME = 'silly-media-library'
const DB_VERSION = 1
const STORE = 'items'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error)
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
        store.createIndex('kind', 'kind')
        store.createIndex('source', 'source')
      }
    }
  })
  return dbPromise
}

const listeners = new Set<() => void>()
let cache: MediaItem[] = []

function emit() { for (const l of listeners) l() }

async function hydrate() {
  const db = await openDb()
  const items = await new Promise<MediaItem[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    tx.onsuccess = () => resolve(tx.result as MediaItem[])
    tx.onerror = () => reject(tx.error)
  })
  cache = items.map(withUrls).sort((a, b) => b.createdAt - a.createdAt)
  emit()
}

export const library = {
  all: () => cache,
  subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l) },

  async add(input: Omit<MediaItem, 'id' | 'url' | 'thumbUrl' | 'createdAt'> & { id?: string; createdAt?: number }): Promise<MediaItem> {
    const item = withUrls({ ...input, id: input.id ?? crypto.randomUUID(), createdAt: input.createdAt ?? Date.now() })
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(toRecord(item))
      tx.onsuccess = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    cache = [item, ...cache]
    emit()
    return item
  },

  async update(id: string, patch: Partial<Pick<MediaItem, 'name' | 'favorite' | 'meta' | 'width' | 'height' | 'durationSeconds' | 'thumb'>>) {
    const item = cache.find((i) => i.id === id)
    if (!item) return
    const next: MediaItem = { ...item, ...patch }
    if (patch.thumb) next.thumbUrl = URL.createObjectURL(patch.thumb)
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(toRecord(next))
      tx.onsuccess = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    cache = cache.map((i) => (i.id === id ? next : i))
    emit()
    const stale = patch.thumb ? item.thumbUrl : undefined
    if (stale) setTimeout(() => URL.revokeObjectURL(stale), 0)
  },

  async remove(id: string) {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
      tx.onsuccess = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const gone = cache.find((i) => i.id === id)
    cache = cache.filter((i) => i.id !== id)
    emit()
    // Revoke after consumers re-rendered without it, so no <img> is mid-load.
    if (gone) setTimeout(() => revokeUrls(gone), 0)
  },

  async clear(kind?: MediaKind) {
    const db = await openDb()
    const doomed = kind ? cache.filter((i) => i.kind === kind) : cache
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const store = tx.objectStore(STORE)
      for (const i of doomed) store.delete(i.id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    cache = kind ? cache.filter((i) => i.kind !== kind) : []
    emit()
    setTimeout(() => { for (const i of doomed) revokeUrls(i) }, 0)
  },
}

const KIND_EXT: Record<MediaKind, string> = { image: 'png', audio: 'wav', video: 'mp4', model3d: 'glb' }
const MIME_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/flac': 'flac',
  'video/mp4': 'mp4', 'model/gltf-binary': 'glb',
}

/** Safe download filename with the right extension (from MIME, else kind). */
export function itemFilename(item: MediaItem): string {
  const stem = (item.name || item.source || item.kind)
    .replace(/[^\w.\- ]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, 60) || item.kind
  const ext = MIME_EXT[item.blob.type] ?? KIND_EXT[item.kind]
  return `${stem}-${item.id.slice(0, 6)}.${ext}`
}

export type LibraryStatus = { state: 'loading' } | { state: 'ready' } | { state: 'error'; message: string }

let status: LibraryStatus = { state: 'loading' }

if (typeof indexedDB === 'undefined') {
  status = { state: 'error', message: 'IndexedDB is not available in this browser' }
} else {
  hydrate().then(
    () => { status = { state: 'ready' }; emit() },
    (e: unknown) => {
      status = { state: 'error', message: e instanceof Error ? e.message : String(e) }
      emit()
    },
  )
}

const EMPTY: MediaItem[] = []

export function useLibrary(kind?: MediaKind): MediaItem[] {
  const items = useSyncExternalStore(library.subscribe, () => cache, () => EMPTY)
  // Stable identity per (cache, kind) so consumers' memo/effect deps don't churn.
  return useMemo(() => (kind ? items.filter((i) => i.kind === kind) : items), [items, kind])
}

/** Hydration state of the local library (loading / ready / failed). */
export function useLibraryStatus(): LibraryStatus {
  return useSyncExternalStore(library.subscribe, () => status, () => status)
}
