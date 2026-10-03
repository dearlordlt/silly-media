/** Tag (= collection) editing: chip list + input with autocomplete from tags in use. */
import { useState } from 'react'
import { clsx } from 'clsx'
import { Tag, X } from 'lucide-react'
import { useLibraryTags } from '../lib/library'

/** Trimmed, single-spaced, bounded tag text ('' when empty). */
export function normalizeTag(raw: string): string {
  return raw.replace(/[\s,]+/g, ' ').trim().slice(0, 40)
}

/**
 * Text input that commits a tag on Enter / comma / suggestion click.
 * Suggestions come from tags already used in the library (most used first);
 * typing an existing tag in another case reuses the existing spelling.
 */
export function TagInput({ onAdd, exclude = [], onRemoveLast, placeholder = 'Add tag…', autoFocus, className }: {
  onAdd: (tag: string) => void
  /** Tags not to suggest (already applied). */
  exclude?: readonly string[]
  /** Backspace in the empty input. */
  onRemoveLast?: () => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
}) {
  const all = useLibraryTags()
  const [value, setValue] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const excluded = new Set(exclude.map((t) => t.toLowerCase()))
  const q = value.trim().toLowerCase()
  const suggestions = all.filter((t) => !excluded.has(t.toLowerCase()) && (!q || t.toLowerCase().includes(q))).slice(0, 8)
  const showList = open && suggestions.length > 0

  const commit = (raw: string) => {
    const tag = normalizeTag(raw)
    setValue('')
    setActive(-1)
    if (!tag) return
    const existing = all.find((t) => t.toLowerCase() === tag.toLowerCase())
    if (excluded.has((existing ?? tag).toLowerCase())) return
    onAdd(existing ?? tag)
  }

  return (
    <div className={clsx('relative', className)}>
      <input
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="field h-8 w-full text-[12px]"
        onChange={(e) => {
          if (e.target.value.endsWith(',')) { commit(e.target.value.slice(0, -1)); return }
          setValue(e.target.value)
          setActive(-1)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(showList && active >= 0 ? suggestions[active] : value)
          } else if (e.key === 'ArrowDown' && suggestions.length) {
            e.preventDefault()
            setOpen(true)
            setActive((i) => (i + 1) % suggestions.length)
          } else if (e.key === 'ArrowUp' && suggestions.length) {
            e.preventDefault()
            setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1))
          } else if (e.key === 'Escape' && (showList || value)) {
            // Close the list / clear the text before the surrounding modal sees Escape.
            e.stopPropagation()
            setOpen(false)
            setValue('')
          } else if (e.key === 'Backspace' && !value && onRemoveLast) {
            onRemoveLast()
          }
        }}
      />
      {showList && (
        <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-auto rounded-lg border border-line bg-panel-2 py-1 shadow-xl">
          {suggestions.map((t, i) => (
            <li key={t}>
              <button
                type="button"
                // Keep focus in the input so blur doesn't close the list before the click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(t)}
                className={clsx('flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12px]', i === active ? 'bg-accent/20 text-ink' : 'text-ink-dim hover:bg-panel-3 hover:text-ink')}
              >
                <Tag size={11} className="shrink-0 text-ink-faint" /> {t}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Removable tag chips + an input to add more. */
export function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  return (
    <div className="space-y-2">
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2 pr-1 text-[11.5px] text-ink">
              {t}
              <button
                type="button"
                onClick={() => onChange(tags.filter((x) => x !== t))}
                className="rounded-full p-0.5 text-ink-faint hover:bg-accent/20 hover:text-ink"
                aria-label={`Remove tag ${t}`}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <TagInput
        exclude={tags}
        onAdd={(t) => onChange([...tags, t])}
        onRemoveLast={tags.length ? () => onChange(tags.slice(0, -1)) : undefined}
        placeholder={tags.length ? 'Add another tag…' : 'Add a tag (collection)…'}
      />
    </div>
  )
}
