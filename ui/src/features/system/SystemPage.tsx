import { useEffect, useState, useSyncExternalStore } from 'react'
import { Bell, Check, Copy, Cpu, Download, HardDrive, Import, Library as LibraryIcon, Server, Trash2, UserRound } from 'lucide-react'
import type { ModelTypeKey } from '../../lib/types'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { SillyClient } from '../../lib/api'
import { useAspectRatios, useHealth, useModels } from '../../lib/query'
import { useApp, DEFAULT_API_BASE } from '../../lib/store'
import { library, useLibrary, type MediaKind } from '../../lib/library'
import { formatBytes } from '../../lib/media'
import { appInfo, fetchStats, type AppStats } from '../../lib/appApi'
import { importLegacy, removeLegacy, useLegacyImport } from '../../lib/legacyImport'
import { jobs, notificationsEnabled, setNotifications } from '../../lib/jobs'
import { Button, EmptyState, Input, Label, Panel, ProgressBar, Section, StatusDot, Switch } from '../../components/ui/primitives'
import { ArtifactGrid } from '../../components/Artifact'

const TYPES: { key: ModelTypeKey; label: string }[] = [
  { key: 'image', label: 'Image' },
  { key: 'img2img', label: 'Image editing' },
  { key: 'audio', label: 'Audio / TTS' },
  { key: 'music', label: 'Music' },
  { key: 'video', label: 'Video' },
  { key: 'vision', label: 'Vision' },
  { key: 'llm', label: 'LLM' },
  { key: 'model3d', label: '3D' },
]

const KINDS: { key: MediaKind; label: string }[] = [
  { key: 'image', label: 'Images' },
  { key: 'audio', label: 'Audio' },
  { key: 'video', label: 'Video' },
  { key: 'model3d', label: '3D models' },
]

