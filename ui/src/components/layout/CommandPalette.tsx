/**
 * Ctrl/⌘+K command palette: the current page's primary action, every
 * registered command (navigation included, see AppShell) and library search.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { clsx } from 'clsx'
import { ChevronRight, Compass, CornerDownLeft, Search, Zap } from 'lucide-react'
import { commands, MOD_KEY, useCommandList, usePaletteOpen, usePrimary } from '../../lib/commands'
import { useLibrary } from '../../lib/library'
import { ItemThumb } from './ActivityTray'

interface Entry {
  id: string
  label: string
  group: string
  /** Extra text matched by the filter but not shown. */
  keywords?: string
  detail?: string
  hint?: string
  icon?: ReactNode
  disabled?: boolean
  run: () => void
}

const PRIMARY_GROUP = 'Current page'
const LIBRARY_GROUP = 'Library items'
/** Groups shown after the page's own command groups when nothing is typed. */
const TRAILING_GROUPS = ['Navigate', 'App']
const LIBRARY_RESULTS = 8

/**
 * Fuzzy-ish match: every query token must appear in the label or the extra
 * text; label prefix > label word start > inside label > extra text. A
 * single-token query also matches the label as a subsequence (weakest).
 */
function score(tokens: string[], label: string, extra: string): number | null {
  const l = label.toLowerCase()
  const x = extra.toLowerCase()
  let total = 0
  for (const t of tokens) {
    const i = l.indexOf(t)
    if (i === 0) total += 4
    else if (i > 0) total += /[\s\-_/.(]/.test(l[i - 1]) ? 3 : 2
    else if (x.includes(t)) total += 1
    else {
      if (tokens.length > 1) return null
      let k = 0
      for (const ch of l) if (ch === t[k]) k++
      if (k < t.length) return null
      total += 0.5
    }
  }
  return total
}

export function CommandPalette() {
  const open = usePaletteOpen()
  return open ? <PaletteDialog /> : null
}

function PaletteDialog() {
  const navigate = useNavigate()
  const primary = usePrimary()
  const registered = useCommandList()
  const items = useLibrary()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const close = () => commands.setPaletteOpen(false)

  const groups = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    const base: Entry[] = []
    if (primary) {
      base.push({
        id: 'primary', label: primary.label, group: PRIMARY_GROUP, keywords: 'primary run generate',
        hint: `${MOD_KEY}+Enter`, icon: <Zap size={14} className="text-accent" />, disabled: primary.disabled, run: primary.run,
      })
    }
    for (const c of registered) {
      base.push({
        id: c.id, label: c.label, group: c.group, keywords: `${c.group} ${c.keywords ?? ''}`, hint: c.shortcut,
        icon: c.group === 'Navigate' ? <Compass size={14} /> : <ChevronRight size={14} />, disabled: c.disabled, run: c.run,
      })
    }

    // Group order: primary, the page's own groups, then the app-wide ones.
    const order: string[] = [PRIMARY_GROUP]
    for (const e of base) if (!order.includes(e.group) && !TRAILING_GROUPS.includes(e.group)) order.push(e.group)
    for (const g of TRAILING_GROUPS) if (!order.includes(g)) order.push(g)

    const byGroup = new Map<string, { entries: { e: Entry; s: number }[]; best: number }>()
    for (const e of base) {
      const s = tokens.length ? score(tokens, e.label, e.keywords ?? '') : 0
      if (s == null) continue
      const g = byGroup.get(e.group) ?? { entries: [], best: 0 }
      g.entries.push({ e, s })
      g.best = Math.max(g.best, s)
      byGroup.set(e.group, g)
    }
    let ordered = order.filter((g) => byGroup.has(g)).map((g) => {
      const v = byGroup.get(g)!
      const entries = tokens.length ? [...v.entries].sort((a, b) => b.s - a.s) : v.entries
      return { name: g, best: v.best, entries: entries.map((x) => x.e) }
    })
    if (tokens.length) {
      // Best-matching groups first, but the page's primary action stays on top.
      ordered = [...ordered].sort((a, b) => (a.name === PRIMARY_GROUP ? -1 : b.name === PRIMARY_GROUP ? 1 : b.best - a.best))
    }

    const q = query.trim()
    if (q.length >= 2) {
      const hits: Entry[] = []
      for (const item of items) {
        const text = `${item.prompt ?? ''} ${item.name}`.toLowerCase()
        if (!tokens.every((t) => text.includes(t))) continue
        hits.push({
          id: `item:${item.id}`,
          label: item.prompt || item.name || 'Untitled',
          group: LIBRARY_GROUP,
          detail: `${item.kind === 'model3d' ? '3D' : item.kind} · ${item.source}`,
          icon: <span className="block h-7 w-7 overflow-hidden rounded-md border border-line bg-bg"><ItemThumb item={item} /></span>,
          run: () => void navigate({ to: '/library', search: { item: item.id } }),
        })
        if (hits.length >= LIBRARY_RESULTS) break
      }
      hits.push({
        id: 'library.search', label: `Search library for “${q}”`, group: LIBRARY_GROUP,
        icon: <Search size={14} />, run: () => void navigate({ to: '/library', search: { q } }),
      })
      ordered.push({ name: LIBRARY_GROUP, best: 0, entries: hits })
    }
    return ordered
  }, [query, primary, registered, items, navigate])

  const flat = useMemo(() => groups.flatMap((g) => g.entries), [groups])
  const current = Math.min(active, Math.max(0, flat.length - 1))

  useEffect(() => { setActive(0) }, [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [current, flat])

  const runEntry = (e: Entry | undefined) => {
    if (!e || e.disabled) return
    close()
    e.run()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(flat.length ? (current + 1) % flat.length : 0) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(flat.length ? (current - 1 + flat.length) % flat.length : 0) }
    else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); runEntry(flat[current]) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  let index = -1
  return (
    <div className="fixed inset-0 z-50 flex justify-center bg-black/60 px-6 pt-[12vh] backdrop-blur-sm" onMouseDown={close}>
      <div
        className="animate-in flex h-fit max-h-[70vh] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl shadow-black/60"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="shrink-0 text-ink-faint" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command, a page or search the library…"
            className="h-12 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-faint"
          />
          <kbd className="rounded border border-line bg-bg px-1.5 py-0.5 text-[10.5px] text-ink-faint">Esc</kbd>
        </div>

        <div ref={listRef} className="scroll-area flex-1 p-2">
          {!flat.length && <div className="px-3 py-8 text-center text-[13px] text-ink-faint">No matches</div>}
          {groups.map((g) => (
            <div key={g.name} className="pb-1">
              <div className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint">{g.name}</div>
              {g.entries.map((e) => {
                index++
                const i = index
                const isActive = i === current
                return (
                  <button
                    key={e.id}
                    data-active={isActive}
                    onMouseMove={() => { if (!isActive) setActive(i) }}
                    onClick={() => runEntry(e)}
                    disabled={e.disabled}
                    className={clsx(
                      'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-[13px] disabled:opacity-40',
                      isActive ? 'bg-accent/15 text-ink' : 'text-ink-dim',
                    )}
                  >
                    <span className={clsx('grid w-7 shrink-0 place-items-center', isActive ? 'text-accent' : 'text-ink-faint')}>{e.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{e.label}</span>
                      {e.detail && <span className="block truncate text-[11px] capitalize text-ink-faint">{e.detail}</span>}
                    </span>
                    {e.hint && <kbd className="shrink-0 rounded border border-line bg-bg px-1.5 py-0.5 text-[10.5px] text-ink-faint">{e.hint}</kbd>}
                    {isActive && <CornerDownLeft size={13} className="shrink-0 text-ink-faint" />}
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-[11px] text-ink-faint">
          <span><kbd className="font-sans">↑↓</kbd> select</span>
          <span><kbd className="font-sans">↵</kbd> run</span>
          <span><kbd className="font-sans">{MOD_KEY}+K</kbd> toggle</span>
          {primary && <span className="ml-auto truncate"><kbd className="font-sans">{MOD_KEY}+Enter</kbd> {primary.label}</span>}
        </div>
      </div>
    </div>
  )
}
