import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Clock, Download, Music2, RotateCcw, Save, Trash2, Wand2, X } from 'lucide-react'
import type { SillyClient } from '../../lib/api'
import type { MusicGenerateRequest } from '../../lib/types'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { downloadItem, itemExtension, library, useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { formatBytes, formatDuration } from '../../lib/media'
import { useApp } from '../../lib/store'
import { jobs, throwIfCancelled, usePageJobs } from '../../lib/jobs'
import type { Job, JobContext } from '../../lib/jobs'
import { MOD_KEY, useCommands, usePrimaryAction } from '../../lib/commands'
import { JobStrip } from '../../components/Progress'
import { EnhancePrompt } from '../../components/EnhancePrompt'
import {
  Button, Chip, EmptyState, IconButton, Input, Label, Section, Segmented, Select, Slider, StatusDot, Switch, Textarea,
} from '../../components/ui/primitives'
import { ArtifactGrid } from '../../components/Artifact'
import { pollServerJob, queueLabel, statusProgress, useGpuAhead } from '../audio/jobQueue'
import {
  BUILTIN_PROFILES, GENRE_TEMPLATES, MUSIC_DEFAULTS, SECTION_TAGS, loadUserProfiles, readSettings, saveUserProfiles,
} from './presets'
import type { MusicSettings, SongModel } from './presets'

type MusicModel = { id: string; name: string; loaded: boolean; default_steps: number; estimated_vram_gb: number }

/** Queue-job payload (`job.data`) of a music generation. */
interface MusicJobData {
  kind: 'music'
  caption: string
  model: SongModel
  duration: number
  settings: MusicSettings
  /** Router job id on the backend, once submitted. */
  serverJobId?: string
  estimated?: number
}

interface Track {
  item: MediaItem
  index: number
  sampleRate: number | null
  /** Model-internal job id that owns the files on disk (from the status download_url). */
  fileJobId: string | null
}

/** A finished generation, rebuilt from the shared library (source === 'music'). */
interface HistoryEntry {
  jobId: string
  caption: string
  model: string
  duration: number | null
  createdAt: number
  elapsed: number | null
  settings: Partial<MusicSettings>
  tracks: Track[]
}

type View = { type: 'job'; job: Job } | { type: 'entry'; entry: HistoryEntry }

const CAPTION_MAX = 512
const LYRICS_MAX = 4096
/** `job.group` of music generations (Enhance jobs share the page). */
const GROUP = 'music'

const TAGS = [
  'pop', 'rock', 'lo-fi', 'synthwave', 'ambient', 'jazz', 'orchestral',
  'hip-hop', 'edm', 'cinematic', 'chill', 'upbeat', 'melancholic', 'epic', 'dreamy',
]

const isMusicData = (d: unknown): d is MusicJobData => typeof d === 'object' && d !== null && 'kind' in d && d.kind === 'music'

function metaString(meta: MediaItem['meta'], key: string): string | null {
  const v = meta?.[key]
  return typeof v === 'string' ? v : null
}

function metaNumber(meta: MediaItem['meta'], key: string): number | null {
  const v = meta?.[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function groupHistory(items: MediaItem[]): HistoryEntry[] {
  const byJob = new Map<string, HistoryEntry>()
  for (const item of items) {
    if (item.source !== 'music') continue
    const jobId = metaString(item.meta, 'jobId') ?? item.id
    let entry = byJob.get(jobId)
    if (!entry) {
      entry = {
        jobId,
        caption: item.prompt ?? item.name,
        model: item.model ?? '',
        duration: item.durationSeconds ?? null,
        createdAt: item.createdAt,
        elapsed: metaNumber(item.meta, 'elapsed'),
        settings: readSettings(item.meta?.settings),
        tracks: [],
      }
      byJob.set(jobId, entry)
    }
    entry.createdAt = Math.max(entry.createdAt, item.createdAt)
    entry.tracks.push({
      item,
      index: metaNumber(item.meta, 'index') ?? entry.tracks.length,
      sampleRate: metaNumber(item.meta, 'sampleRate'),
      fileJobId: metaString(item.meta, 'fileJobId'),
    })
  }
  const list = [...byJob.values()]
  for (const e of list) e.tracks.sort((a, b) => a.index - b.index)
  return list.sort((a, b) => b.createdAt - a.createdAt)
}

/** The status payload's download_url is `/music/download/{internalJobId}/{index}`. */
function fileJobIdFrom(downloadUrl: string): string | null {
  const m = /\/music\/download\/([^/]+)\/\d+/.exec(downloadUrl)
  return m ? m[1] : null
}

function trackFilename(entry: HistoryEntry, t: Track): string {
  return `music-${entry.jobId.slice(0, 8)}-${t.index + 1}.${itemExtension(t.item)}`
}

function modelLabel(model: string): string {
  return model === 'ace-step-quality' ? 'ACE-Step Quality' : model === 'ace-step' ? 'ACE-Step' : model || 'unknown model'
}

/**
 * Queue-job body: submit to `/music/generate`, poll the server job, then pull
 * every variation into the library. Self-contained (outlives the page).
 */
async function runMusic(client: SillyClient, body: MusicGenerateRequest, base: MusicJobData, ctx: JobContext): Promise<void> {
  try {
    ctx.report({ message: 'Submitting' })
    const res = await client.music(body)
    throwIfCancelled(ctx.signal)
    const data: MusicJobData = { ...base, serverJobId: res.job_id, estimated: res.estimated_time_seconds }
    ctx.setData(data)
    const st = await pollServerJob(
      ctx.signal,
      (signal) => client.musicStatus(res.job_id, { signal }),
      (s) => ctx.report(statusProgress(s, 'Generating audio')),
    )
    const audios = st.audios ?? []
    if (!audios.length) throw new Error('The job produced no audio')
    const elapsed = st.elapsed_seconds ?? null
    const createdAt = Date.now()
    const failures: string[] = []
    let saved = 0
    for (const [i, a] of audios.entries()) {
      throwIfCancelled(ctx.signal)
      ctx.report({ fraction: null, step: i + 1, total: audios.length, message: 'Saving tracks' })
      try {
        // The status payload's download_url carries the model-internal job id
        // (the router's job id is unrelated), so trust it, not a rebuilt path.
        const url = client.media(a.download_url) ?? client.musicDownloadUrl(res.job_id, a.index)
        const r = await fetch(url, { signal: ctx.signal })
        if (!r.ok) throw new Error(`Variation ${a.index + 1} download failed (${r.status})`)
        const item = await library.add({
          kind: 'audio',
          source: 'music',
          blob: await r.blob(),
          name: `${base.caption.slice(0, 48) || 'music'} · ${a.index + 1}`,
          prompt: base.caption,
          model: base.model,
          seed: a.seed,
          durationSeconds: base.duration,
          createdAt,
          meta: {
            jobId: res.job_id,
            index: a.index,
            sampleRate: a.sample_rate,
            fileJobId: fileJobIdFrom(a.download_url),
            elapsed,
            settings: base.settings,
          },
        })
        ctx.addItem(item.id)
        saved++
      } catch (e) {
        if (ctx.signal.aborted) throw e
        failures.push(errorMessage(e))
      }
    }
    if (!saved) throw new Error(failures[0] ?? 'Could not load audio')
    toast.success(
      `Music ready (${saved} variation${saved === 1 ? '' : 's'})`,
      elapsed != null ? `Generated in ${formatDuration(elapsed)}` : undefined,
    )
    if (failures.length) toast.error('Some variations could not be saved', failures.join('\n'))
  } catch (e) {
    if (!ctx.signal.aborted) toast.error('Music generation failed', errorMessage(e))
    throw e
  }
}

/** Main-area view of a queued / running / failed / cancelled music job. */
function MusicJobView({ job, onRetry }: { job: Job; onRetry: () => void }) {
  const d = isMusicData(job.data) ? job.data : null
  const active = job.state === 'queued' || job.state === 'running'
  const retryButton = <Button size="sm" icon={<RotateCcw size={13} />} onClick={onRetry}>Retry</Button>
  return (
    <div className="flex flex-col gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-ink" title={d?.caption}>{d?.caption || job.detail || 'Music generation'}</h2>
        {d && (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
            <span>{modelLabel(d.model)}</span>
            <span>{formatDuration(d.duration)} song</span>
            <span>{d.settings.batchSize} variation{d.settings.batchSize === 1 ? '' : 's'}</span>
            {active && d.estimated ? <span>est. ~{formatDuration(d.estimated)}</span> : null}
          </div>
        )}
      </div>
      {active && <JobStrip job={job} label="Music generation" />}
      {job.state === 'failed' && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-bad/30 bg-bad/10 px-3 py-2.5 text-[12.5px] text-bad">
          <span className="min-w-0">{job.error ?? 'Generation failed'}</span>
          {retryButton}
        </div>
      )}
      {job.state === 'cancelled' && (
        <EmptyState
          icon={<Music2 size={22} />}
          title="Cancelled"
          detail="Stopped waiting for this song. The server may still finish it, but it will not be saved to your library."
          action={retryButton}
        />
      )}
    </div>
  )
}

export function MusicPage() {
  const client = useClient()
  const confirmDeletes = useApp((st) => st.confirmDeletes)

  const [s, setS] = useState<MusicSettings>(MUSIC_DEFAULTS)
  const [models, setModels] = useState<MusicModel[]>([])
  /** A queue job id or a history entry's server job id. */
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [activeGenre, setActiveGenre] = useState<string | null>(null)
  const [userProfiles, setUserProfiles] = useState(loadUserProfiles)
  const [profileKey, setProfileKey] = useState('')

  const audioItems = useLibrary('audio')
  const history = useMemo(() => groupHistory(audioItems), [audioItems])
  const pageJobs = usePageJobs('music')
  const musicJobs = useMemo(() => pageJobs.filter((j) => j.group === GROUP), [pageJobs])
  const sessionJobs = musicJobs.filter((j) => j.state === 'queued' || j.state === 'running' || j.state === 'failed')
  const queuedCount = musicJobs.filter((j) => j.state === 'queued').length
  const ahead = useGpuAhead()

  const set = (patch: Partial<MusicSettings>) => setS((prev) => ({ ...prev, ...patch }))

  useEffect(() => {
    let cancelled = false
    client.musicModels()
      .then((r) => { if (!cancelled) setModels(r.models) })
      .catch((e: unknown) => { if (!cancelled) toast.error('Music API unavailable', errorMessage(e)) })
    return () => { cancelled = true }
  }, [client])

  // Drop checkbox selections for entries that no longer exist.
  useEffect(() => {
    setChecked((prev) => {
      const alive = new Set(history.map((h) => h.jobId))
      const next = new Set([...prev].filter((id) => alive.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [history])

  const byId = useMemo<Record<string, MusicModel>>(
    () => Object.fromEntries(models.map((m) => [m.id, m])),
    [models],
  )
  const defaultSteps = byId[s.model]?.default_steps

  // What the main area shows: the selected job/entry, else the newest job, else the newest song.
  const view = useMemo((): View | null => {
    const viewFor = (job: Job): View | null => {
      if (job.state !== 'done') return { type: 'job', job }
      const entry = history.find((h) => h.tracks.some((t) => job.itemIds.includes(t.item.id)))
      return entry ? { type: 'entry', entry } : null
    }
    const selectedJob = selectedId ? musicJobs.find((j) => j.id === selectedId) : undefined
    const selectedEntry = selectedId && !selectedJob ? history.find((h) => h.jobId === selectedId) : undefined
    const picked = selectedJob ? viewFor(selectedJob) : selectedEntry ? { type: 'entry' as const, entry: selectedEntry } : null
    const latest = musicJobs[0]
    return picked
      ?? (latest && latest.state !== 'cancelled' ? viewFor(latest) : null)
      ?? (history[0] ? { type: 'entry', entry: history[0] } : null)
  }, [history, musicJobs, selectedId])
  const activeId = view?.type === 'entry' ? view.entry.jobId : view?.job.id ?? null
  const shownEntry = view?.type === 'entry' ? view.entry : null

  // --- composition helpers ---------------------------------------------------

  const appendTag = (tag: string) => {
    setActiveGenre(null)
    setS((prev) => {
      if (prev.caption.toLowerCase().includes(tag.toLowerCase())) return prev
      const base = prev.caption.trim()
      return { ...prev, caption: (base ? `${base}, ${tag}` : tag).slice(0, CAPTION_MAX) }
    })
  }

  const applyGenre = (name: string) => {
    const t = GENRE_TEMPLATES[name]
    if (!t) return
    set({ caption: t.caption, lyrics: t.lyrics, instrumental: !!t.instrumental })
    setActiveGenre(name)
  }

  const insertSection = (tag: string) => {
    const el = document.getElementById('music-lyrics')
    const area = el instanceof HTMLTextAreaElement ? el : null
    const start = area?.selectionStart ?? s.lyrics.length
    const end = area?.selectionEnd ?? start
    const before = s.lyrics.slice(0, start)
    const after = s.lyrics.slice(end)
    const lead = before && !before.endsWith('\n') ? '\n' : ''
    const insert = `${lead}${tag}\n`
    const next = (before + insert + after).slice(0, LYRICS_MAX)
    const caret = Math.min((before + insert).length, next.length)
    set({ lyrics: next })
    requestAnimationFrame(() => {
      area?.focus()
      area?.setSelectionRange(caret, caret)
    })
  }

  // --- profiles --------------------------------------------------------------

  const loadProfile = (key: string) => {
    setProfileKey(key)
    if (!key) return
    const [type, ...rest] = key.split(':')
    const name = rest.join(':')
    const profile = type === 'builtin' ? BUILTIN_PROFILES[name] : userProfiles[name]
    if (!profile) return
    set(profile)
    toast.success(`Loaded profile: ${name}`)
  }

  const saveProfile = () => {
    const name = window.prompt('Profile name:')?.trim()
    if (!name) return
    const next = { ...userProfiles, [name]: { ...s } }
    saveUserProfiles(next)
    setUserProfiles(next)
    setProfileKey(`user:${name}`)
    toast.success(`Saved profile: ${name}`)
  }

  const deleteProfile = () => {
    if (!profileKey) return
    const [type, ...rest] = profileKey.split(':')
    const name = rest.join(':')
    if (type === 'builtin') { toast.error('Cannot delete built-in profiles'); return }
    if (!window.confirm(`Delete profile "${name}"?`)) return
    const next = { ...userProfiles }
    delete next[name]
    saveUserProfiles(next)
    setUserProfiles(next)
    setProfileKey('')
    toast.success(`Deleted profile: ${name}`)
  }

  // --- jobs ------------------------------------------------------------------

  const generate = () => {
    const caption = s.caption.trim()
    if (!caption) { toast.error('Caption required', 'Describe the song you want to generate'); return }

    const bpm = Number(s.bpm)
    const steps = Number(s.inferenceSteps)
    const body: MusicGenerateRequest = {
      caption: caption.slice(0, CAPTION_MAX),
      lyrics: s.instrumental ? undefined : (s.lyrics.trim() ? s.lyrics.slice(0, LYRICS_MAX) : undefined),
      instrumental: s.instrumental,
      bpm: s.bpm.trim() && Number.isFinite(bpm) ? Math.round(Math.max(30, Math.min(300, bpm))) : null,
      keyscale: s.keyscale.trim() || undefined,
      timesignature: s.timesignature || undefined,
      duration: Math.max(10, Math.min(600, s.duration)),
      inference_steps: s.inferenceSteps.trim() && Number.isFinite(steps) ? Math.max(1, Math.round(steps)) : null,
      guidance_scale: s.guidanceScale,
      seed: s.seed,
      audio_format: s.audioFormat,
      batch_size: Math.max(1, Math.min(4, s.batchSize)),
      model: s.model,
    }
    const base: MusicJobData = { kind: 'music', caption, model: s.model, duration: body.duration ?? s.duration, settings: { ...s, caption } }
    const id = jobs.enqueue({
      page: 'music',
      group: GROUP,
      label: 'Music',
      detail: caption.slice(0, 80),
      data: base,
      run: (ctx) => runMusic(client, body, base, ctx),
    })
    setSelectedId(id)
    if (ahead > 0) toast.info('Music queued', `${ahead} job${ahead === 1 ? '' : 's'} ahead`)
  }

  const retry = (job: Job) => {
    const id = jobs.retry(job.id)
    if (id) { jobs.remove(job.id); setSelectedId(id) }
  }

  const reuse = (entry: HistoryEntry, seed?: number) => {
    const model = entry.model === 'ace-step' || entry.model === 'ace-step-quality' ? entry.model : undefined
    setS((prev) => ({
      ...prev,
      caption: entry.caption,
      ...(model ? { model } : {}),
      ...(entry.duration != null ? { duration: entry.duration } : {}),
      ...entry.settings,
      ...(seed != null ? { seed } : {}),
    }))
    setActiveGenre(null)
    toast.success(seed != null ? `Settings reused with seed ${seed}` : 'Settings reused')
  }

  const downloadEntries = (entries: HistoryEntry[]) => {
    let count = 0
    for (const e of entries) {
      for (const t of e.tracks) { downloadItem(t.item, trackFilename(e, t)); count++ }
    }
    if (count > 1) toast.success(`Downloading ${count} files…`)
  }

  const deleteEntries = async (entries: HistoryEntry[]) => {
    if (!entries.length) { toast.error('No items selected'); return }
    const label = entries.length === 1 ? `"${entries[0].caption.slice(0, 60)}"` : `${entries.length} items`
    if (confirmDeletes && !window.confirm(`Delete ${label} and the generated files on the server?`)) return
    // Files live under the model-internal job id; the router id only clears the job record.
    const serverIds = new Set<string>()
    for (const e of entries) {
      serverIds.add(e.jobId)
      for (const t of e.tracks) if (t.fileJobId) serverIds.add(t.fileJobId)
    }
    const results = await Promise.allSettled([...serverIds].map((id) => client.deleteMusic(id)))
    const serverFailed = results.filter((r) => r.status === 'rejected').length
    try {
      await library.removeMany(entries.flatMap((e) => e.tracks.map((t) => t.item.id)))
    } catch (err) {
      toast.error('Could not remove from library', errorMessage(err))
      return
    }
    if (entries.some((e) => e.jobId === selectedId)) setSelectedId(null)
    toast.success(`Deleted ${entries.length} item${entries.length === 1 ? '' : 's'}`, serverFailed ? 'Some server files could not be deleted' : undefined)
  }

  const toggleChecked = (id: string) => setChecked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const allChecked = history.length > 0 && history.every((h) => checked.has(h.jobId))
  const toggleAll = () => setChecked(allChecked ? new Set() : new Set(history.map((h) => h.jobId)))
  const checkedEntries = history.filter((h) => checked.has(h.jobId))

  const profileNames = Object.keys(userProfiles)
  const generateLabel = queueLabel('Generate music', ahead)

  usePrimaryAction({ label: generateLabel, run: generate })
  useCommands([
    { id: 'music.generate', label: 'Generate music', group: 'Music', shortcut: `${MOD_KEY}+Enter`, keywords: 'song compose', run: generate },
    { id: 'music.instrumental', label: s.instrumental ? 'Switch to vocals (use lyrics)' : 'Switch to instrumental', group: 'Music', run: () => set({ instrumental: !s.instrumental }) },
    { id: 'music.random-seed', label: 'Use a random seed', group: 'Music', run: () => set({ seed: -1 }) },
    { id: 'music.save-profile', label: 'Save settings as profile…', group: 'Music', run: saveProfile },
    { id: 'music.reuse', label: 'Reuse settings of the shown song', group: 'Music', disabled: !shownEntry, run: () => { if (shownEntry) reuse(shownEntry) } },
    { id: 'music.download', label: 'Download the shown song', group: 'Music', disabled: !shownEntry, run: () => { if (shownEntry) downloadEntries([shownEntry]) } },
    { id: 'music.cancel-queued', label: 'Cancel queued music jobs', group: 'Music', disabled: !queuedCount, run: () => jobs.cancelQueued({ page: 'music', group: GROUP }) },
  ])

  return (
    <div className="flex h-full">
      {/* Controls */}
      <div className="scroll-area w-[360px] shrink-0 border-r border-line p-5">
        <Section title="Profile">
          <div className="flex gap-1.5">
            <Select className="flex-1" value={profileKey} onChange={(e) => loadProfile(e.target.value)}>
              <option value="">— Select profile —</option>
              <optgroup label="Built-in">
                {Object.keys(BUILTIN_PROFILES).map((n) => <option key={n} value={`builtin:${n}`}>{n}</option>)}
              </optgroup>
              {profileNames.length > 0 && (
                <optgroup label="Custom">
                  {profileNames.map((n) => <option key={n} value={`user:${n}`}>{n}</option>)}
                </optgroup>
              )}
            </Select>
            <IconButton title="Save current settings as profile" onClick={saveProfile}><Save size={14} /></IconButton>
            <IconButton title="Delete selected profile" onClick={deleteProfile} disabled={!profileKey.startsWith('user:')}><Trash2 size={14} /></IconButton>
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section
          title="Model"
          action={<StatusDot ok={!!byId[s.model]?.loaded} label={byId[s.model]?.loaded ? 'loaded' : 'idle'} />}
        >
          <Segmented<SongModel>
            value={s.model}
            onChange={(v) => set({ model: v })}
            options={[
              { value: 'ace-step', label: 'ACE-Step · fast' },
              { value: 'ace-step-quality', label: 'Quality' },
            ]}
          />
          <p className="text-[11.5px] leading-relaxed text-ink-faint">
            {byId[s.model]?.name ?? (s.model === 'ace-step' ? 'ACE-Step 1.5 Turbo' : 'ACE-Step 1.5 Quality')}
            {defaultSteps != null ? ` · default ${defaultSteps} steps` : ''}
            {byId[s.model] ? ` · ~${byId[s.model]?.estimated_vram_gb} GB VRAM` : ''}
          </p>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section
          title="Caption / tags"
          action={
            <span className="flex items-center gap-1.5">
              <EnhancePrompt kind="music" value={s.caption} onChange={(v) => { setActiveGenre(null); set({ caption: v.slice(0, CAPTION_MAX) }) }} />
              <span className="text-[11px] text-ink-faint">{s.caption.length}/{CAPTION_MAX}</span>
            </span>
          }
        >
          <Textarea
            value={s.caption}
            maxLength={CAPTION_MAX}
            rows={3}
            placeholder="Comma-separated tags: genre, instruments, bpm, mood, vocal style — e.g. rock, electric guitar, drums, 130 bpm, energetic, male vocals"
            onChange={(e) => { setActiveGenre(null); set({ caption: e.target.value }) }}
          />
          <div className="flex flex-wrap gap-1.5">
            {TAGS.map((t) => (
              <Chip key={t} onClick={() => appendTag(t)} active={s.caption.toLowerCase().includes(t.toLowerCase())}>
                {t}
              </Chip>
            ))}
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section title="Genre templates" action={<span className="text-[11px] text-ink-faint">caption + lyrics</span>}>
          <div className="grid grid-cols-3 gap-1.5">
            {Object.keys(GENRE_TEMPLATES).map((g) => (
              <button
                key={g}
                type="button"
                onClick={() => applyGenre(g)}
                className={clsx(
                  'rounded-lg border px-2 py-1.5 text-[12px] transition-colors',
                  activeGenre === g ? 'border-accent/60 bg-accent/15 text-ink' : 'border-line text-ink-dim hover:border-line-strong hover:text-ink',
                )}
              >
                {g}
              </button>
            ))}
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section
          title="Lyrics"
          action={<Switch checked={s.instrumental} onChange={(v) => set({ instrumental: v })} label="Instrumental" />}
        >
          {s.instrumental ? (
            <p className="text-[11.5px] text-ink-faint">Instrumental mode — no vocals, lyrics are not sent.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {SECTION_TAGS.map((t) => (
                  <Chip key={t} onClick={() => insertSection(t)}>{t}</Chip>
                ))}
              </div>
              <Textarea
                id="music-lyrics"
                value={s.lyrics}
                maxLength={LYRICS_MAX}
                rows={8}
                placeholder={'[Verse]\nWrite your lyrics here…\n\n[Chorus]\nThe catchy chorus goes here…'}
                onChange={(e) => set({ lyrics: e.target.value })}
              />
              <p className="text-right text-[11px] text-ink-faint">{s.lyrics.length}/{LYRICS_MAX}</p>
            </>
          )}
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section title="Musical">
          <Slider label="Duration" value={s.duration} min={10} max={600} step={5} onValueChange={(v) => set({ duration: v })} format={(v) => formatDuration(v)} />
          <div className="flex gap-3">
            <div className="flex-1">
              <Label hint="30–300">BPM</Label>
              <Input
                type="number" min={30} max={300} placeholder="auto"
                value={s.bpm}
                onChange={(e) => set({ bpm: e.target.value })}
              />
            </div>
            <div className="flex-1">
              <Label>Key / scale</Label>
              <Input value={s.keyscale} placeholder="e.g. C major" onChange={(e) => set({ keyscale: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>Time signature</Label>
            <Select value={s.timesignature} onChange={(e) => set({ timesignature: e.target.value })}>
              <option value="">Auto</option>
              <option value="2">2/4</option>
              <option value="3">3/4</option>
              <option value="4">4/4</option>
              <option value="6">6/8</option>
            </Select>
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section title="Generation">
          <div>
            <Label hint="blank = model default">Inference steps</Label>
            <Input
              type="number" min={1} max={100} placeholder={defaultSteps != null ? String(defaultSteps) : 'default'}
              value={s.inferenceSteps}
              onChange={(e) => set({ inferenceSteps: e.target.value })}
            />
          </div>
          <Slider label="Guidance scale" value={s.guidanceScale} min={0} max={50} step={0.5} onValueChange={(v) => set({ guidanceScale: v })} format={(v) => v.toFixed(1)} />
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label hint="-1 = random">Seed</Label>
              <Input type="number" min={-1} value={s.seed} onChange={(e) => set({ seed: Number(e.target.value) })} />
            </div>
            <Button size="md" variant="secondary" onClick={() => set({ seed: -1 })}>Random</Button>
          </div>
          <Slider label="Variations" value={s.batchSize} min={1} max={4} onValueChange={(v) => set({ batchSize: v })} format={(v) => `${v} track${v === 1 ? '' : 's'}`} />
          <div>
            <Label>Audio format</Label>
            <Select value={s.audioFormat} onChange={(e) => { const v = e.target.value; set({ audioFormat: v === 'flac' || v === 'mp3' ? v : 'wav' }) }}>
              <option value="wav">WAV · lossless</option>
              <option value="flac">FLAC · compressed lossless</option>
              <option value="mp3">MP3 · small</option>
            </Select>
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Button size="lg" variant="primary" className="w-full" icon={<Wand2 size={16} />} onClick={generate}>
          {generateLabel}
        </Button>

        {sessionJobs.length > 0 && (
          <>
            <div className="my-4 h-px bg-line" />
            <Section
              title="Session queue"
              action={queuedCount > 1
                ? <Button size="sm" variant="ghost" icon={<X size={13} />} onClick={() => jobs.cancelQueued({ page: 'music', group: GROUP })}>Cancel queued</Button>
                : <span className="text-[11px] text-ink-faint">{sessionJobs.length}</span>}
            >
              <div className="flex flex-col gap-1.5">
                {sessionJobs.map((j) => {
                  const d = isMusicData(j.data) ? j.data : null
                  const pct = j.progress.fraction != null ? `${Math.round(j.progress.fraction * 100)}%` : null
                  const status = j.state === 'running' ? [j.progress.message, pct].filter(Boolean).join(' · ') || 'running' : j.state
                  return (
                    <div
                      key={j.id}
                      className={clsx(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-2',
                        activeId === j.id ? 'border-accent/50 bg-accent/10' : 'border-line',
                      )}
                    >
                      <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(j.id)}>
                        <div className="truncate text-[12.5px] text-ink">{d?.caption || j.detail || 'untitled'}</div>
                        <div className="flex items-center gap-2 text-[10.5px] text-ink-faint">
                          <span>{d?.model === 'ace-step-quality' ? 'quality' : 'fast'}</span>
                          <span>·</span>
                          <span className={clsx(j.state === 'failed' && 'text-bad', j.state === 'running' && 'text-accent')}>{status}</span>
                          <span>·</span>
                          <span>{formatDuration(d?.duration)}</span>
                        </div>
                      </button>
                      {j.state === 'failed' ? (
                        <>
                          <IconButton title="Retry" onClick={() => retry(j)}><RotateCcw size={13} /></IconButton>
                          <IconButton title="Dismiss" onClick={() => jobs.remove(j.id)}><Trash2 size={13} /></IconButton>
                        </>
                      ) : (
                        <IconButton title={j.state === 'running' ? 'Cancel (stops waiting; the server may finish the song)' : 'Remove from queue'} onClick={() => jobs.cancel(j.id)}>
                          <X size={13} />
                        </IconButton>
                      )}
                    </div>
                  )
                })}
              </div>
            </Section>
          </>
        )}
      </div>

      {/* Results + history */}
      <div className="scroll-area flex-1 p-5">
        <div className="flex flex-col gap-6">
          {view?.type === 'job' ? (
            <MusicJobView job={view.job} onRetry={() => retry(view.job)} />
          ) : view?.type === 'entry' ? (
            <div>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-ink" title={view.entry.caption}>{view.entry.caption || 'Music generation'}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
                    <span>{modelLabel(view.entry.model)}</span>
                    <span>{formatDuration(view.entry.duration)} song</span>
                    {view.entry.elapsed != null && (
                      <span className="flex items-center gap-1"><Clock size={11} /> generated in {formatDuration(view.entry.elapsed)}</span>
                    )}
                    <span>{view.entry.tracks.length} variation{view.entry.tracks.length === 1 ? '' : 's'}</span>
                    {view.entry.tracks.some((t) => t.item.seed != null) && (
                      <span title="Seed per variation (↺ on a row reuses the settings with that seed)">
                        seed {view.entry.tracks.map((t) => t.item.seed ?? '?').join(' / ')}
                      </span>
                    )}
                    {view.entry.tracks[0]?.sampleRate != null && <span>{view.entry.tracks[0].sampleRate / 1000} kHz</span>}
                    <span>{formatBytes(view.entry.tracks.reduce((n, t) => n + t.item.size, 0))}</span>
                    <span>{new Date(view.entry.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => reuse(view.entry)}>Reuse settings</Button>
                  <Button size="sm" icon={<Download size={13} />} onClick={() => downloadEntries([view.entry])}>Download</Button>
                  <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void deleteEntries([view.entry])}>Delete</Button>
                </div>
              </div>
              <ArtifactGrid
                items={view.entry.tracks.map((t) => t.item)}
                onReuse={(item) => reuse(view.entry, item.seed)}
              />
            </div>
          ) : (
            <EmptyState
              icon={<Music2 size={22} />}
              title="No music yet"
              detail="Describe a song (or pick a genre template), add optional lyrics, then hit Generate. Results land here and in your library."
            />
          )}

          <Section
            title="History"
            action={
              history.length > 0 && (
                <div className="flex items-center gap-1.5">
                  {checked.size > 0 && <span className="text-[11px] text-ink-faint">{checked.size} selected</span>}
                  <Button size="sm" variant="ghost" onClick={toggleAll}>{allChecked ? 'Select none' : 'Select all'}</Button>
                  <Button size="sm" variant="ghost" icon={<Download size={13} />} disabled={!checked.size} onClick={() => downloadEntries(checkedEntries)}>Download</Button>
                  <Button size="sm" variant="ghost" icon={<Trash2 size={13} />} disabled={!checked.size} onClick={() => void deleteEntries(checkedEntries)}>Delete</Button>
                </div>
              )
            }
          >
            {history.length === 0 ? (
              <p className="text-[12px] text-ink-faint">No songs generated yet. Finished generations are kept here across reloads.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {history.map((h) => (
                  <div
                    key={h.jobId}
                    className={clsx(
                      'group flex items-center gap-2.5 rounded-lg border px-2.5 py-2',
                      activeId === h.jobId ? 'border-accent/50 bg-accent/10' : checked.has(h.jobId) ? 'border-accent/30' : 'border-line',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      checked={checked.has(h.jobId)}
                      onChange={() => toggleChecked(h.jobId)}
                    />
                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(h.jobId)}>
                      <div className="truncate text-[12.5px] text-ink">{h.caption || 'untitled'}</div>
                      <div className="truncate text-[10.5px] text-ink-faint">
                        {h.model || 'unknown'} · {formatDuration(h.duration)} · {h.tracks.length} track{h.tracks.length === 1 ? '' : 's'}
                        {h.elapsed != null ? ` · ${formatDuration(h.elapsed)} gen time` : ''} · {new Date(h.createdAt).toLocaleString()}
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100">
                      <IconButton title="Reuse settings" onClick={() => reuse(h)}><RotateCcw size={13} /></IconButton>
                      <IconButton title="Download" onClick={() => downloadEntries([h])}><Download size={13} /></IconButton>
                      <IconButton title="Delete" onClick={() => void deleteEntries([h])}><Trash2 size={13} /></IconButton>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
