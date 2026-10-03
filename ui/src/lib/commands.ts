/**
 * Command palette registry + global shortcuts.
 *
 * - Pages register context commands while mounted with `useCommands`.
 * - Each page may expose one primary action (usually "Generate") with
 *   `usePrimaryAction`; Ctrl/⌘+Enter runs it from anywhere on the page.
 * - Ctrl/⌘+K toggles the palette (rendered by the app shell).
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export interface Command {
  /** Unique within the app. */
  id: string
  label: string
  /** Palette section, e.g. "Navigate", "Studio", "Library". */
  group: string
  /** Display-only shortcut text, e.g. "Ctrl+Enter". */
  shortcut?: string
  /** Extra search terms. */
  keywords?: string
  disabled?: boolean
  run: () => void
}

export interface PrimaryAction {
  label: string
  run: () => void
  disabled?: boolean
}

const sources = new Map<symbol, Command[]>()
let flat: Command[] = []
let primary: { key: symbol; action: PrimaryAction } | null = null
let paletteOpen = false
const listeners = new Set<() => void>()

function emit() {
  flat = [...sources.values()].flat()
  for (const l of listeners) l()
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

export const commands = {
  all: () => flat,
  /** Register a set of commands; returns the unregister function. */
  register(cmds: Command[]): () => void {
    const key = Symbol('commands')
    sources.set(key, cmds)
    emit()
    return () => { sources.delete(key); emit() }
  },
  primary: () => primary?.action ?? null,
  runPrimary(): boolean {
    const a = primary?.action
    if (!a || a.disabled) return false
    a.run()
    return true
  },
  isPaletteOpen: () => paletteOpen,
  setPaletteOpen(open: boolean) { if (paletteOpen !== open) { paletteOpen = open; emit() } },
  subscribe,
}

/**
 * Register commands while the component is mounted. `cmds` may change every
 * render; the latest `run`/`disabled` are always used.
 */
export function useCommands(cmds: Command[]): void {
  const ref = useRef(cmds)
  ref.current = cmds
  const signature = cmds.map((c) => `${c.id}\u0000${c.label}\u0000${c.disabled ? 1 : 0}\u0000${c.shortcut ?? ''}`).join('\u0001')
  useEffect(() => {
    const live = ref.current.map((c) => ({ ...c, run: () => ref.current.find((x) => x.id === c.id)?.run() }))
    return commands.register(live)
  }, [signature])
}

/** The page's Ctrl/⌘+Enter action (last mounted wins). Pass null to expose none. */
export function usePrimaryAction(action: PrimaryAction | null): void {
  const ref = useRef(action)
  ref.current = action
  const present = action != null
  const label = action?.label
  const disabled = action?.disabled
  useEffect(() => {
    if (!present) return
    const key = Symbol('primary')
    primary = {
      key,
      action: {
        get label() { return ref.current?.label ?? '' },
        get disabled() { return ref.current?.disabled },
        run: () => ref.current?.run(),
      },
    }
    emit()
    return () => { if (primary?.key === key) { primary = null; emit() } }
  }, [present])
  // Re-render palette/hint consumers when the label or enabled state changes.
  useEffect(() => { if (present) emit() }, [present, label, disabled])
}

export function useCommandList(): Command[] {
  return useSyncExternalStore(subscribe, commands.all, commands.all)
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, commands.isPaletteOpen, commands.isPaletteOpen)
}

export function usePrimary(): PrimaryAction | null {
  return useSyncExternalStore(subscribe, commands.primary, commands.primary)
}

export const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

let installed = false

/** Install Ctrl/⌘+K and Ctrl/⌘+Enter once (called by the app shell). */
export function installGlobalShortcuts(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod || e.altKey) return
    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault()
      commands.setPaletteOpen(!paletteOpen)
    } else if (e.key === 'Enter' && !e.defaultPrevented && !paletteOpen) {
      if (commands.runPrimary()) e.preventDefault()
    }
  })
}
