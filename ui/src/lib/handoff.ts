/**
 * Cross-page image hand-off ("Send to Edit / Vision / Video / 3D").
 *
 * Held in memory, not sessionStorage: client-side navigation keeps the JS
 * context alive, and a 2K PNG data URL easily exceeds the ~5MB storage quota.
 * A full page reload drops a pending hand-off, which is the desired behaviour.
 */
import { useEffect, useRef } from 'react'
import { blobToDataUrl } from './media'

export type HandoffTarget = 'edit' | 'vision' | 'video' | '3d'

interface Pending { target: HandoffTarget; blob: Blob }

let pending: Pending | null = null

/** Stage an image for the given page; call right before navigating there. */
export function handOffImage(target: HandoffTarget, blob: Blob): void {
  pending = { target, blob }
}

/** Receive a staged image (as a data URL) once, on mount of the target page. */
export function useHandoffImage(target: HandoffTarget, onImage: (dataUrl: string) => void): void {
  const cb = useRef(onImage)
  cb.current = onImage
  useEffect(() => {
    if (!pending || pending.target !== target) return
    const { blob } = pending
    pending = null
    void blobToDataUrl(blob).then((url) => cb.current(url))
  }, [target])
}

export const HANDOFF_ROUTES: Record<HandoffTarget, '/edit' | '/vision' | '/video' | '/3d'> = {
  edit: '/edit',
  vision: '/vision',
  video: '/video',
  '3d': '/3d',
}
