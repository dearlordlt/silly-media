/** Home dashboard: quick starts, latest results, backend / queue / library at a glance. */
import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { clsx } from 'clsx'
import {
  ArrowRight, AudioLines, Box, Cpu, Film, HardDrive, Hourglass, Image as ImageIcon, ListOrdered, Loader2, Search, Star,
} from 'lucide-react'
import { ArtifactGrid } from '../../components/Artifact'
import { PAGE_META, useTray } from '../../components/layout/ActivityTray'
import { ProgressBar, StatusDot } from '../../components/ui/primitives'
import { appInfo } from '../../lib/appApi'
import { commands, MOD_KEY } from '../../lib/commands'
import { useJobs } from '../../lib/jobs'
import type { JobPage } from '../../lib/jobs'
import { useLibrary } from '../../lib/library'
import type { MediaKind } from '../../lib/library'
import { formatBytes } from '../../lib/media'
import { useHealth } from '../../lib/query'
import type { HealthResponse } from '../../lib/types'

const TOOLS: { page: JobPage; description: string; tone: string }[] = [
  { page: 'studio', description: 'Text-to-image with presets, LoRAs and batches', tone: 'from-accent/35 to-accent/5 text-accent' },
  { page: 'edit', description: 'Change an image with a written instruction', tone: 'from-accent-2/30 to-accent-2/5 text-accent-2' },
  { page: 'assets', description: 'Pixel art, sprites and game-ready assets', tone: 'from-good/30 to-good/5 text-good' },
  { page: 'audio', description: 'Text-to-speech with voices and cloning', tone: 'from-warn/30 to-warn/5 text-warn' },
  { page: 'music', description: 'Songs and loops from a caption and lyrics', tone: 'from-accent/35 to-accent/5 text-accent' },
  { page: 'video', description: 'Short clips from text or a still image', tone: 'from-accent-2/30 to-accent-2/5 text-accent-2' },
  { page: '3d', description: 'Turn an image into a textured 3D model', tone: 'from-good/30 to-good/5 text-good' },
  { page: 'vision', description: 'Ask questions about any image', tone: 'from-warn/30 to-warn/5 text-warn' },
  { page: 'chat', description: 'Talk to the local language model', tone: 'from-accent/35 to-accent/5 text-accent' },
]

const KINDS: { kind: MediaKind; label: string; icon: ReactNode }[] = [
  { kind: 'image', label: 'Images', icon: <ImageIcon size={14} /> },
  { kind: 'audio', label: 'Audio', icon: <AudioLines size={14} /> },
  { kind: 'video', label: 'Videos', icon: <Film size={14} /> },
  { kind: 'model3d', label: '3D models', icon: <Box size={14} /> },
]

const AVAILABLE: { key: Exclude<keyof HealthResponse, 'status' | 'models_loaded'>; label: string }[] = [
  { key: 'available_image_models', label: 'image' },
  { key: 'available_img2img_models', label: 'edit' },
  { key: 'available_video_models', label: 'video' },
  { key: 'available_audio_models', label: 'speech' },
  { key: 'available_music_models', label: 'music' },
  { key: 'available_model3d_models', label: '3D' },
  { key: 'available_vision_models', label: 'vision' },
  { key: 'available_llm_models', label: 'LLM' },
]

const LATEST = 12

