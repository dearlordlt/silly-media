/** Legacy gallery modal: carousel with prev/next, thumbnail strip, highlighted prompt, info and actions. */
import { useEffect } from 'react'
import { clsx } from 'clsx'
import { ChevronLeft, ChevronRight, Dice5, Download, Eye, Rows3, RotateCcw, Trash2, Wand2 } from 'lucide-react'
import type { MediaItem } from '../../lib/library'
import { downloadItem } from '../../lib/library'
import { Modal } from '../../components/ui/Modal'
import { Button, IconButton } from '../../components/ui/primitives'
import { PromptView } from './StudioDialogs'
import { readStudioMeta, studioFilename } from './meta'

const THUMB_WINDOW = 21

export function StudioViewer({ items, index, onIndex, onClose, onReuse, onVary, onSweep, onVision, onEdit, onDelete, highlights }: {
  items: MediaItem[]
  /** null = closed. */
  index: number | null
  onIndex: (i: number) => void
  onClose: () => void
  onReuse: (item: MediaItem) => void
  /** Same settings, new random seed. */
  onVary: (item: MediaItem) => void
  /** Seeds base+1…base+count. */
  onSweep: (item: MediaItem, count: number) => void
  onVision: (item: MediaItem) => void
  onEdit: (item: MediaItem) => void
  onDelete: (item: MediaItem) => void
  highlights: ReadonlySet<string>
}) {
  const item = index != null ? items[index] : undefined
  const total = items.length

  useEffect(() => {
    if (index == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1)
      else if (e.key === 'ArrowRight' && index < total - 1) onIndex(index + 1)
      else if (e.key === 'Home') onIndex(0)
      else if (e.key === 'End') onIndex(total - 1)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, onIndex])

  if (index == null || !item) return null
  const meta = readStudioMeta(item)
  const name = meta.variables?.name
  const label = typeof name === 'string' ? name : null

  // Windowed thumbnail strip for large galleries (legacy updateThumbnailWindow).
  const half = Math.floor(THUMB_WINDOW / 2)
  let start = Math.max(0, index - half)
  let end = Math.min(total, index + half + 1)
  if (start === 0) end = Math.min(total, THUMB_WINDOW)
  if (end === total) start = Math.max(0, total - THUMB_WINDOW)

  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-6xl"
      title={<span className="flex items-center gap-3">{item.model ?? 'Image'} <span className="text-[11.5px] font-normal text-ink-faint">{index + 1} / {total}</span></span>}
      footer={
        <>
          <Button variant="ghost" size="sm" icon={<Trash2 size={14} />} onClick={() => onDelete(item)}>Delete</Button>
          <Button variant="secondary" size="sm" icon={<Eye size={14} />} onClick={() => onVision(item)}>Vision</Button>
          <Button variant="secondary" size="sm" icon={<Wand2 size={14} />} onClick={() => onEdit(item)}>Edit</Button>
          <Button variant="secondary" size="sm" icon={<RotateCcw size={14} />} onClick={() => onReuse(item)}>Use settings</Button>
          <Button variant="secondary" size="sm" icon={<Dice5 size={14} />} onClick={() => onVary(item)} title="Same settings, new random seed">Vary</Button>
          <Button variant="secondary" size="sm" icon={<Rows3 size={14} />} onClick={() => onSweep(item, 4)} title="4 images with seeds base+1…base+4">Sweep ×4</Button>
          <Button variant="secondary" size="sm" onClick={() => onSweep(item, 8)} title="8 images with seeds base+1…base+8">×8</Button>
          <Button variant="primary" size="sm" icon={<Download size={14} />} onClick={() => downloadItem(item, studioFilename(item))}>Download</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="relative grid min-h-[50vh] place-items-center rounded-xl bg-bg p-3">
          <img src={item.url} alt="" className="max-h-[62vh] max-w-full object-contain" />
          {label && <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-3 py-1 text-[12.5px] font-semibold">{label}</div>}
          <IconButton
            className="absolute left-2 top-1/2 -translate-y-1/2 disabled:opacity-30"
            disabled={index === 0}
            onClick={() => onIndex(index - 1)}
            title="Previous (←)"
          >
            <ChevronLeft size={26} />
          </IconButton>
          <IconButton
            className="absolute right-2 top-1/2 -translate-y-1/2 disabled:opacity-30"
            disabled={index === total - 1}
            onClick={() => onIndex(index + 1)}
            title="Next (→)"
          >
            <ChevronRight size={26} />
          </IconButton>
        </div>

        {total > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {start > 0 && <ThumbJump label="1" onClick={() => onIndex(0)} />}
            {start > 1 && <span className="px-1 text-ink-faint">…</span>}
            {items.slice(start, end).map((t, i) => (
              <button
                key={t.id}
                onClick={() => onIndex(start + i)}
                className={clsx(
                  'grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md border bg-bg',
                  start + i === index ? 'border-accent ring-1 ring-accent' : 'border-line opacity-70 hover:opacity-100',
                )}
              >
                <img src={t.url} alt="" loading="lazy" className="max-h-full max-w-full object-contain" />
              </button>
            ))}
            {end < total - 1 && <span className="px-1 text-ink-faint">…</span>}
            {end < total && <ThumbJump label={String(total)} onClick={() => onIndex(total - 1)} />}
          </div>
        )}

        {item.prompt && (
          <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12.5px] leading-relaxed">
            <span className="mr-1.5 text-[11px] font-semibold uppercase text-accent">Prompt:</span>
            <PromptView prompt={item.prompt} variables={meta.variables} highlights={highlights} />
          </div>
        )}
        {item.negativePrompt?.trim() && (
          <div className="rounded-lg bg-panel-2 px-3 py-2 text-[12.5px] leading-relaxed">
            <span className="mr-1.5 text-[11px] font-semibold uppercase text-bad">Negative:</span>
            <span className="whitespace-pre-wrap">{item.negativePrompt}</span>
          </div>
        )}
        <pre className="max-h-48 overflow-auto rounded-lg bg-bg p-3 font-mono text-[11px] text-ink-dim">
          {JSON.stringify({
            ...(meta.request ?? {}),
            model: item.model,
            ...(meta.variables ? { _variables: meta.variables } : {}),
            ...(meta.folder ? { folder: meta.folder } : {}),
            size: item.width ? `${item.width}×${item.height}` : undefined,
            created: new Date(item.createdAt).toLocaleString(),
          }, null, 2)}
        </pre>
      </div>
    </Modal>
  )
}

function ThumbJump({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="grid h-14 w-10 shrink-0 place-items-center rounded-md border border-line text-[11px] text-ink-dim hover:text-ink">
      {label}
    </button>
  )
}
