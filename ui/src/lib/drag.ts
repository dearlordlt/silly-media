/**
 * Drag library items between views: gallery/library tiles are drag sources,
 * image inputs (ImageDrop) and sidebar entries are drop targets.
 */
import type { DragEvent } from 'react'
import { library } from './library'
import type { MediaItem } from './library'

export const ITEM_DRAG_MIME = 'application/x-silly-item'

/** Make a tile draggable: `<div draggable onDragStart={(e) => startItemDrag(e, item)}>`. */
export function startItemDrag(e: DragEvent, item: MediaItem): void {
  const dt = e.dataTransfer
  dt.effectAllowed = 'copy'
  dt.setData(ITEM_DRAG_MIME, item.id)
  // Lets the item be dropped into other apps / the desktop as a URL too.
  const abs = new URL(item.url, location.href).href
  dt.setData('text/uri-list', abs)
  dt.setData('text/plain', abs)
}

/** True while a library item is being dragged (types are readable during dragover). */
export function isItemDrag(e: DragEvent): boolean {
  return e.dataTransfer.types.includes(ITEM_DRAG_MIME)
}

/** The dropped library item, if the drop carried one that still exists. */
export function droppedItem(e: DragEvent): MediaItem | null {
  const id = e.dataTransfer.getData(ITEM_DRAG_MIME)
  return id ? library.get(id) ?? null : null
}