export function HomePage() {
  const items = useLibrary()
  const jobList = useJobs()
  const { profile } = appInfo()

  const stats = useMemo(() => {
    const byKind: Record<MediaKind, number> = { image: 0, audio: 0, video: 0, model3d: 0 }
    let bytes = 0
    let favorites = 0
    let today = 0
    const dayStart = new Date().setHours(0, 0, 0, 0)
    for (const i of items) {
      byKind[i.kind]++
      bytes += i.size
      if (i.favorite) favorites++
      if (i.createdAt >= dayStart) today++
    }
    return { byKind, bytes, favorites, today }
  }, [items])

  const activeByPage = useMemo(() => {
    const out: Partial<Record<JobPage, number>> = {}
    for (const j of jobList) if (j.state === 'running' || j.state === 'queued') out[j.page] = (out[j.page] ?? 0) + 1
    return out
  }, [jobList])

  const hour = new Date().getHours()
  const greeting = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
  const latest = items.slice(0, LATEST)

  return (
    <div className="scroll-area h-full">
      <div className="mx-auto flex max-w-[1480px] flex-col gap-7 px-8 py-7">
        <div className="flex items-end justify-between gap-6">
          <div className="min-w-0">
            <h2 className="text-[22px] font-semibold tracking-tight">{greeting}</h2>
            <p className="mt-1 truncate text-[13px] text-ink-dim">
              Profile <span className={clsx('font-semibold', profile === 'default' ? 'text-ink' : 'text-warn')}>{profile}</span>
              {' · '}{items.length} item{items.length === 1 ? '' : 's'} · {formatBytes(stats.bytes)}
              {stats.today > 0 && <> · <span className="text-good">{stats.today} new today</span></>}
            </p>
          </div>
          <button
            onClick={() => commands.setPaletteOpen(true)}
            className="flex h-10 w-[340px] shrink-0 items-center gap-2.5 rounded-xl border border-line bg-panel px-3.5 text-[13px] text-ink-faint transition-colors hover:border-line-strong hover:text-ink-dim"
          >
            <Search size={15} />
            <span className="flex-1 text-left">Search library or run a command…</span>
            <kbd className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-sans text-[10.5px]">{MOD_KEY} K</kbd>
          </button>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)_300px] gap-7">
          <div className="flex min-w-0 flex-col gap-7">
            <section>
              <SectionTitle>Start something</SectionTitle>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(205px,1fr))] gap-3">
                {TOOLS.map(({ page, description, tone }) => {
                  const { to, label, Icon } = PAGE_META[page]
                  const active = activeByPage[page]
                  return (
                    <Link
                      key={page}
                      to={to}
                      className="group relative flex items-start gap-3 rounded-xl border border-line bg-panel p-3.5 transition-all hover:-translate-y-px hover:border-line-strong hover:bg-panel-2"
                    >
                      <span className={clsx('grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br', tone)}>
                        <Icon size={19} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 text-[13.5px] font-semibold text-ink">
                          {label}
                          <ArrowRight size={13} className="-translate-x-1 text-ink-faint opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                        </span>
                        <span className="mt-0.5 block text-[11.5px] leading-snug text-ink-faint">{description}</span>
                      </span>
                      {active ? (
                        <span className="absolute right-2.5 top-2.5 flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold text-accent">
                          <Loader2 size={10} className="animate-spin" /> {active}
                        </span>
                      ) : null}
                    </Link>
                  )
                })}
              </div>
            </section>

            <section>
              <SectionTitle action={<Link to="/library" className="flex items-center gap-1 text-[12px] text-ink-dim hover:text-ink">Open library <ArrowRight size={12} /></Link>}>
                Continue where you left off
              </SectionTitle>
              <ArtifactGrid
                items={latest}
                columns={5}
                empty={{ title: 'No results yet', detail: 'Pick a tool above — everything you generate is saved to this profile’s library.' }}
              />
            </section>
          </div>

          <aside className="flex flex-col gap-4">
            <BackendCard />
            <ActivityCard />
            <div className="rounded-xl border border-line bg-panel p-4">
              <CardTitle icon={<HardDrive size={14} />} action={<Link to="/library" className="text-[11.5px] text-ink-dim hover:text-ink">Browse</Link>}>Library</CardTitle>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {KINDS.map(({ kind, label, icon }) => (
                  <div key={kind} className="rounded-lg border border-line bg-bg px-3 py-2">
                    <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">{icon} {label}</div>
                    <div className="mt-0.5 text-[17px] font-semibold tabular-nums">{stats.byKind[kind]}</div>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between text-[11.5px] text-ink-dim">
                <span className="flex items-center gap-1.5"><Star size={12} className="text-warn" /> {stats.favorites} favorite{stats.favorites === 1 ? '' : 's'}</span>
                <span className="tabular-nums">{formatBytes(stats.bytes)} on disk</span>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h3 className="text-[11px] font-semibold uppercase tracking-widest text-ink-faint">{children}</h3>
      {action}
    </div>
  )
}

function CardTitle({ icon, children, action }: { icon: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-ink-faint">{icon}</span>
      <span className="flex-1 text-[13px] font-semibold">{children}</span>
      {action}
    </div>
  )
}

function BackendCard() {
  const { data: health, isError, isLoading } = useHealth()
  const loaded = health?.models_loaded ?? []
  const available = health ? AVAILABLE.map((a) => ({ label: a.label, n: health[a.key].length })).filter((a) => a.n > 0) : []
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <CardTitle icon={<Cpu size={14} />} action={<Link to="/system" className="text-[11.5px] text-ink-dim hover:text-ink">System</Link>}>Backend</CardTitle>
      <div className="mt-3">
        <StatusDot
          ok={!isError && health?.status === 'healthy'}
          label={isError ? 'Offline — start the backend container' : isLoading ? 'Connecting…' : health?.status ?? 'unknown'}
        />
      </div>
      <div className="mt-3 text-[11px] font-medium text-ink-faint">In VRAM</div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {loaded.length
          ? loaded.map((m) => (
            <span key={m} className="rounded-md border border-accent-2/30 bg-accent-2/10 px-2 py-0.5 text-[11px] font-medium text-accent-2">{m}</span>
          ))
          : <span className="text-[12px] text-ink-dim">{isError ? '—' : 'Nothing loaded · GPU free'}</span>}
      </div>
      {available.length > 0 && (
        <div className="mt-3 text-[11px] leading-relaxed text-ink-faint">
          {available.map((a) => `${a.n} ${a.label}`).join(' · ')} models available
        </div>
      )}
    </div>
  )
}

