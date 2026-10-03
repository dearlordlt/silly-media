/** Shape of `MediaItem.meta` written by Studio, plus guards to read it back. */
import type { GenerateRequest } from '../../lib/types'
import type { MediaItem } from '../../lib/library'
import { extensionFor } from '../../lib/media'
import type { BatchRow } from './batch'

export interface StudioMeta {
  request?: GenerateRequest
  /** JSON batch row the prompt was resolved from. */
  variables?: BatchRow
  /** Gallery folder (legacy "Batch <date>" / "Simple <date>"). */
  folder?: string
}

/** Studio is the only writer of `source: 'studio'` items, so their meta is a StudioMeta. */
export function readStudioMeta(item: MediaItem): StudioMeta {
  return item.source === 'studio' && item.meta ? (item.meta as StudioMeta) : {}
}

/** Legacy download naming: the `{name}` batch variable, else a timestamp. */
export function studioFilename(item: MediaItem): string {
  const ext = extensionFor(item.blob.type)
  const name = readStudioMeta(item).variables?.name
  const base = typeof name === 'string' && name.trim()
    ? name.replace(/[<>:"/\\|?*]/g, '_').trim()
    : `silly-media-${new Date(item.createdAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
  return `${base}.${ext === 'bin' ? 'png' : ext}`
}
