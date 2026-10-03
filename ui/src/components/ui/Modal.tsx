import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { clsx } from 'clsx'
import { IconButton } from './primitives'

export function Modal({ open, onClose, title, children, width = 'max-w-3xl', footer }: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: string
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm animate-in"
      onClick={onClose}
    >
      <div
        className={clsx('flex max-h-[88vh] w-full flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl', width)}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            <IconButton onClick={onClose} aria-label="Close"><X size={16} /></IconButton>
          </div>
        )}
        <div className="scroll-area flex-1 p-5">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}
