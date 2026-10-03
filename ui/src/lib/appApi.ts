/**
 * Client for the local app server (`ui/server/`), which owns this profile's
 * SQLite library, files and key-value settings. Same origin, under /app-api.
 */
import type { MediaKind } from './library'

export const APP_API = '/app-api'

/** Identifies this tab so it can ignore its own SSE echoes. */
export const CLIENT_ID = crypto.randomUUID()

export interface AppInfo {
  app: 'silly-media-ui'
  profile: string
  dataDir: string
  pid: number
  startedAt: number
  version: number
}

/** Wire shape of a library item; optional fields are `null` when absent. */
export interface ItemRecord {
  id: string
  kind: MediaKind
  source: string
  name: string
  prompt: string | null
  negativePrompt: string | null
  model: string | null
  seed: number | null
  width: number | null
  height: number | null
  durationSeconds: number | null
  meta: Record<string, unknown> | null
  createdAt: number
  favorite: boolean
  tags: string[]
  mime: string
  size: number
  thumbVersion: number | null
}

export interface AppStats {
  items: number
  bytes: number
  byKind: Partial<Record<MediaKind, { count: number; bytes: number }>>
  dbBytes: number
  dataDir: string
  profile: string
}

export class AppApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message)
  }
}

export async function appFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('X-Client-Id', CLIENT_ID)
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const res = await fetch(APP_API + path, { ...init, headers })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let body: unknown = undefined
  try { body = text ? JSON.parse(text) : undefined } catch { body = text }
  if (!res.ok) {
    const msg = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `${res.status} ${res.statusText}`
    throw new AppApiError(res.status, msg, body)
  }
  return body as T
}

let info: AppInfo | null = null

/** Fetched once at boot (see main.tsx); throws when the app server is unreachable. */
export async function loadAppInfo(): Promise<AppInfo> {
  info = await appFetch<AppInfo>('/info')
  return info
}

export function appInfo(): AppInfo {
  if (!info) throw new Error('app info not loaded')
  return info
}

export const fetchStats = () => appFetch<AppStats>('/stats')
