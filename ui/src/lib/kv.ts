/**
 * Per-profile key-value settings stored by the app server (replaces
 * localStorage, which is per-browser-origin and so would leak between
 * profiles). Hydrated once before the first render, then read synchronously;
 * writes are batched and flushed shortly after, and on tab hide.
 */
import { appFetch, APP_API, CLIENT_ID } from './appApi'

const values = new Map<string, string>()
const pendingSet = new Map<string, string>()
const pendingDelete = new Set<string>()
let timer: ReturnType<typeof setTimeout> | null = null

const FLUSH_MS = 300
/** fetch keepalive / sendBeacon payload ceiling. */
const KEEPALIVE_MAX = 60_000

function batch(): { set: Record<string, string>; delete: string[] } | null {
  if (!pendingSet.size && !pendingDelete.size) return null
  const body = { set: Object.fromEntries(pendingSet), delete: [...pendingDelete] }
  pendingSet.clear()
  pendingDelete.clear()
  return body
}

async function flush(): Promise<void> {
  timer = null
  const body = batch()
  if (!body) return
  try {
    await appFetch('/kv', { method: 'POST', body: JSON.stringify(body) })
  } catch (e) {
    // Re-queue unless a newer write superseded it; retry on the next change or hide.
    for (const [k, v] of Object.entries(body.set)) if (!pendingSet.has(k) && !pendingDelete.has(k)) pendingSet.set(k, v)
    for (const k of body.delete) if (!pendingSet.has(k)) pendingDelete.add(k)
    console.warn('settings flush failed', e)
  }
}

function schedule() {
  if (timer == null) timer = setTimeout(() => void flush(), FLUSH_MS)
}

function flushOnHide() {
  if (timer != null) { clearTimeout(timer); timer = null }
  const body = batch()
  if (!body) return
  const json = JSON.stringify(body)
  if (json.length <= KEEPALIVE_MAX && navigator.sendBeacon(`${APP_API}/kv`, new Blob([json], { type: 'text/plain' }))) return
  void fetch(`${APP_API}/kv`, {
    method: 'POST', body: json, keepalive: json.length <= KEEPALIVE_MAX,
    headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
  }).catch(() => undefined)
}

export async function hydrateKv(): Promise<void> {
  const { values: all } = await appFetch<{ values: Record<string, string> }>('/kv')
  values.clear()
  for (const [k, v] of Object.entries(all)) values.set(k, v)
  window.addEventListener('pagehide', flushOnHide)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushOnHide() })
}

/** localStorage-compatible synchronous API. */
export const kv = {
  getItem(key: string): string | null {
    return values.get(key) ?? null
  },
  setItem(key: string, value: string): void {
    if (values.get(key) === value) return
    values.set(key, value)
    pendingDelete.delete(key)
    pendingSet.set(key, value)
    schedule()
  },
  removeItem(key: string): void {
    if (!values.has(key)) return
    values.delete(key)
    pendingSet.delete(key)
    pendingDelete.add(key)
    schedule()
  },
  keys(): string[] {
    return [...values.keys()]
  },
  /** Parsed JSON value, or `fallback` when missing/corrupt. */
  getJson<T>(key: string, fallback: T): T {
    const raw = values.get(key)
    if (raw == null) return fallback
    try { return JSON.parse(raw) as T } catch { return fallback }
  },
  setJson(key: string, value: unknown): void {
    kv.setItem(key, JSON.stringify(value))
  },
  /** Write pending changes now (e.g. before a destructive action). */
  flush,
}
