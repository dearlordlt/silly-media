import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { Clock, Download, Music2, RotateCcw, Save, Square, Trash2, Wand2 } from 'lucide-react'
import type { JobStatus, MusicAudioResult, MusicGenerateRequest } from '../../lib/types'
import { useClient, useJobPoller, toast, errorMessage } from '../../lib/hooks'
import { library, useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { downloadBlob, extensionFor, formatBytes, formatDuration } from '../../lib/media'
import { useApp } from '../../lib/store'
import {
  Button, Chip, EmptyState, IconButton, Input, Label, Panel, ProgressBar, Section, Segmented, Select, Slider, Spinner, StatusDot, Switch, Textarea,
} from '../../components/ui/primitives'
import {
  BUILTIN_PROFILES, GENRE_TEMPLATES, MUSIC_DEFAULTS, SECTION_TAGS, loadUserProfiles, readSettings, saveUserProfiles,
} from './presets'
import type { MusicSettings, SongModel } from './presets'

type MusicModel = { id: string; name: string; loaded: boolean; default_steps: number; estimated_vram_gb: number }

/** A job submitted this session that has not (yet) produced library tracks. */
interface PendingJob {
  id: string
  caption: string
  model: SongModel
  duration: number
  createdAt: number
  status: 'queued' | 'processing' | 'saving' | 'failed' | 'stopped'
  error: string | null
  settings: MusicSettings
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

const CAPTION_MAX = 512
const LYRICS_MAX = 4096

const TAGS = [
  'pop', 'rock', 'lo-fi', 'synthwave', 'ambient', 'jazz', 'orchestral',
  'hip-hop', 'edm', 'cinematic', 'chill', 'upbeat', 'melancholic', 'epic', 'dreamy',
]

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
  const ext = extensionFor(t.item.blob.type)
  return `music-${entry.jobId.slice(0, 8)}-${t.index + 1}.${ext === 'bin' ? (entry.settings.audioFormat ?? 'wav') : ext}`
}

function modelLabel(model: string): string {
  return model === 'ace-step-quality' ? 'ACE-Step Quality' : model === 'ace-step' ? 'ACE-Step' : model || 'unknown model'
}

export function MusicPage() {
  const client = useClient()
  const confirmDeletes = useApp((st) => st.confirmDeletes)

  const [s, setS] = useState<MusicSettings>(MUSIC_DEFAULTS)
  const [models, setModels] = useState<MusicModel[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [watchingId, setWatchingId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingJob[]>([])
  const [checked, setChecked] = useState<Set<string>>(() => new Set())
  const [activeGenre, setActiveGenre] = useState<string | null>(null)
  const [userProfiles, setUserProfiles] = useState(loadUserProfiles)
  const [profileKey, setProfileKey] = useState('')

  const audioItems = useLibrary('audio')
  const history = useMemo(() => groupHistory(audioItems), [audioItems])

  const set = (patch: Partial<MusicSettings>) => setS((prev) => ({ ...prev, ...patch }))
  const patchPending = (id: string, patch: Partial<PendingJob>) =>
    setPending((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)))

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

  const finishJob = async (id: string, st: JobStatus) => {
    const job = pending.find((j) => j.id === id)
    const audios: MusicAudioResult[] = st.audios ?? []
    if (!audios.length) {
      patchPending(id, { status: 'failed', error: 'The job produced no audio' })
      setWatchingId(null)
      toast.error('Music generation failed', 'The job produced no audio')
      return
    }
    patchPending(id, { status: 'saving' })
    const createdAt = Date.now()
    const elapsed = st.elapsed_seconds ?? null
    const caption = job?.caption ?? s.caption
    let saved = 0
    const failures: string[] = []
    for (const a of audios) {
      try {
        // The status payload's download_url carries the model-internal job id
        // (the router's job id is unrelated), so trust it, not a rebuilt path.
        const url = client.media(a.download_url) ?? client.musicDownloadUrl(id, a.index)
        const res = await fetch(url)
        if (!res.ok) throw new Error(`Variation ${a.index + 1} download failed (${res.status})`)
        const blob = await res.blob()
        await library.add({
          kind: 'audio',
          source: 'music',
          blob,
          name: `${caption.slice(0, 48) || 'music'} · ${a.index + 1}`,
          prompt: caption,
          model: job?.model ?? s.model,
          seed: a.seed,
          durationSeconds: job?.duration ?? s.duration,
          createdAt,
          meta: {
            jobId: id,
            index: a.index,
            sampleRate: a.sample_rate,
            fileJobId: fileJobIdFrom(a.download_url),
            elapsed,
            settings: job?.settings ?? s,
          },
        })
        saved++
      } catch (e) {
        failures.push(errorMessage(e))
      }
    }
    setWatchingId(null)
    if (saved > 0) {
      setPending((prev) => prev.filter((j) => j.id !== id))
      setSelectedId(id)
      toast.success(
        `Music ready (${saved} variation${saved === 1 ? '' : 's'})`,
        elapsed != null ? `Generated in ${formatDuration(elapsed)}` : undefined,
      )
    } else {
      patchPending(id, { status: 'failed', error: failures[0] ?? 'Could not load audio' })
    }
    if (failures.length) toast.error('Could not load audio', failures.join('\n'))
  }

  const poll = useJobPoller<JobStatus>(
    watchingId,
    async (id) => {
      const st = await client.musicStatus(id)
      return { ...st, data: st }
    },
    (st) => {
      const id = watchingId
      if (id && st && st.status === 'completed') void finishJob(id, st)
    },
  )

  // Failures come either from the status payload or from a broken poll (e.g.
  // the server restarted and forgot the job); both land here.
  useEffect(() => {
    if (!watchingId || poll.status !== 'failed') return
    const error = poll.error ?? 'Generation failed'
    patchPending(watchingId, { status: 'failed', error })
    setWatchingId(null)
    toast.error('Music generation failed', error)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.status, poll.error, watchingId])

  useEffect(() => {
    if (!watchingId || (poll.status !== 'queued' && poll.status !== 'processing')) return
    patchPending(watchingId, { status: poll.status })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.status, watchingId])

  const activeId = selectedId ?? watchingId ?? pending[0]?.id ?? history[0]?.jobId ?? null
  const activePending = pending.find((j) => j.id === activeId) ?? null
  const activeEntry = activePending ? null : history.find((h) => h.jobId === activeId) ?? null
  const isActiveWatching = activePending != null && activePending.id === watchingId
  const running = isActiveWatching && (poll.status === 'queued' || poll.status === 'processing')

  const totalSteps = poll.totalSteps ?? 0
  const currentStep = poll.currentStep ?? 0
  const percent = poll.status === 'completed'
    ? 100
    : totalSteps > 0
      ? Math.max(0, Math.min(100, (currentStep / totalSteps) * 100))
      : Math.max(0, Math.min(100, (poll.progress ?? 0) * 100))

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

  const generate = async () => {
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

    setSubmitting(true)
    try {
      const res = await client.music(body)
      setPending((prev) => [
        {
          id: res.job_id, caption, model: s.model, duration: body.duration ?? s.duration,
          createdAt: Date.now(), status: 'queued', error: null, settings: { ...s, caption },
        },
        ...prev,
      ])
      setSelectedId(res.job_id)
      setWatchingId(res.job_id)
      toast.info('Music generation queued', res.estimated_time_seconds ? `Estimated ~${Math.round(res.estimated_time_seconds)}s` : undefined)
    } catch (e) {
      toast.error('Could not start music generation', errorMessage(e))
    } finally {
      setSubmitting(false)
    }
  }

  const stopWatching = () => {
    if (watchingId) patchPending(watchingId, { status: 'stopped' })
    setWatchingId(null)
  }

  const resumeWatching = (job: PendingJob) => {
    setSelectedId(job.id)
    patchPending(job.id, { status: 'queued', error: null })
    setWatchingId(job.id)
  }

  const dismissPending = (job: PendingJob) => {
    if (watchingId === job.id) setWatchingId(null)
    setPending((prev) => prev.filter((j) => j.id !== job.id))
    if (selectedId === job.id) setSelectedId(null)
    // Clears the router's job record (and any files) for failed/abandoned jobs.
    client.deleteMusic(job.id).catch(() => { /* best effort */ })
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
      for (const t of e.tracks) { downloadBlob(t.item.blob, trackFilename(e, t)); count++ }
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
      for (const e of entries) for (const t of e.tracks) await library.remove(t.item.id)
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

        <Section title="Caption / tags" action={<span className="text-[11px] text-ink-faint">{s.caption.length}/{CAPTION_MAX}</span>}>
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

        <Button size="lg" variant="primary" className="w-full" icon={<Wand2 size={16} />} loading={submitting} onClick={() => void generate()}>
          Generate music
        </Button>

        {pending.length > 0 && (
          <>
            <div className="my-4 h-px bg-line" />
            <Section title="Session queue" action={<span className="text-[11px] text-ink-faint">{pending.length}</span>}>
              <div className="flex flex-col gap-1.5">
                {pending.map((j) => {
                  const live = j.status === 'queued' || j.status === 'processing' || j.status === 'saving'
                  return (
                    <div
                      key={j.id}
                      className={clsx(
                        'flex items-center gap-2 rounded-lg border px-2.5 py-2',
                        activeId === j.id ? 'border-accent/50 bg-accent/10' : 'border-line',
                      )}
                    >
                      <button className="min-w-0 flex-1 text-left" onClick={() => setSelectedId(j.id)}>
                        <div className="truncate text-[12.5px] text-ink">{j.caption || 'untitled'}</div>
                        <div className="flex items-center gap-2 text-[10.5px] text-ink-faint">
                          <span>{j.model === 'ace-step-quality' ? 'quality' : 'fast'}</span>
                          <span>·</span>
                          <span className={clsx(j.status === 'failed' && 'text-bad', live && 'text-accent')}>{j.status}</span>
                          <span>·</span>
                          <span>{formatDuration(j.duration)}</span>
                        </div>
                      </button>
                      {j.status === 'stopped' && (
                        <IconButton title="Resume watching" onClick={() => resumeWatching(j)}><RotateCcw size={13} /></IconButton>
                      )}
                      {live && j.status !== 'saving'
                        ? <IconButton title="Stop watching" onClick={() => { if (watchingId === j.id) stopWatching() }}><Square size={13} /></IconButton>
                        : j.status !== 'saving' && <IconButton title="Dismiss" onClick={() => dismissPending(j)}><Trash2 size={13} /></IconButton>}
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
          {activePending ? (
            <div>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-semibold text-ink">{activePending.caption || 'Music generation'}</h2>
                    {(running || activePending.status === 'saving') && <Spinner />}
                  </div>
                  <div className="mt-1 flex items-center gap-3 text-[11.5px] text-ink-faint">
                    <span>{modelLabel(activePending.model)}</span>
                    <span>{formatDuration(activePending.duration)} song</span>
                    <span>{activePending.settings.batchSize} variation{activePending.settings.batchSize === 1 ? '' : 's'}</span>
                  </div>
                </div>
                {running && (
                  <Button variant="danger" size="sm" icon={<Square size={13} />} onClick={stopWatching}>Cancel</Button>
                )}
              </div>

              {running && (
                <div className="rounded-xl border border-accent/30 bg-accent/5 px-3 py-2.5">
                  <div className="mb-1.5 flex items-center justify-between text-[11.5px]">
                    <span className="font-medium text-ink">{poll.status === 'queued' ? 'Queued…' : 'Generating audio'}</span>
                    <span className="flex items-center gap-3 text-ink-dim">
                      <span>Step {currentStep} / {totalSteps || '?'}</span>
                      <span className="flex items-center gap-1"><Clock size={11} /> {Math.round(poll.elapsedSeconds ?? 0)}s elapsed</span>
                      <span>{Math.round(percent)}%</span>
                    </span>
                  </div>
                  <ProgressBar value={percent} />
                </div>
              )}

              {activePending.status === 'saving' && (
                <p className="text-[12.5px] text-ink-dim">Downloading tracks into your library…</p>
              )}

              {activePending.status === 'failed' && (
                <div className="rounded-xl border border-bad/30 bg-bad/10 px-3 py-2.5 text-[12.5px] text-bad">
                  {activePending.error ?? 'Generation failed'}
                </div>
              )}

              {activePending.status === 'stopped' && (
                <EmptyState
                  icon={<Music2 size={22} />}
                  title="Stopped watching"
                  detail="Polling was stopped before the job finished. The server may still be generating."
                  action={<Button size="sm" icon={<RotateCcw size={13} />} onClick={() => resumeWatching(activePending)}>Resume</Button>}
                />
              )}
            </div>
          ) : activeEntry ? (
            <div>
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="truncate text-base font-semibold text-ink" title={activeEntry.caption}>{activeEntry.caption || 'Music generation'}</h2>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-faint">
                    <span>{modelLabel(activeEntry.model)}</span>
                    <span>{formatDuration(activeEntry.duration)} song</span>
                    {activeEntry.elapsed != null && (
                      <span className="flex items-center gap-1"><Clock size={11} /> generated in {formatDuration(activeEntry.elapsed)}</span>
                    )}
                    <span>{activeEntry.tracks.length} variation{activeEntry.tracks.length === 1 ? '' : 's'}</span>
                    <span>{new Date(activeEntry.createdAt).toLocaleString()}</span>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button size="sm" icon={<RotateCcw size={13} />} onClick={() => reuse(activeEntry)}>Reuse settings</Button>
                  <Button size="sm" icon={<Download size={13} />} onClick={() => downloadEntries([activeEntry])}>Download</Button>
                  <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void deleteEntries([activeEntry])}>Delete</Button>
                </div>
              </div>
              <div className="flex flex-col gap-3">
                {activeEntry.tracks.map((t) => (
                  <Panel key={t.item.id} className="p-3">
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 text-[12.5px]">
                        <Music2 size={14} className="text-accent" />
                        <span className="font-medium text-ink">Variation {t.index + 1}</span>
                        <span className="text-ink-faint">
                          {t.item.seed != null ? `· seed ${t.item.seed} ` : ''}
                          {t.sampleRate != null ? `· ${t.sampleRate / 1000} kHz ` : ''}
                          · {formatBytes(t.item.blob.size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {t.item.seed != null && (
                          <IconButton title="Reuse settings with this seed" onClick={() => reuse(activeEntry, t.item.seed)}>
                            <RotateCcw size={14} />
                          </IconButton>
                        )}
                        <IconButton title="Download" onClick={() => downloadBlob(t.item.blob, trackFilename(activeEntry, t))}>
                          <Download size={14} />
                        </IconButton>
                      </div>
                    </div>
                    <audio controls preload="metadata" src={t.item.url} className="w-full" />
                  </Panel>
                ))}
              </div>
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
