/**
 * Cross-page image hand-off ("Send to Edit / Vision / Video / 3D").
 *
 * Held in memory, not storage: client-side navigation keeps the JS context
 * alive, and a 2K PNG data URL easily exceeds storage quotas. A full page
 * reload drops a pending hand-off, which is the desired behaviour.
 */
import { useEffect, useRef } from 'react'
import { blobToDataUrl } from './media'
import type { MediaItem } from './library'

export type HandoffTarget = 'edit' | 'vision' | 'video' | '3d'

/** A blob, or a same-origin URL (e.g. a library item's file) fetched on arrival. */
type Source = Blob | string

interface Pending { target: HandoffTarget; source: Source }

let pending: Pending | null = null

/** Stage an image for the given page; call right before navigating there. */
export function handOffImage(target: HandoffTarget, source: Source): void {
  pending = { target, source }
}

/** Stage a library item's image. */
export function handOffItem(target: HandoffTarget, item: Pick<MediaItem, 'url'>): void {
  handOffImage(target, item.url)
}

async function toDataUrl(source: Source): Promise<string> {
  if (typeof source !== 'string') return blobToDataUrl(source)
  const res = await fetch(source)
  if (!res.ok) throw new Error(`Could not load image (${res.status})`)
  return blobToDataUrl(await res.blob())
}

/** Receive a staged image (as a data URL) once, on mount of the target page. */
export function useHandoffImage(target: HandoffTarget, onImage: (dataUrl: string) => void): void {
  const cb = useRef(onImage)
  cb.current = onImage
  useEffect(() => {
    if (!pending || pending.target !== target) return
    const { source } = pending
    pending = null
    void toDataUrl(source).then((url) => cb.current(url), () => undefined)
  }, [target])
}

export const HANDOFF_ROUTES: Record<HandoffTarget, '/edit' | '/vision' | '/video' | '/3d'> = {
  edit: '/edit',
  vision: '/vision',
  video: '/video',
  '3d': '/3d',
}