function ActivityCard() {
  const all = useJobs()
  const setTrayOpen = useTray((s) => s.setOpen)
  const running = all.filter((j) => j.state === 'running')
  const queued = all.filter((j) => j.state === 'queued').length
  const failed = all.filter((j) => j.state === 'failed').length
  const lastDone = all.find((j) => j.state === 'done')

  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <CardTitle
        icon={<ListOrdered size={14} />}
        action={<button onClick={() => setTrayOpen(true)} className="text-[11.5px] text-ink-dim hover:text-ink">Open queue</button>}
      >
        Activity
      </CardTitle>
      <div className="mt-3 flex flex-col gap-2.5">
        {running.map((j) => {
          const pct = j.progress.fraction != null ? Math.round(j.progress.fraction * 100) : null
          return (
            <button key={j.id} onClick={() => setTrayOpen(true)} className="text-left">
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                <Loader2 size={12} className="shrink-0 animate-spin text-accent" />
                <span className="min-w-0 flex-1 truncate font-medium">{j.label}</span>
                <span className="shrink-0 text-[11px] text-ink-faint">{pct != null ? `${pct}%` : PAGE_META[j.page].label}</span>
              </div>
              <ProgressBar value={pct ?? 0} />
            </button>
          )
        })}
        {!running.length && (
          <div className="flex items-center gap-2 text-[12px] text-ink-dim">
            <Hourglass size={12} className="text-ink-faint" /> Nothing running
          </div>
        )}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
          <span>{queued} queued</span>
          {failed > 0 && <span className="text-bad">{failed} failed</span>}
          {lastDone && <span className="min-w-0 truncate">Last: {lastDone.label}</span>}
        </div>
      </div>
    </div>
  )
}
