import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { DragEvent } from 'react'
import { clsx } from 'clsx'
import { ClipboardPaste, ImagePlus, UploadCloud, X } from 'lucide-react'
import { blobToDataUrl, fileToDataUrl } from '../lib/media'
import { ITEM_DRAG_MIME, droppedItem, isItemDrag } from '../lib/drag'
import { itemBlob } from '../lib/library'
import { errorMessage, toast } from '../lib/hooks'

/** First image among a clipboard event's items, if any. */
function imageFromClipboard(dt: DataTransfer | null): File | null {
  if (!dt) return null
  for (const item of dt.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  for (const file of dt.files) {
    if (file.type.startsWith('image/')) return file
  }
  return null
}

type PasteHandler = (file: File) => void

/**
 * Clipboard-paste routing. A page can render several image targets, so a paste
 * must not hit all of them: zones the pointer/focus is on claim it, and when a
 * page has exactly one zone that zone always wins. A single window listener is
 * installed on the first registration.
 */
const mounted = new Set<PasteHandler>()
const active: PasteHandler[] = []
let listening = false

function targetForPaste(): PasteHandler | null {
  if (active.length) return active[active.length - 1]
  if (mounted.size === 1) return [...mounted][0]
  return null
}

function ensurePasteListener() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('paste', (e) => {
    // Text pasted into a prompt field must stay text, even when the clipboard
    // also carries an image rendition (Office/LibreOffice copies do).
    const t = e.target
    const editable = t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)
    if (editable && e.clipboardData?.types.includes('text/plain')) return
    const file = imageFromClipboard(e.clipboardData)
    if (!file) return
    const handler = targetForPaste()
    if (!handler) return
    e.preventDefault()
    handler(file)
  })
}

function registerMount(handler: PasteHandler): () => void {
  ensurePasteListener()
  mounted.add(handler)
  return () => { mounted.delete(handler); unregisterActive(handler) }
}

function registerActive(handler: PasteHandler): () => void {
  active.push(handler)
  return () => unregisterActive(handler)
}

function unregisterActive(handler: PasteHandler) {
  const i = active.lastIndexOf(handler)
  if (i >= 0) active.splice(i, 1)
}

/**
 * Whether a library item is being dragged anywhere in the app, so every drop
 * zone can hint that it accepts it before the pointer reaches it.
 */
let itemDragActive = false
const dragListeners = new Set<() => void>()
let dragListening = false

function setItemDragActive(v: boolean) {
  if (itemDragActive === v) return
  itemDragActive = v
  for (const l of dragListeners) l()
}

function subscribeItemDrag(l: () => void): () => void {
  if (!dragListening) {
    dragListening = true
    window.addEventListener('dragstart', (e) => setItemDragActive(!!e.dataTransfer?.types.includes(ITEM_DRAG_MIME)))
    window.addEventListener('dragend', () => setItemDragActive(false))
    window.addEventListener('drop', () => setItemDragActive(false))
  }
  dragListeners.add(l)
  return () => { dragListeners.delete(l) }
}

/** Drop zone + click-to-pick for a single image, value is a data URL.
 *  Accepts files, pasted images, and library items dragged from a gallery. */
export function ImageDrop({ value, onChange, className, label = 'Drop an image or click to choose', compact }: {
  value: string | null
  onChange: (dataUrl: string | null) => void
  className?: string
  label?: string
  compact?: boolean
}) {
  const [over, setOver] = useState<'file' | 'item' | null>(null)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const dragging = useSyncExternalStore(subscribeItemDrag, () => itemDragActive)

  const pick = useCallback((file: File | undefined | null) => {
    if (!file || !file.type.startsWith('image/')) return
    void fileToDataUrl(file).then(onChange)
  }, [onChange])

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setOver(null)
    const item = droppedItem(e)
    if (item) {
      if (item.kind !== 'image') { toast.info('Only images can be dropped here'); return }
      void itemBlob(item).then(blobToDataUrl).then(onChange, (err: unknown) => toast.error('Could not load the image', errorMessage(err)))
      return
    }
    pick(e.dataTransfer.files[0])
  }

  // Stable handler that always calls the latest `pick`.
  const pickRef = useRef(pick)
  pickRef.current = pick
  const handler = useCallback<PasteHandler>((file) => pickRef.current(file), [])

  useEffect(() => registerMount(handler), [handler])

  // Hovered or focused zones claim paste events.
  useEffect(() => {
    if (!hover && !focused) return
    return registerActive(handler)
  }, [hover, focused, handler])

  const highlighted = over != null || hover || focused

  const openPicker = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => pick(input.files?.[0])
    input.click()
  }, [pick])

  return (
    <div
      tabIndex={0}
      role="button"
      className={clsx(
        'group relative flex cursor-pointer flex-col items-center justify-center overflow-hidden rounded-xl border-2 border-dashed transition-colors focus:outline-none',
        highlighted ? 'border-accent bg-accent/10' : dragging ? 'border-accent/60 bg-accent/5' : 'border-line hover:border-line-strong',
        compact ? 'min-h-24' : 'min-h-40',
        className,
      )}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(isItemDrag(e) ? 'item' : 'file')
      }}
      onDragLeave={(e) => {
        // Moving between child elements fires dragleave on the zone too.
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
        setOver(null)
      }}
      onDrop={onDrop}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker() }
      }}
    >
      {over === 'item' && (
        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-accent/20 backdrop-blur-[1px]">
          <span className="inline-flex items-center gap-1.5 rounded-lg bg-black/70 px-2.5 py-1 text-[11.5px] text-white">
            <ImagePlus size={13} /> {value ? 'Replace with this image' : 'Use this image'}
          </span>
        </div>
      )}
      {value ? (
        <>
          <img src={value} alt="" draggable={false} className="max-h-72 w-full object-contain" />
          <button
            className="absolute right-2 top-2 rounded-lg bg-black/60 p-1.5 text-white opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); onChange(null) }}
          >
            <X size={14} />
          </button>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 p-6 text-center text-ink-faint">
          <UploadCloud size={compact ? 18 : 26} />
          <span className="text-xs">{dragging ? 'Drop the image here' : label}</span>
          <span className="inline-flex items-center gap-1 text-[10.5px] text-ink-faint/80">
            <ClipboardPaste size={11} /> or paste with Ctrl/⌘+V
          </span>
        </div>
      )}
    </div>
  )
}

/** Manually target a paste handler from a non-`ImageDrop` surface.
 *  Registers as a hover-priority claim while `enabled` is true, so it wins over
 *  a page's default (mounted) drop zone only when the caller says so. */
export function useClipboardImage(handler: (file: File) => void, opts?: { enabled?: boolean }): void {
  const enabled = opts?.enabled ?? true
  const ref = useRef(handler)
  ref.current = handler
  const stable = useCallback<PasteHandler>((file) => ref.current(file), [])
  useEffect(() => {
    if (!enabled) return
    return registerActive(stable)
  }, [enabled, stable])
}
