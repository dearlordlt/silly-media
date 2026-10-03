import { useState } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { clsx } from 'clsx'
import {
  Boxes, Clapperboard, Cpu, ExternalLink, Gamepad2, ImagePlus, Library, MessageSquare,
  Mic2, Music2, ScanEye, Settings2, Sparkles, Wand2, Zap, ChevronsLeft, ChevronsRight,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { useHealth } from '../../lib/query'
import { useApp } from '../../lib/store'
import { useLibrary } from '../../lib/library'
import { StatusDot } from '../ui/primitives'
import { Toaster } from '../ui/Toaster'

interface NavItem { to: string; label: string; icon: ReactNode }

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Create',
    items: [
      { to: '/studio', label: 'Studio', icon: <ImagePlus size={17} /> },
      { to: '/edit', label: 'Edit', icon: <Wand2 size={17} /> },
      { to: '/assets', label: 'Game Assets', icon: <Gamepad2 size={17} /> },
    ],
  },
  {
    group: 'Media',
    items: [
      { to: '/audio', label: 'Speech', icon: <Mic2 size={17} /> },
      { to: '/music', label: 'Music', icon: <Music2 size={17} /> },
      { to: '/video', label: 'Video', icon: <Clapperboard size={17} /> },
      { to: '/3d', label: '3D Models', icon: <Boxes size={17} /> },
    ],
  },
  {
    group: 'Understand',
    items: [
      { to: '/vision', label: 'Vision', icon: <ScanEye size={17} /> },
      { to: '/chat', label: 'Chat', icon: <MessageSquare size={17} /> },
    ],
  },
  {
    group: 'Manage',
    items: [
      { to: '/library', label: 'Library', icon: <Library size={17} /> },
      { to: '/system', label: 'System', icon: <Settings2 size={17} /> },
    ],
  },
]

const TITLES: Record<string, string> = {
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
  const { data: health, isError } = useHealth()
  const apiBase = useApp((s) => s.apiBase)
  const items = useLibrary()

  const loaded = health?.models_loaded ?? []
  const busy = loaded.length > 0

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
            <div key={section.group} className="mb-3">
              {!collapsed && <div className="px-2 py-1 text-[10.5px] font-semibold uppercase tracking-widest text-ink-faint">{section.group}</div>}
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active = path === item.to || path.startsWith(item.to + '/')
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={clsx(
                        'flex items-center gap-3 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors',
                        active ? 'bg-accent/15 text-ink shadow-[inset_0_0_0_1px_var(--color-accent-soft)]' : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
                        collapsed && 'justify-center px-0',
                      )}
                      title={collapsed ? item.label : undefined}
                    >
                      <span className={clsx(active && 'text-accent')}>{item.icon}</span>
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  )
                })}
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
        <header className="flex h-14 shrink-0 items-center gap-4 border-b border-line bg-panel/60 px-5 backdrop-blur">
          <h1 className="text-[15px] font-semibold">{TITLES[path] ?? 'Silly Media'}</h1>

          <div className="ml-auto flex items-center gap-4">
            <div className="hidden items-center gap-2 rounded-lg border border-line bg-bg px-2.5 py-1.5 lg:flex">
              <Cpu size={13} className="text-ink-faint" />
              <span className={clsx('text-[11.5px] font-medium', busy ? 'text-accent-2' : 'text-ink-dim')}>
                {busy ? loaded.join(', ') : 'GPU idle'}
              </span>
            </div>
            <Link to="/library" className="flex items-center gap-1.5 rounded-lg border border-line bg-bg px-2.5 py-1.5 text-[11.5px] text-ink-dim hover:text-ink">
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

        <main className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </main>
      </div>

      <Toaster />
    </div>
  )
}
