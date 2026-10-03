import { useEffect, useState } from 'react'
import type { DragEvent, ReactNode } from 'react'
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { clsx } from 'clsx'
import {
  Boxes, Clapperboard, ExternalLink, FlaskConical, Gamepad2, House, ImagePlus, Library, MessageSquare,
  Mic2, Music2, ScanEye, Search, Settings2, Sparkles, Wand2, Zap, ChevronsLeft, ChevronsRight,
} from 'lucide-react'
import { useHealth } from '../../lib/query'
import { useApp } from '../../lib/store'
import { useLibrary } from '../../lib/library'
import { appInfo } from '../../lib/appApi'
import { commands, installGlobalShortcuts, MOD_KEY, useCommands } from '../../lib/commands'
import type { Command } from '../../lib/commands'
import { droppedItem, isItemDrag } from '../../lib/drag'
import { HANDOFF_ROUTES, handOffItem } from '../../lib/handoff'
import type { HandoffTarget } from '../../lib/handoff'
import { jobs, useJobCounts } from '../../lib/jobs'
import { StatusDot } from '../ui/primitives'
import { Toaster } from '../ui/Toaster'
import { ActivityTray, useTray } from './ActivityTray'
import { CommandPalette } from './CommandPalette'
import { LegacyBanner } from './LegacyBanner'

type NavPath = '/' | '/studio' | '/edit' | '/assets' | '/audio' | '/music' | '/video' | '/3d' | '/vision' | '/chat' | '/library' | '/system'

interface NavItem {
  to: NavPath
  /** Command id suffix (`nav.<id>`). */
  id: string
  label: string
  icon: ReactNode
  /** Accepts dragged library images, handing them off to this page. */
  drop?: HandoffTarget
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: '',
    items: [
      { to: '/', id: 'home', label: 'Home', icon: <House size={17} /> },
    ],
  },
  {
    group: 'Create',
    items: [
      { to: '/studio', id: 'studio', label: 'Studio', icon: <ImagePlus size={17} /> },
      { to: '/edit', id: 'edit', label: 'Edit', icon: <Wand2 size={17} />, drop: 'edit' },
      { to: '/assets', id: 'assets', label: 'Game Assets', icon: <Gamepad2 size={17} /> },
    ],
  },
  {
    group: 'Media',
    items: [
      { to: '/audio', id: 'audio', label: 'Speech', icon: <Mic2 size={17} /> },
      { to: '/music', id: 'music', label: 'Music', icon: <Music2 size={17} /> },
      { to: '/video', id: 'video', label: 'Video', icon: <Clapperboard size={17} />, drop: 'video' },
      { to: '/3d', id: '3d', label: '3D Models', icon: <Boxes size={17} />, drop: '3d' },
    ],
  },
  {
    group: 'Understand',
    items: [
      { to: '/vision', id: 'vision', label: 'Vision', icon: <ScanEye size={17} />, drop: 'vision' },
      { to: '/chat', id: 'chat', label: 'Chat', icon: <MessageSquare size={17} /> },
    ],
  },
  {
    group: 'Manage',
    items: [
      { to: '/library', id: 'library', label: 'Library', icon: <Library size={17} /> },
      { to: '/system', id: 'system', label: 'System', icon: <Settings2 size={17} /> },
    ],
  },
]

