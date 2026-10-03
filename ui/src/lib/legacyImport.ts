/**
 * One-time import of the pre-app-server browser storage (IndexedDB library +
 * localStorage settings) into the current profile. The old data is per browser
 * origin, so it is only visible when the UI is opened on the origin that wrote
 * it (http://127.0.0.1:5273 for the default profile).
 */
import { useEffect, useState } from 'react'
import { AppApiError } from './appApi'
import { kv } from './kv'
import { library } from './library'
import type { MediaKind } from './library'

const DB_NAME = 'silly-media-library'
const STORE = 'items'
const DONE_KEY = 'silly-legacy-import'
const DISMISS_KEY = 'silly-legacy-import-dismissed'

interface LegacyRecord {
  id: string
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
  createdAt: number
  favorite?: boolean
  thumb?: Blob
}

export interface LegacySummary {
  items: number
  keys: number
  imported: { at: number; imported: number; skipped: number; keys: number } | null
  dismissed: boolean
}

async function legacyDbExists(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false
  if ('databases' in indexedDB) {
    const dbs = await indexedDB.databases()
    return dbs.some((d) => d.name === DB_NAME)
  }
  return true
}

/** Open without creating: an upgrade from version 0 means it never existed. */
function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME)
    let created = false
    req.onupgradeneeded = () => { created = true; req.transaction?.abort() }
    req.onsuccess = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) { db.close(); resolve(null) } else resolve(db)
    }
    req.onerror = () => (created ? resolve(null) : reject(req.error))
  })
}

function legacyKeys(): string[] {
  try {
    return Object.keys(localStorage)
  } catch {
    return []
  }
}

export async function detectLegacy(): Promise<LegacySummary> {
  const base = {
    imported: kv.getJson<LegacySummary['imported']>(DONE_KEY, null),
    dismissed: kv.getItem(DISMISS_KEY) === '1',
    keys: legacyKeys().length,
  }
  if (!(await legacyDbExists())) return { ...base, items: 0 }
  const db = await openLegacy()
  if (!db) return { ...base, items: 0 }
  const items = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count()
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  db.close()
  return { ...base, items }
}

async function readAll(db: IDBDatabase): Promise<LegacyRecord[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result as LegacyRecord[])
    req.onerror = () => reject(req.error)
  })
}

/** Copy legacy items (skipping ids already present) and unset settings into this profile. */
export async function importLegacy(onProgress?: (done: number, total: number) => void) {
  let imported = 0
  let skipped = 0
  const db = await openLegacy()
  if (db) {
    const records = await readAll(db)
    db.close()
    records.sort((a, b) => a.createdAt - b.createdAt)
    for (const [i, r] of records.entries()) {
      if (library.get(r.id)) skipped++
      else {
        try {
          await library.add({
            id: r.id, kind: r.kind, source: r.source, blob: r.blob, name: r.name, prompt: r.prompt,
            negativePrompt: r.negativePrompt, model: r.model, seed: r.seed, width: r.width, height: r.height,
            durationSeconds: r.durationSeconds, meta: r.meta, createdAt: r.createdAt, favorite: r.favorite ?? false,
            thumb: r.thumb,
          })
          imported++
        } catch (e) {
          if (e instanceof AppApiError && e.status === 409) skipped++
          else throw e
        }
      }
      onProgress?.(i + 1, records.length)
    }
  }
  let keys = 0
  for (const key of legacyKeys()) {
    const value = localStorage.getItem(key)
    if (value != null && kv.getItem(key) == null) { kv.setItem(key, value); keys++ }
  }
  const summary = { at: Date.now(), imported, skipped, keys }
  kv.setJson(DONE_KEY, summary)
  await kv.flush()
  return summary
}

/** Delete the old browser copy (only after a successful import). */
export async function removeLegacy(): Promise<void> {
  try { localStorage.clear() } catch { /* unavailable */ }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

export function dismissLegacy(): void {
  kv.setItem(DISMISS_KEY, '1')
}

/** Legacy storage summary for banners/settings; `refresh()` after import/remove. */
export function useLegacyImport(): { summary: LegacySummary | null; refresh: () => void } {
  const [summary, setSummary] = useState<LegacySummary | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    detectLegacy().then((s) => { if (alive) setSummary(s) }, () => { if (alive) setSummary(null) })
    return () => { alive = false }
  }, [tick])
  return { summary, refresh: () => setTick((t) => t + 1) }
}
