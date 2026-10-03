/** Drag-and-drop / click-to-browse zone for reference audio files. */
import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { FileAudio, X } from 'lucide-react'
import { formatBytes } from '../../lib/media'
import { IconButton } from '../../components/ui/primitives'

const AUDIO_EXT = /\.(wav|mp3|flac|ogg|m4a|opus|aac|webm)$/i

export function AudioDrop({ onFiles, multiple = true, disabled, title, hint, icon }: {
  onFiles: (files: File[]) => void
  multiple?: boolean
  disabled?: boolean
  title: string
  hint?: string
  icon?: ReactNode
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const accept = (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name))
    if (files.length) onFiles(multiple ? files : files.slice(0, 1))
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !disabled && inputRef.current?.click()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) inputRef.current?.click()
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        if (!disabled) accept(e.dataTransfer.files)
      }}
      className={clsx(
        'flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors',
        over ? 'border-accent bg-accent-soft' : 'border-line-strong bg-bg/40 hover:border-accent/60',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <div className="text-ink-faint">{icon ?? <FileAudio size={20} />}</div>
      <div className="text-[13px] text-ink">{title}</div>
      {hint && <div className="text-[11.5px] text-ink-faint">{hint}</div>}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          accept(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

export function AudioFileList({ files, onRemove }: { files: File[]; onRemove: (index: number) => void }) {
  if (!files.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      {files.map((f, i) => (
        <div key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-2 rounded-lg border border-line bg-panel-2 px-2.5 py-1.5">
          <FileAudio size={13} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{f.name}</span>
          <span className="shrink-0 text-[11px] text-ink-faint">{formatBytes(f.size)}</span>
          <IconButton aria-label={`Remove ${f.name}`} onClick={() => onRemove(i)} className="text-ink-faint hover:text-bad">
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  )
}