const TITLES: Record<string, string> = {
  '/': 'Home',
  '/studio': 'Studio',
  '/edit': 'Edit Image',
  '/assets': 'Game Assets',
  '/audio': 'Speech',
  '/music': 'Music',
  '/video': 'Video',
  '/3d': '3D Models',
  '/vision': 'Vision',
  '/chat': 'Chat',
  '/library': 'Library',
  '/system': 'System',
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(false)
  const path = useRouterState({ select: (s) => s.location.pathname })
  const navigate = useNavigate()
  const { data: health, isError } = useHealth()
  const apiBase = useApp((s) => s.apiBase)
  const items = useLibrary()
  const counts = useJobCounts()
  const setTrayOpen = useTray((s) => s.setOpen)
  const { profile, dataDir } = appInfo()

  useEffect(() => { installGlobalShortcuts() }, [])

  const appCommands: Command[] = [
    ...NAV.flatMap((s) => s.items).map((item): Command => ({
      id: `nav.${item.id}`,
      label: `Go to ${item.label}`,
      group: 'Navigate',
      keywords: `${TITLES[item.to] ?? ''} page open`,
      run: () => void navigate({ to: item.to }),
    })),
    { id: 'nav.activity', label: 'Show activity & queue', group: 'App', keywords: 'jobs tray progress running', run: () => setTrayOpen(true) },
    {
      id: 'nav.jobs.cancelQueued', label: 'Cancel all queued jobs', group: 'App', keywords: 'queue stop',
      disabled: counts.queued === 0, run: () => jobs.cancelQueued(),
    },
    { id: 'nav.jobs.clearFinished', label: 'Clear finished jobs', group: 'App', keywords: 'activity history', run: () => jobs.clearFinished() },
    { id: 'nav.sidebar', label: collapsed ? 'Expand sidebar' : 'Collapse sidebar', group: 'App', keywords: 'toggle navigation', run: () => setCollapsed((c) => !c) },
    { id: 'nav.apiDocs', label: 'Open API docs', group: 'App', keywords: 'swagger backend', run: () => void window.open(`${apiBase}/docs`, '_blank', 'noreferrer') },
  ]
  useCommands(appCommands)

  return (
    <div className="flex h-full w-full overflow-hidden bg-bg text-ink">
      <aside className={clsx('flex shrink-0 flex-col border-r border-line bg-panel transition-[width] duration-200', collapsed ? 'w-[62px]' : 'w-[218px]')}>
        <div className="flex h-14 items-center gap-2.5 px-4">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-white">
            <Sparkles size={15} />
          </div>
          {!collapsed && <span className="truncate text-[15px] font-semibold tracking-tight">Silly Media</span>}
        </div>

        <nav className="scroll-area flex-1 px-2 py-2">
          {NAV.map((section) => (
            <div key={section.group || 'top'} className="mb-3">
              {!collapsed && section.group && <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint">{section.group}</div>}
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => (
                  <NavLink
                    key={item.to}
                    item={item}
                    active={item.to === '/' ? path === '/' : path === item.to || path.startsWith(item.to + '/')}
                    collapsed={collapsed}
                  />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-10 items-center justify-center border-t border-line text-ink-faint hover:text-ink"
        >
          {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
        </button>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-30 flex h-14 shrink-0 items-center gap-3 border-b border-line bg-panel/60 px-5 backdrop-blur">
          <h1 className="text-[15px] font-semibold">{TITLES[path] ?? 'Silly Media'}</h1>
          {profile !== 'default' && (
            <span
              title={`Profile "${profile}" — data in ${dataDir}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-0.5 text-[11px] font-semibold text-warn"
            >
              <FlaskConical size={12} /> {profile}
            </span>
          )}

          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => commands.setPaletteOpen(true)}
              title="Command palette: pages, actions, library search"
              className="flex h-8 items-center gap-2 rounded-lg border border-line bg-bg pl-2.5 pr-1.5 text-[11.5px] text-ink-faint transition-colors hover:border-line-strong hover:text-ink"
            >
              <Search size={13} />
              <span className="hidden xl:inline">Search & commands</span>
              <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-sans text-[10.5px]">{MOD_KEY} K</kbd>
            </button>
            <ActivityTray />
            <Link
              to="/library"
              title="Library items"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 text-[11.5px] text-ink-dim hover:text-ink"
            >
              <Library size={13} /> {items.length}
            </Link>
            <div className="hidden items-center gap-2 xl:flex">
              <StatusDot ok={!isError && health?.status === 'healthy'} label={isError ? 'offline' : health?.status ?? '…'} />
            </div>
            <a
              href={`${apiBase}/docs`} target="_blank" rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint hover:text-ink"
              title="Open the API docs"
            >
              <Zap size={13} /> API <ExternalLink size={11} />
            </a>
          </div>
        </header>

        <LegacyBanner />

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
      <Toaster />
    </div>
  )
}

/**
 * Sidebar entry. Entries with `drop` accept library images dragged from any
 * gallery and open them on that page (not the page you're on: it would not
 * pick the hand-off up without remounting; drop onto its image input instead).
 */
function NavLink({ item, active, collapsed }: { item: NavItem; active: boolean; collapsed: boolean }) {
  const navigate = useNavigate()
  const [over, setOver] = useState(false)
  const target = active ? undefined : item.drop

  const onDragOver = (e: DragEvent) => {
    if (!target || !isItemDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!over) setOver(true)
  }
  const onDragLeave = (e: DragEvent) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return
    setOver(false)
  }
  const onDrop = (e: DragEvent) => {
    setOver(false)
    if (!target || !isItemDrag(e)) return
    e.preventDefault()
    const dropped = droppedItem(e)
    if (!dropped || dropped.kind !== 'image') return
    handOffItem(target, dropped)
    void navigate({ to: HANDOFF_ROUTES[target] })
  }

  return (
    <Link
      to={item.to}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={clsx(
        'flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
        over
          ? 'bg-accent-2/15 text-ink shadow-[inset_0_0_0_1.5px_var(--color-accent-2)]'
          : active ? 'bg-accent/15 text-ink shadow-[inset_0_0_0_1px_var(--color-accent-soft)]' : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
        collapsed && 'justify-center px-0',
      )}
      title={collapsed ? item.label : target ? `${item.label} — drop a library image here to open it` : undefined}
    >
      <span className={clsx(over ? 'text-accent-2' : active && 'text-accent')}>{item.icon}</span>
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && over && <span className="ml-auto text-[10.5px] font-semibold text-accent-2">Drop</span>}
    </Link>
  )
}