export function SystemPage() {
  const client = useClient()
  const { data: health, isError } = useHealth()
  const { data: models } = useModels()
  const { data: ratios } = useAspectRatios()
  const { apiBase, confirmDeletes, set, setApiBase } = useApp()
  const [baseDraft, setBaseDraft] = useState(apiBase)
  const allItems = useLibrary()

  useEffect(() => { setBaseDraft(apiBase) }, [apiBase])

  const [checking, setChecking] = useState(false)
  const saveBase = async () => {
    const next = (baseDraft.trim() || DEFAULT_API_BASE).replace(/\/+$/, '')
    setChecking(true)
    try {
      // Probe the NEW endpoint before switching; the health query is keyed on the old one.
      const h = await new SillyClient(next).health({ signal: AbortSignal.timeout(4000) })
      setApiBase(next)
      toast.success('API endpoint updated', `${next} · ${h.status}`)
    } catch (e) {
      toast.error('Endpoint not reachable — not saved', `${next}: ${errorMessage(e)}`)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="scroll-area h-full p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <Section
          title={<span className="flex items-center gap-2"><Server size={15} /> Backend</span>}
          action={<StatusDot ok={!isError && health?.status === 'healthy'} label={isError ? 'unreachable' : (health?.status ?? '…')} />}
        >
          <Panel className="p-4">
            <Label hint={isError ? 'no response' : 'connected'}>API endpoint</Label>
            <div className="flex gap-2">
              <Input value={baseDraft} onChange={(e) => setBaseDraft(e.target.value)} placeholder={DEFAULT_API_BASE} />
              <Button variant="primary" icon={<Check size={15} />} loading={checking} onClick={() => void saveBase()}>Save</Button>
            </div>
            <p className="mt-2 text-[11.5px] text-ink-faint">
              Tip: open the UI with <code className="rounded bg-bg px-1">?api=http://host:4201</code> to point at a remote backend without saving.
            </p>
          </Panel>

          {health && (
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat label="Loaded now" value={health.models_loaded.length ? health.models_loaded.join(', ') : 'none'} />
              <Stat label="Image models" value={String(health.available_image_models.length)} />
              <Stat label="Audio models" value={String(health.available_audio_models.length)} />
              <Stat label="Video models" value={String(health.available_video_models.length)} />
            </div>
          )}
        </Section>

        <Section title={<span className="flex items-center gap-2"><Cpu size={15} /> Models</span>}>
          <div className="flex flex-col gap-2">
            {TYPES.map((t) => {
              const entry = models?.[t.key]
              const available = entry?.available ?? health?.[`available_${t.key}_models` as keyof typeof health]
              const list = Array.isArray(available) ? available : []
              const loaded = entry?.loaded ?? []
              return (
                <Panel key={t.key} className="flex items-center gap-3 px-4 py-3">
                  <span className="w-28 shrink-0 text-[12px] text-ink-dim">{t.label}</span>
                  <div className="flex flex-1 flex-wrap gap-1.5">
                    {list.length ? list.map((m) => (
                      <span key={m} className={loaded.includes(m)
                        ? 'rounded-md border border-good/40 bg-good/10 px-2 py-0.5 text-[11.5px] text-good'
                        : 'rounded-md border border-line bg-bg px-2 py-0.5 text-[11.5px] text-ink-dim'}>{m}</span>
                    )) : <span className="text-[11.5px] text-ink-faint">none registered</span>}
                  </div>
                </Panel>
              )
            })}
          </div>
        </Section>

        <ProfileStorage confirmDeletes={confirmDeletes} setConfirmDeletes={(v) => set({ confirmDeletes: v })} />

        <Section title={<span className="flex items-center gap-2"><LibraryIcon size={15} /> Aspect ratios</span>}>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            {ratios && Object.entries(ratios).map(([ratio, v]) => (
              <Panel key={ratio} className="px-3 py-2">
                <div className="text-[12px] font-medium text-ink">{ratio}</div>
                <div className="text-[11px] text-ink-faint">{v.dimensions_at_1024.join(' × ')}</div>
              </Panel>
            ))}
            {!ratios && <EmptyState title="Loading ratios…" />}
          </div>
        </Section>

        <Section title="Quick links">
          <div className="flex flex-wrap gap-2">
            <a href={`${apiBase}/docs`} target="_blank" rel="noreferrer"><Button variant="outline">API docs</Button></a>
            <a href={`${apiBase}/redoc`} target="_blank" rel="noreferrer"><Button variant="outline">ReDoc</Button></a>
            <Button variant="outline" icon={<Download size={14} />} onClick={() => {
              void client.models().then((m) => {
                const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a'); a.href = url; a.download = 'silly-media-models.json'; a.click()
                setTimeout(() => URL.revokeObjectURL(url), 2000)
              }).catch((e) => toast.error('Failed', errorMessage(e)))
            }}>Export model list</Button>
          </div>
        </Section>

        <Section title="Recent artifacts">
          <ArtifactGrid items={allItems.slice(0, 12)} columns={6} empty={{ title: 'Nothing stored yet' }} />
        </Section>
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Panel className="px-3 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-ink-faint">{label}</div>
      <div className="truncate text-[12.5px] text-ink" title={value}>{value}</div>
    </Panel>
  )
}

function ProfileStorage({ confirmDeletes, setConfirmDeletes }: { confirmDeletes: boolean; setConfirmDeletes: (v: boolean) => void }) {
  const info = appInfo()
  const items = useLibrary()
  const [stats, setStats] = useState<AppStats | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const notify = useSyncExternalStore(jobs.subscribe, notificationsEnabled, notificationsEnabled)
  const { summary, refresh } = useLegacyImport()
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null)
  const [removing, setRemoving] = useState(false)

  // Re-read totals whenever the library changes (this tab or another).
  useEffect(() => {
    let alive = true
    fetchStats().then(
      (s) => { if (alive) { setStats(s); setStatsError(null) } },
      (e) => { if (alive) setStatsError(errorMessage(e)) },
    )
    return () => { alive = false }
  }, [items])

  const copyDir = () => {
    navigator.clipboard.writeText(info.dataDir).then(
      () => toast.success('Copied data folder path'),
      (e) => toast.error('Copy failed', errorMessage(e)),
    )
  }

  const clearAll = async () => {
    if (confirmDeletes && !confirm(`Delete ALL stored artifacts in profile "${info.profile}"?`)) return
    try {
      await library.clear()
      toast.success('Library cleared')
    } catch (e) {
      toast.error('Clear failed', errorMessage(e))
    }
  }

  const runImport = async () => {
    setImporting({ done: 0, total: summary?.items ?? 0 })
    try {
      const r = await importLegacy((done, total) => setImporting({ done, total }))
      toast.success('Imported old browser storage', `${r.imported} items, ${r.keys} settings${r.skipped ? ` · ${r.skipped} already present` : ''}`)
    } catch (e) {
      toast.error('Import failed', errorMessage(e))
    } finally {
      setImporting(null)
      refresh()
    }
  }

  const runRemove = async () => {
    if (!confirm('Delete the old browser copy (IndexedDB library + localStorage)? The imported copy in this profile stays.')) return
    setRemoving(true)
    try {
      await removeLegacy()
      toast.success('Old browser storage removed')
    } catch (e) {
      toast.error('Remove failed', errorMessage(e))
    } finally {
      setRemoving(false)
      refresh()
    }
  }

  const toggleNotify = async (on: boolean) => {
    const granted = await setNotifications(on)
    if (on && !granted) toast.error('Notifications blocked', 'Allow notifications for this site in the browser settings.')
  }

  const legacyFound = summary != null && (summary.items > 0 || summary.keys > 0)

  return (
    <Section
      title={<span className="flex items-center gap-2"><HardDrive size={15} /> Profile &amp; storage</span>}
      action={<Switch checked={confirmDeletes} onChange={setConfirmDeletes} label="Confirm deletes" />}
    >
      <Panel className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-3">
          <UserRound size={16} className="shrink-0 text-ink-faint" />
          <span className="w-24 shrink-0 text-[12px] text-ink-dim">Profile</span>
          <span className="text-[13px] font-semibold text-ink">{info.profile}</span>
        </div>
        <div className="flex items-center gap-3">
          <HardDrive size={16} className="shrink-0 text-ink-faint" />
          <span className="w-24 shrink-0 text-[12px] text-ink-dim">Data folder</span>
          <code className="min-w-0 flex-1 truncate rounded bg-bg px-2 py-1 text-[11.5px] text-ink" title={info.dataDir}>{info.dataDir}</code>
          <Button variant="outline" size="sm" icon={<Copy size={13} />} onClick={copyDir}>Copy</Button>
        </div>
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Each profile has its own library and settings. Start another with{' '}
          <code className="rounded bg-bg px-1">./ui.sh --profile NAME</code>; list existing ones with{' '}
          <code className="rounded bg-bg px-1">./ui.sh --list-profiles</code>.
        </p>
      </Panel>

      <Panel className="flex items-center gap-4 px-4 py-3">
        <div className="text-[12.5px] text-ink-dim">
          {stats ? (
            <>
              <span className="font-semibold text-ink">{stats.items}</span> artifacts · {formatBytes(stats.bytes)}
              <span className="text-ink-faint"> · database {formatBytes(stats.dbBytes)}</span>
            </>
          ) : statsError ? <span className="text-bad">Stats unavailable: {statsError}</span> : 'Loading totals…'}
        </div>
        <Button className="ml-auto" variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={!stats?.items} onClick={() => void clearAll()}>Clear all</Button>
      </Panel>
      <div className="grid grid-cols-4 gap-2">
        {KINDS.map((k) => {
          const s = stats?.byKind[k.key]
          return (
            <Panel key={k.key} className="px-3 py-2">
              <div className="text-[11px] text-ink-faint">{k.label}</div>
              <div className="text-lg font-semibold">{s?.count ?? 0}</div>
              <div className="text-[11px] text-ink-faint">{formatBytes(s?.bytes ?? 0)}</div>
            </Panel>
          )
        })}
      </div>

      <Panel className="flex items-center gap-3 px-4 py-3">
        <Bell size={16} className="shrink-0 text-ink-faint" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-ink">Desktop notifications</div>
          <div className="text-[11.5px] text-ink-faint">Notify when a queued job finishes or fails while this tab is in the background.</div>
        </div>
        <Switch checked={notify} onChange={(v) => void toggleNotify(v)} />
      </Panel>

      <Panel className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-3">
          <Import size={16} className="shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] text-ink">Old browser storage</div>
            <div className="text-[11.5px] text-ink-faint">
              {summary == null ? 'Checking…'
                : legacyFound ? `Found ${summary.items} item${summary.items === 1 ? '' : 's'} and ${summary.keys} setting${summary.keys === 1 ? '' : 's'} from before profiles.`
                : 'Nothing left in this browser’s old storage.'}
              {summary?.imported && ` Last import: ${summary.imported.imported} items, ${summary.imported.keys} settings (${new Date(summary.imported.at).toLocaleString()}).`}
            </div>
          </div>
          {legacyFound && (
            <>
              <Button variant="primary" size="sm" icon={<Import size={13} />} loading={importing != null} disabled={removing} onClick={() => void runImport()}>
                {summary.imported ? 'Import again' : 'Import'}
              </Button>
              {summary.imported && (
                <Button variant="danger" size="sm" icon={<Trash2 size={13} />} loading={removing} disabled={importing != null} onClick={() => void runRemove()}>
                  Remove browser copy
                </Button>
              )}
            </>
          )}
        </div>
        {importing && (
          <div className="flex items-center gap-3">
            <ProgressBar value={importing.total ? (importing.done / importing.total) * 100 : 0} />
            <span className="shrink-0 text-[11px] text-ink-faint">{importing.done}/{importing.total}</span>
          </div>
        )}
      </Panel>
    </Section>
  )
}
