/** Reusable form/primitive components for the desktop app. */
import { clsx } from 'clsx'
import type {
  ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { Loader2 } from 'lucide-react'

/* ------------------------------------------------------------------ Button */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'sm' | 'md' | 'lg'

const variants: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:brightness-110 shadow-[0_2px_12px_-2px_var(--color-accent)]',
  secondary: 'bg-panel-3 text-ink hover:bg-line-strong border border-line',
  outline: 'bg-transparent text-ink border border-line hover:border-line-strong hover:bg-panel-2',
  ghost: 'bg-transparent text-ink-dim hover:text-ink hover:bg-panel-2',
  danger: 'bg-bad/15 text-bad border border-bad/30 hover:bg-bad/25',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[12.5px] gap-1.5 rounded-lg',
  md: 'h-9 px-3.5 text-[13px] gap-2 rounded-[10px]',
  lg: 'h-11 px-5 text-sm gap-2 rounded-xl',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center font-medium transition-all select-none whitespace-nowrap',
        'disabled:opacity-45 disabled:pointer-events-none active:scale-[0.98]',
        variants[variant], sizes[size], className,
      )}
    >
      {loading ? <Loader2 size={15} className="animate-spin" /> : icon}
      {children}
    </button>
  )
}

export function IconButton({ className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      className={clsx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-dim transition-colors',
        'hover:bg-panel-2 hover:text-ink disabled:opacity-40 disabled:pointer-events-none',
        className,
      )}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ Fields */

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-2">
      <span className="text-[11.5px] font-medium uppercase tracking-wide text-ink-faint">{children}</span>
      {hint && <span className="text-[11px] text-ink-faint">{hint}</span>}
    </div>
  )
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx('field h-9', className)} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...rest} className={clsx('field resize-y leading-relaxed', className)} />
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx('field h-9 cursor-pointer appearance-none bg-[length:14px] bg-[right_10px_center] bg-no-repeat pr-8', className)}
      style={{ backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2398a1b8' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")" }}>
      {children}
    </select>
  )
}

export function Slider({ value, min, max, step, onValueChange, label, format }: {
  value: number
  min: number
  max: number
  step?: number
  onValueChange: (v: number) => void
  label?: ReactNode
  format?: (v: number) => string
}) {
  return (
    <div>
      {label && <Label hint={format ? format(value) : value}>{label}</Label>}
      <input
        type="range" value={value} min={min} max={max} step={step ?? 1}
        onChange={(e) => onValueChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-line-strong"
      />
    </div>
  )
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2.5 text-left"
    >
      <span className={clsx('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line-strong')}>
        <span className={clsx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label && <span className="text-[13px] text-ink-dim">{label}</span>}
    </button>
  )
}

/* ------------------------------------------------------------------- Panels */

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('rounded-xl border border-line bg-panel', className)}>{children}</div>
}

export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      {(title || action) && (
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

export function EmptyState({ icon, title, detail, action }: { icon?: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line py-10 text-center">
      {icon && <div className="text-ink-faint">{icon}</div>}
      <div className="text-sm font-medium text-ink-dim">{title}</div>
      {detail && <div className="max-w-sm text-xs text-ink-faint">{detail}</div>}
      {action}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx('animate-spin text-accent', className)} size={16} />
}

/* ------------------------------------------------------------------ Segments */

export function Segmented<T extends string>({ value, onChange, options, className }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode }[]
  className?: string
}) {
  return (
    <div className={clsx('inline-flex rounded-[10px] border border-line bg-bg p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors',
            value === o.value ? 'bg-accent text-white' : 'text-ink-dim hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A toggleable preset chip (used for prompt composition). */
export function Chip({ active, onClick, children, title, tone = 'accent' }: {
  active?: boolean
  onClick?: () => void
  children: ReactNode
  title?: string
  tone?: 'accent' | 'cyan'
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        'rounded-full border px-2.5 py-1 text-[12px] transition-colors',
        active
          ? tone === 'cyan'
            ? 'border-accent-2/60 bg-accent-2/15 text-accent-2'
            : 'border-accent/60 bg-accent/20 text-ink'
          : 'border-line bg-panel-2 text-ink-dim hover:border-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ Progress */

export function ProgressBar({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx('h-1.5 w-full overflow-hidden rounded-full bg-line', className)}>
      <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  )
}

export function StatusDot({ ok, label }: { ok: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-dim">
      <span className={clsx('h-2 w-2 rounded-full', ok ? 'bg-good shadow-[0_0_8px_var(--color-good)]' : 'bg-bad')} />
      {label}
    </span>
  )
}
