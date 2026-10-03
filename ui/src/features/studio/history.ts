/**
 * Pinned/saved text histories (prompts, negative prompts, batch JSON).
 * Uses the legacy ui.html localStorage keys and accepts their record shapes,
 * so history saved in the old UI shows up here unchanged.
 */
import { useMemo, useState } from 'react'

export const HISTORY_KEYS = {
  prompt: 'sillyMediaHistory',
  negative: 'sillyMediaNegHistory',
  json: 'sillyMediaJsonHistory',
} as const

const MAX_HISTORY = 50

export interface HistoryEntry {
  text: string
  favorite: boolean
  timestamp: number
}

function readEntries(key: string): HistoryEntry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key) || '[]')
    if (!Array.isArray(raw)) return []
    const out: HistoryEntry[] = []
    for (const item of raw) {
      if (typeof item === 'string') { out.push({ text: item, favorite: false, timestamp: Date.now() }); continue }
      if (typeof item !== 'object' || item === null) continue
      const text = 'prompt' in item && typeof item.prompt === 'string' ? item.prompt
        : 'json' in item && typeof item.json === 'string' ? item.json
          : 'text' in item && typeof item.text === 'string' ? item.text : null
      if (text === null) continue
      out.push({
        text,
        favorite: 'favorite' in item && item.favorite === true,
        timestamp: 'timestamp' in item && typeof item.timestamp === 'number' ? item.timestamp : 0,
      })
    }
    return out
  } catch {
    return []
  }
}

/** Persist in the legacy field name so both UIs can share the list. */
function writeEntries(key: string, entries: HistoryEntry[]) {
  const field = key === HISTORY_KEYS.json ? 'json' : 'prompt'
  localStorage.setItem(key, JSON.stringify(entries.map((e) => ({ [field]: e.text, favorite: e.favorite, timestamp: e.timestamp }))))
}

export interface TextHistory {
  entries: HistoryEntry[]
  /** Favourites first, then newest; `index` points into the stored order. */
  sorted: { entry: HistoryEntry; index: number }[]
  /** Returns false when the text is empty or already saved. */
  add: (text: string) => boolean
  toggleFavorite: (index: number) => void
  remove: (index: number) => void
  clear: () => void
}

export function useTextHistory(key: string): TextHistory {
  const [entries, setEntries] = useState<HistoryEntry[]>(() => readEntries(key))

  const commit = (next: HistoryEntry[]) => {
    writeEntries(key, next)
    setEntries(next)
  }

  const sorted = useMemo(
    () => entries
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => Number(b.entry.favorite) - Number(a.entry.favorite) || b.entry.timestamp - a.entry.timestamp),
    [entries],
  )

  return {
    entries,
    sorted,
    add(text) {
      if (!text.trim() || entries.some((e) => e.text === text)) return false
      const next = [{ text, favorite: false, timestamp: Date.now() }, ...entries]
      // Trim the oldest non-favourite entries; favourites are never evicted.
      for (let i = next.length - 1; i >= 0 && next.length > MAX_HISTORY; i--) {
        if (!next[i].favorite) next.splice(i, 1)
      }
      commit(next)
      return true
    },
    toggleFavorite(index) {
      commit(entries.map((e, i) => (i === index ? { ...e, favorite: !e.favorite } : e)))
    },
    remove(index) {
      commit(entries.filter((_, i) => i !== index))
    },
    clear() {
      localStorage.removeItem(key)
      setEntries([])
    },
  }
}
