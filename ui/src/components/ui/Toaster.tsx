import { clsx } from 'clsx'
import { CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { useToasts } from '../../lib/hooks'

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            'pointer-events-auto flex items-start gap-2.5 rounded-xl border bg-panel/95 p-3 shadow-xl backdrop-blur animate-in',
            t.kind === 'error' ? 'border-bad/40' : t.kind === 'success' ? 'border-good/40' : 'border-line',
          )}
        >
          {t.kind === 'error' ? <XCircle size={16} className="mt-0.5 shrink-0 text-bad" />
            : t.kind === 'success' ? <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-good" />
            : <Info size={16} className="mt-0.5 shrink-0 text-accent-2" />}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{t.title}</div>
            {t.detail && <div className="mt-0.5 break-words text-[11.5px] text-ink-faint">{t.detail}</div>}
          </div>
          <button onClick={() => dismiss(t.id)} className="text-ink-faint hover:text-ink"><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}
