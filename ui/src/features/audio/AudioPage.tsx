/** Unified text-to-speech page: XTTS voice cloning, Maya voice design, actors, history. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  History,
  Mic,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  UserRound,
  Volume2,
} from 'lucide-react'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import type { Actor, MayaActor, TTSHistoryEntry, TTSLanguage, TTSLanguageInfo } from '../../lib/types'
import { ArtifactGrid } from '../../components/Artifact'
import { library, useLibrary } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { downloadBlob, formatBytes, formatDuration } from '../../lib/media'
import { useHealth } from '../../lib/query'
import { useApp } from '../../lib/store'
import {
  Button,
  Chip,
  EmptyState,
  IconButton,
  Input,
  Label,
  Panel,
  Section,
  Segmented,
  Select,
  Slider,
  StatusDot,
  Switch,
  Textarea,
} from '../../components/ui/primitives'
import { streamSpeech } from './speech'
import type { StreamStats } from './speech'
import { isBoolean, isNumber, isString, usePersisted } from './persist'
import { AudioDrop, AudioFileList } from './AudioDrop'
import { ActorDetailsModal, CreateActorModal, languageName } from './ActorModals'

type Tab = 'synth' | 'actors' | 'history'
type Engine = 'xtts-v2' | 'maya'
type VoiceSource = 'actor' | 'upload'

const MAX_CHARS = 10_000
const WARN_CHARS = 9_000
const HISTORY_PAGE_SIZE = 10
const HISTORY_FETCH_LIMIT = 200
const MAYA_HISTORY_PREFIX = '[Maya] '

const LANGUAGE_CODES: readonly TTSLanguage[] = ['en', 'es', 'fr', 'de', 'it', 'pt', 'pl', 'tr', 'ru', 'nl', 'cs', 'ar', 'zh-cn', 'ja', 'hu', 'ko', 'hi']
const isLanguage = (v: unknown): v is TTSLanguage => typeof v === 'string' && LANGUAGE_CODES.some((c) => c === v)
const isEngine = (v: unknown): v is Engine => v === 'xtts-v2' || v === 'maya'
const isVoiceSource = (v: unknown): v is VoiceSource => v === 'actor' || v === 'upload'

interface Output {
  url: string
  blob: Blob
  label: string
  text: string
  engine: Engine
  elapsed: number
  streamed: boolean
  firstAudioMs: number | null
}

export function AudioPage() {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)
  const recent = useLibrary('audio').filter((i) => i.source === 'tts')
  const health = useHealth()

  const [tab, setTab] = useState<Tab>('synth')
  const [engine, setEngine] = usePersisted<Engine>('engine', 'xtts-v2', isEngine)
  const [pending, setPending] = useState<string | null>(null)

  const [actors, setActors] = useState<Actor[]>([])
  const [languages, setLanguages] = useState<TTSLanguageInfo[]>([])
  const [mayaActors, setMayaActors] = useState<MayaActor[]>([])
  const [tags, setTags] = useState<string[]>([])
  const [history, setHistory] = useState<TTSHistoryEntry[]>([])

  /* ------------------------------------------------------------ XTTS state */
  const [voiceSource, setVoiceSource] = usePersisted<VoiceSource>('voiceSource', 'actor', isVoiceSource)
  const [actorName, setActorName] = usePersisted('actor', '', isString)
  const [refFiles, setRefFiles] = useState<File[]>([])
  const [text, setText] = usePersisted('text', '', isString)
  const [language, setLanguage] = usePersisted<TTSLanguage>('language', 'en', isLanguage)
  const [temperature, setTemperature] = usePersisted('temperature', 0.65, isNumber)
  const [speed, setSpeed] = usePersisted('speed', 1, isNumber)
  const [splitSentences, setSplitSentences] = usePersisted('splitSentences', true, isBoolean)
  const [streaming, setStreaming] = usePersisted('streaming', false, isBoolean)

  /* ------------------------------------------------------------ Maya state */
  const [voiceDescription, setVoiceDescription] = usePersisted('voiceDescription', '', isString)
  const [mayaText, setMayaText] = usePersisted('mayaText', '', isString)
  const [mayaTemperature, setMayaTemperature] = usePersisted('mayaTemperature', 0.7, isNumber)
  const [mayaSpeed, setMayaSpeed] = usePersisted('mayaSpeed', 1, isNumber)
  const [mayaPresetId, setMayaPresetId] = usePersisted('mayaPreset', '', isString)
  const [mayaName, setMayaName] = useState('')
  const textRef = useRef<HTMLTextAreaElement>(null)

  /* ----------------------------------------------------------- Output state */
  const [output, setOutput] = useState<Output | null>(null)
  const [live, setLive] = useState<StreamStats | null>(null)
  const generationRef = useRef<AbortController | null>(null)
  /** Keeps Web Audio playback of the last streamed result stoppable after the request finished. */
  const playbackRef = useRef<AbortController | null>(null)

  /* ----------------------------------------------------------- Actor state */
  const [actorQuery, setActorQuery] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [detailsName, setDetailsName] = useState<string | null>(null)

  /* --------------------------------------------------------- History state */
  const [historyQuery, setHistoryQuery] = useState('')
  const [historyPage, setHistoryPage] = useState(1)
  const [playing, setPlaying] = useState<Record<string, string>>({})
  const playingRef = useRef(playing)
  playingRef.current = playing

  /* -------------------------------------------------------------- loaders */
  const refreshActors = useCallback(async () => {
    try {
      const r = await client.actors()
      setActors(r.actors)
      setActorName((prev) => (prev && r.actors.some((a) => a.name === prev) ? prev : r.actors[0]?.name ?? ''))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [client, setActorName])

  const refreshLanguages = useCallback(async () => {
    try {
      const r = await client.languages()
      setLanguages(r.languages)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [client])

  const refreshMayaActors = useCallback(async () => {
    try {
      const r = await client.mayaActors()
      setMayaActors(r.actors)
      setMayaPresetId((prev) => (r.actors.some((a) => a.id === prev) ? prev : ''))
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [client, setMayaPresetId])

  const refreshTags = useCallback(async () => {
    try {
      const r = await client.mayaEmotionTags()
      setTags(r.tags)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [client])

  const refreshHistory = useCallback(async () => {
    try {
      const r = await client.ttsHistory(HISTORY_FETCH_LIMIT)
      setHistory(r.entries)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }, [client])

  useEffect(() => {
    void refreshActors()
    void refreshLanguages()
    void refreshMayaActors()
    void refreshTags()
    void refreshHistory()
  }, [refreshActors, refreshLanguages, refreshMayaActors, refreshTags, refreshHistory])

  // Stop any in-flight request / streamed playback when leaving the page.
  useEffect(
    () => () => {
      generationRef.current?.abort()
      playbackRef.current?.abort()
      for (const url of Object.values(playingRef.current)) URL.revokeObjectURL(url)
    },
    [],
  )

  // Release the previous output's object URL whenever it is replaced or the page unmounts.
  useEffect(() => {
    if (!output) return
    return () => URL.revokeObjectURL(output.url)
  }, [output])

  /* -------------------------------------------------------------- derived */
  const isMaya = engine === 'maya'
  const oneShot = !isMaya && voiceSource === 'upload'
  const canStream = !oneShot
  const willStream = streaming && canStream
  const currentText = isMaya ? mayaText : text
  const setCurrentText = isMaya ? setMayaText : setText
  const charCount = currentText.length
  const audioModels = health.data?.available_audio_models ?? []
  const engineUnavailable = !!health.data && !audioModels.includes(engine)
  const selectedPreset = mayaActors.find((a) => a.id === mayaPresetId) ?? null
  const detailsActor = actors.find((a) => a.name === detailsName) ?? null

  const filteredActors = useMemo(() => {
    const q = actorQuery.trim().toLowerCase()
    if (!q) return actors
    return actors.filter((a) => a.name.toLowerCase().includes(q) || (a.description ?? '').toLowerCase().includes(q))
  }, [actors, actorQuery])

  const filteredHistory = useMemo(() => {
    const q = historyQuery.trim().toLowerCase()
    if (!q) return history
    return history.filter((h) => h.text.toLowerCase().includes(q) || h.actor_name.toLowerCase().includes(q))
  }, [history, historyQuery])
  const historyPages = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE))
  const page = Math.min(historyPage, historyPages)
  const pageItems = filteredHistory.slice((page - 1) * HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE)

  /* ------------------------------------------------------------ generation */
  async function generate() {
    const body = currentText.trim()
    if (!isMaya && voiceSource === 'actor' && !actorName) return void toast.error('Select an actor first')
    if (oneShot && !refFiles.length) return void toast.error('Add at least one reference audio clip')
    if (isMaya && !voiceDescription.trim()) return void toast.error('Describe the voice first')
    if (!body) return void toast.error('Enter some text to speak')
    if (body.length > MAX_CHARS) return void toast.error(`Text is too long (max ${MAX_CHARS.toLocaleString()} characters)`)

    playbackRef.current?.abort()
    playbackRef.current = null
    const ctl = new AbortController()
    generationRef.current = ctl
    setPending('generate')
    const started = performance.now()
    try {
      let blob: Blob
      let firstAudioMs: number | null = null
      const description = voiceDescription.trim()
      if (willStream) {
        setLive({ chunks: 0, firstAudioMs: null, seconds: 0 })
        const r = await streamSpeech(
          client,
          isMaya
            ? { engine: 'maya', body: { text: body, voice_description: description, temperature: mayaTemperature, speed: mayaSpeed } }
            : { engine: 'xtts-v2', body: { text: body, actor: actorName, language, temperature, speed, split_sentences: false } },
          { signal: ctl.signal, onProgress: setLive },
        )
        blob = r.blob
        firstAudioMs = r.firstAudioMs
        playbackRef.current = ctl
      } else if (isMaya) {
        blob = await client.mayaTts({ text: body, voice_description: description, temperature: mayaTemperature, speed: mayaSpeed }, ctl.signal)
      } else if (oneShot) {
        blob = await client.generateWithAudio({ text: body, language, files: refFiles, temperature, speed, splitSentences }, ctl.signal)
      } else {
        blob = await client.tts({ text: body, actor: actorName, language, temperature, speed, split_sentences: splitSentences }, ctl.signal)
      }
      const elapsed = (performance.now() - started) / 1000
      const label = isMaya
        ? `Maya: ${selectedPreset ? selectedPreset.name : description.slice(0, 48)}`
        : oneShot
          ? `Uploaded voice (${refFiles.length} clip${refFiles.length === 1 ? '' : 's'})`
          : actorName
      await library.add({
        kind: 'audio',
        source: 'tts',
        blob,
        name: `${label} · ${new Date().toLocaleTimeString()}`,
        prompt: body,
        model: engine,
        meta: isMaya
          ? { text: body, voice_description: description, streamed: willStream }
          : { text: body, language, actor: oneShot ? null : actorName, streamed: willStream },
      })
      setOutput({ url: URL.createObjectURL(blob), blob, label, text: body, engine, elapsed, streamed: willStream, firstAudioMs })
      // Only the batch actor/Maya endpoints record server-side history.
      if (!willStream && !oneShot) void refreshHistory()
      toast.success(`${willStream ? 'Streamed' : 'Generated'} in ${elapsed.toFixed(1)}s`)
    } catch (e) {
      if (ctl.signal.aborted) toast.info('Generation stopped')
      else toast.error(errorMessage(e))
    } finally {
      if (generationRef.current === ctl) generationRef.current = null
      setPending(null)
      setLive(null)
    }
  }

  function copyOutputInfo() {
    if (!output) return
    const info = [
      `Text: ${output.text}`,
      `${output.engine === 'maya' ? 'Voice' : 'Actor'}: ${output.label}`,
      `Engine: ${output.engine}`,
      `Generated: ${new Date().toISOString()}`,
    ].join('\n')
    navigator.clipboard.writeText(info).then(
      () => toast.success('Info copied'),
      (e: unknown) => toast.error(errorMessage(e)),
    )
  }

  function insertTag(tag: string) {
    const el = textRef.current
    const start = el?.selectionStart ?? mayaText.length
    const end = el?.selectionEnd ?? start
    const before = mayaText.slice(0, start)
    const after = mayaText.slice(end)
    const spaceBefore = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
    const spaceAfter = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
    setMayaText(before + spaceBefore + tag + spaceAfter + after)
    const pos = start + spaceBefore.length + tag.length + spaceAfter.length
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(pos, pos)
    })
  }

  /* --------------------------------------------------------- maya actors */
  function selectPreset(id: string) {
    setMayaPresetId(id)
    const preset = mayaActors.find((a) => a.id === id)
    if (preset) {
      setVoiceDescription(preset.voice_description)
      setMayaName(preset.name)
    } else {
      setMayaName('')
    }
  }

  async function savePreset(mode: 'create' | 'update') {
    const name = mayaName.trim()
    const description = voiceDescription.trim()
    if (!description) return void toast.error('Enter a voice description first')
    if (mode === 'create' && !name) return void toast.error('Enter a name for the preset')
    setPending('maya-actor')
    try {
      if (mode === 'update' && selectedPreset) {
        const updated = await client.updateMayaActor(selectedPreset.id, { name: name || undefined, voice_description: description })
        setMayaActors((list) => list.map((a) => (a.id === updated.id ? updated : a)))
        setMayaName(updated.name)
        toast.success(`Preset "${updated.name}" updated`)
      } else {
        const created = await client.createMayaActor(name, description)
        setMayaActors((list) => [created, ...list])
        setMayaPresetId(created.id)
        toast.success(`Preset "${created.name}" saved`)
      }
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  async function removePreset(a: MayaActor) {
    if (confirmDeletes && !window.confirm(`Delete voice preset "${a.name}"?`)) return
    setPending(`maya-del-${a.id}`)
    try {
      await client.deleteMayaActor(a.id)
      setMayaActors((list) => list.filter((x) => x.id !== a.id))
      if (mayaPresetId === a.id) {
        setMayaPresetId('')
        setMayaName('')
      }
      toast.success(`Preset "${a.name}" deleted`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  /* ------------------------------------------------------------- actors */
  function pickActor(a: Actor) {
    setActorName(a.name)
    setVoiceSource('actor')
    setEngine('xtts-v2')
    setDetailsName(null)
    setTab('synth')
  }

  /* ------------------------------------------------------------- history */
  async function playHistoryEntry(entry: TTSHistoryEntry) {
    if (playing[entry.id]) {
      URL.revokeObjectURL(playing[entry.id])
      setPlaying((m) => {
        const next = { ...m }
        delete next[entry.id]
        return next
      })
      return
    }
    setPending(`hist-${entry.id}`)
    try {
      const blob = await client.ttsHistoryAudio(entry.id)
      const url = URL.createObjectURL(blob)
      setPlaying((m) => ({ ...m, [entry.id]: url }))
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  async function downloadHistoryEntry(entry: TTSHistoryEntry) {
    setPending(`hist-dl-${entry.id}`)
    try {
      const blob = await client.ttsHistoryAudio(entry.id)
      downloadBlob(blob, `tts_${entry.id}.wav`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  function reuseHistoryEntry(entry: TTSHistoryEntry) {
    if (entry.actor_name.startsWith(MAYA_HISTORY_PREFIX)) {
      // Backend stores "[Maya] " + description, truncated to 50 chars + "...".
      const stored = entry.actor_name.slice(MAYA_HISTORY_PREFIX.length)
      const truncated = stored.length === 53 && stored.endsWith('...')
      const prefix = truncated ? stored.slice(0, 50) : stored
      const preset = mayaActors.find((a) => (truncated ? a.voice_description.startsWith(prefix) : a.voice_description === stored))
      setEngine('maya')
      setMayaText(entry.text)
      if (preset) {
        setMayaPresetId(preset.id)
        setMayaName(preset.name)
        setVoiceDescription(preset.voice_description)
      } else if (!truncated) {
        setMayaPresetId('')
        setVoiceDescription(stored)
      }
    } else {
      setEngine('xtts-v2')
      setText(entry.text)
      if (actors.some((a) => a.name === entry.actor_name)) {
        setActorName(entry.actor_name)
        setVoiceSource('actor')
      }
      if (isLanguage(entry.language)) setLanguage(entry.language)
    }
    setTab('synth')
  }

  function reuseLibraryItem(item: MediaItem) {
    const prompt = item.prompt ?? ''
    if (item.model === 'maya') {
      setEngine('maya')
      setMayaText(prompt)
      const desc = item.meta && 'voice_description' in item.meta ? item.meta.voice_description : undefined
      if (typeof desc === 'string') {
        setVoiceDescription(desc)
        setMayaPresetId(mayaActors.find((a) => a.voice_description === desc)?.id ?? '')
      }
    } else {
      setEngine('xtts-v2')
      setText(prompt)
      const lang = item.meta && 'language' in item.meta ? item.meta.language : undefined
      if (isLanguage(lang)) setLanguage(lang)
      const actor = item.meta && 'actor' in item.meta ? item.meta.actor : undefined
      if (typeof actor === 'string' && actors.some((a) => a.name === actor)) {
        setActorName(actor)
        setVoiceSource('actor')
      }
    }
    setTab('synth')
  }

  async function removeLibraryItem(item: MediaItem) {
    if (confirmDeletes && !window.confirm(`Delete "${item.name}" from the library?`)) return
    try {
      await library.remove(item.id)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  async function removeHistoryEntry(entry: TTSHistoryEntry) {
    if (confirmDeletes && !window.confirm('Delete this history entry?')) return
    setPending(`hist-del-${entry.id}`)
    try {
      await client.deleteTtsHistoryEntry(entry.id)
      setHistory((list) => list.filter((x) => x.id !== entry.id))
      toast.success('Entry deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  async function clearHistory() {
    if (confirmDeletes && !window.confirm('Clear the entire TTS history?')) return
    setPending('hist-clear')
    try {
      await client.clearTtsHistory()
      setHistory([])
      toast.success('History cleared')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
    }
  }

  /* ---------------------------------------------------------------- render */
  const availableEngines = [audioModels.includes('xtts-v2') ? 'XTTS' : null, audioModels.includes('maya') ? 'Maya' : null].filter((m) => m !== null)
  const statusLabel = health.isError
    ? 'Disconnected'
    : !health.data
      ? 'Connecting…'
      : availableEngines.length
        ? `${availableEngines.join(' + ')} available`
        : 'Connected'

  return (
    <div className="flex h-full">
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-5">
          <div className="flex items-center justify-between">
            <StatusDot ok={!!health.data && !health.isError} label={statusLabel} />
            {pending === 'generate' && <span className="text-[11.5px] text-accent-2">Generating…</span>}
          </div>
          <Segmented<Tab>
            value={tab}
            onChange={setTab}
            className="w-full"
            options={[
              { value: 'synth', label: 'Speech' },
              { value: 'actors', label: `Actors (${actors.length})` },
              { value: 'history', label: 'History' },
            ]}
          />

          {tab === 'synth' && (
            <>
              <Segmented<Engine>
                value={engine}
                onChange={setEngine}
                className="w-full"
                options={[
                  { value: 'xtts-v2', label: 'XTTS v2 · cloning' },
                  { value: 'maya', label: 'Maya · description' },
                ]}
              />
              {engineUnavailable && (
                <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
                  {isMaya ? 'Maya' : 'XTTS v2'} is not reported as available by the backend.
                </div>
              )}

              {!isMaya ? (
                <Section title={<span className="flex items-center gap-2"><Mic size={14} /> Voice</span>}>
                  <Segmented<VoiceSource>
                    value={voiceSource}
                    onChange={setVoiceSource}
                    className="w-full"
                    options={[
                      { value: 'actor', label: 'Saved actor' },
                      { value: 'upload', label: 'Quick test (upload)' },
                    ]}
                  />
                  {voiceSource === 'actor' ? (
                    <div>
                      <Label hint={`${actors.length} available`}>Voice actor</Label>
                      <Select value={actorName} onChange={(e) => setActorName(e.target.value)} className="w-full">
                        <option value="">Select an actor…</option>
                        {actors.map((a) => (
                          <option key={a.id} value={a.name}>
                            {a.name} ({a.audio_count} clip{a.audio_count === 1 ? '' : 's'})
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2">
                      <AudioDrop
                        title="Drop reference clips or click to browse"
                        hint="One-shot clone — nothing is saved as an actor"
                        onFiles={(added) => setRefFiles((list) => [...list, ...added])}
                      />
                      <AudioFileList files={refFiles} onRemove={(i) => setRefFiles((list) => list.filter((_, j) => j !== i))} />
                    </div>
                  )}
                </Section>
              ) : (
                <Section title={<span className="flex items-center gap-2"><Sparkles size={14} /> Voice design</span>}>
                  <div>
                    <Label hint={`${mayaActors.length} saved`}>Voice preset</Label>
                    <div className="flex items-center gap-1.5">
                      <Select value={mayaPresetId} onChange={(e) => selectPreset(e.target.value)} className="min-w-0 flex-1">
                        <option value="">Custom voice</option>
                        {mayaActors.map((a) => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </Select>
                      {selectedPreset && (
                        <IconButton
                          aria-label={`Delete preset ${selectedPreset.name}`}
                          title="Delete preset"
                          disabled={pending === `maya-del-${selectedPreset.id}`}
                          onClick={() => void removePreset(selectedPreset)}
                          className="text-ink-faint hover:text-bad"
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      )}
                    </div>
                  </div>
                  <div>
                    <Label hint={`${voiceDescription.length}/500`}>Voice description</Label>
                    <Textarea
                      rows={3}
                      maxLength={500}
                      value={voiceDescription}
                      onChange={(e) => setVoiceDescription(e.target.value)}
                      placeholder="A young woman with a warm, friendly tone — or an elderly British gentleman with a deep, authoritative voice…"
                    />
                    <div className="mt-1 text-[11.5px] text-ink-faint">Age, gender, tone, accent, emotion.</div>
                  </div>
                  <Panel className="flex flex-col gap-2 p-3">
                    <Input value={mayaName} onChange={(e) => setMayaName(e.target.value)} placeholder="Preset name" />
                    <div className="flex items-center gap-2">
                      <Button size="sm" icon={<Save size={13} />} loading={pending === 'maya-actor'} onClick={() => void savePreset('create')}>
                        Save as new
                      </Button>
                      {selectedPreset && (
                        <Button size="sm" variant="ghost" icon={<Pencil size={13} />} disabled={pending === 'maya-actor'} onClick={() => void savePreset('update')}>
                          Update “{selectedPreset.name}”
                        </Button>
                      )}
                    </div>
                  </Panel>
                </Section>
              )}

              <Section title="Text">
                <div>
                  <Label
                    hint={
                      <span className={charCount > MAX_CHARS ? 'text-bad' : charCount > WARN_CHARS ? 'text-warn' : undefined}>
                        {charCount.toLocaleString()} / {MAX_CHARS.toLocaleString()}
                      </span>
                    }
                  >
                    Text to speak
                  </Label>
                  <textarea
                    ref={textRef}
                    rows={7}
                    className="field resize-y leading-relaxed"
                    value={currentText}
                    onChange={(e) => setCurrentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && pending !== 'generate') {
                        e.preventDefault()
                        void generate()
                      }
                    }}
                    placeholder="Enter the text you want to convert to speech…  (Ctrl+Enter to generate)"
                  />
                </div>
                {isMaya && (
                  <div>
                    <Label hint="click to insert at cursor">Emotion tags</Label>
                    {tags.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {tags.map((t) => (
                          <Chip key={t} onClick={() => insertTag(t)} title={`Insert ${t}`}>
                            {t}
                          </Chip>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[12px] text-ink-faint">No emotion tags available.</div>
                    )}
                  </div>
                )}
                {!isMaya && (
                  <div>
                    <Label>Language</Label>
                    <Select value={language} onChange={(e) => isLanguage(e.target.value) && setLanguage(e.target.value)} className="w-full">
                      {languages.map((l) => (
                        <option key={l.code} value={l.code}>{l.name}</option>
                      ))}
                    </Select>
                  </div>
                )}
              </Section>

              <Section title="Settings">
                {isMaya ? (
                  <>
                    <Slider label="Speed" min={0.5} max={2} step={0.1} value={mayaSpeed} onValueChange={setMayaSpeed} format={(v) => `${v.toFixed(1)}×`} />
                    <Slider label="Temperature" min={0} max={1} step={0.05} value={mayaTemperature} onValueChange={setMayaTemperature} format={(v) => v.toFixed(2)} />
                  </>
                ) : (
                  <>
                    <Slider label="Speed" min={0.5} max={2} step={0.1} value={speed} onValueChange={setSpeed} format={(v) => `${v.toFixed(1)}×`} />
                    <Slider label="Temperature" min={0} max={1} step={0.05} value={temperature} onValueChange={setTemperature} format={(v) => v.toFixed(2)} />
                    <div className={willStream ? 'pointer-events-none opacity-50' : undefined}>
                      <Switch checked={splitSentences && !willStream} onChange={setSplitSentences} label="Split into sentences" />
                    </div>
                  </>
                )}
                <div className={canStream ? undefined : 'pointer-events-none opacity-50'}>
                  <Switch checked={willStream} onChange={setStreaming} label="Stream (play while generating)" />
                </div>
                {!canStream && <div className="-mt-1 text-[11.5px] text-ink-faint">Streaming needs a saved actor.</div>}
                {willStream && <div className="-mt-1 text-[11.5px] text-ink-faint">Streamed speech is not recorded in server history.</div>}
              </Section>

              {pending === 'generate' ? (
                <Button variant="danger" icon={<Square size={13} />} onClick={() => generationRef.current?.abort()}>
                  Stop {live ? `· ${live.seconds.toFixed(1)}s received` : '· generating…'}
                </Button>
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  disabled={!currentText.trim() || charCount > MAX_CHARS}
                  onClick={() => void generate()}
                >
                  {willStream ? 'Stream speech' : 'Generate speech'}
                </Button>
              )}
            </>
          )}

          {tab === 'actors' && (
            <Section
              title={<span className="flex items-center gap-2"><UserRound size={14} /> Actor library</span>}
              action={<IconButton onClick={() => void refreshActors()} aria-label="Refresh"><RefreshCw size={14} /></IconButton>}
            >
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
                Create new actor
              </Button>
              <div className="text-[12px] text-ink-faint">
                Actors store reference clips used by XTTS voice cloning. Upload files or extract a voice from a YouTube video.
              </div>
            </Section>
          )}

          {tab === 'history' && (
            <Section
              title={<span className="flex items-center gap-2"><History size={14} /> History</span>}
              action={<IconButton onClick={() => void refreshHistory()} aria-label="Refresh"><RefreshCw size={14} /></IconButton>}
            >
              <Button variant="danger" icon={<Trash2 size={14} />} loading={pending === 'hist-clear'} disabled={!history.length} onClick={() => void clearHistory()}>
                Clear all
              </Button>
              <div className="text-[12px] text-ink-faint">
                {history.length} entr{history.length === 1 ? 'y' : 'ies'} stored on the server (latest {HISTORY_FETCH_LIMIT}).
              </div>
            </Section>
          )}
        </div>
      </div>

      <div className="flex-1 scroll-area p-5">
        {tab === 'synth' && (
          <div className="flex flex-col gap-6">
            <Section title={<span className="flex items-center gap-2"><Volume2 size={14} /> Generated audio</span>}>
              {live && (
                <Panel className="flex items-center gap-3 p-4">
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-2 opacity-75" />
                    <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent-2" />
                  </span>
                  <div className="text-[12.5px] text-ink-dim">
                    {live.chunks
                      ? `Playing live · ${live.chunks} chunk${live.chunks === 1 ? '' : 's'} · ${live.seconds.toFixed(1)}s of audio · first audio after ${((live.firstAudioMs ?? 0) / 1000).toFixed(1)}s`
                      : 'Waiting for first audio…'}
                  </div>
                </Panel>
              )}
              {output ? (
                <Panel className="p-4">
                  <audio
                    key={output.url}
                    controls
                    autoPlay={!output.streamed}
                    src={output.url}
                    className="w-full"
                    onPlay={() => {
                      playbackRef.current?.abort()
                      playbackRef.current = null
                    }}
                  />
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-dim">
                    <span>{output.engine === 'maya' ? 'Voice' : 'Actor'}: {output.label}</span>
                    <span>Size: {formatBytes(output.blob.size)}</span>
                    <span>{output.streamed ? 'Streamed' : 'Generated'} in {output.elapsed.toFixed(1)}s</span>
                    {output.firstAudioMs !== null && <span>First audio: {(output.firstAudioMs / 1000).toFixed(1)}s</span>}
                  </div>
                  <div className="mt-1 line-clamp-2 text-[12px] text-ink-faint" title={output.text}>{output.text}</div>
                  <div className="mt-3 flex gap-2">
                    <Button size="sm" icon={<Download size={13} />} onClick={() => downloadBlob(output.blob, `tts_${Date.now()}.wav`)}>
                      Download WAV
                    </Button>
                    <Button size="sm" variant="ghost" icon={<ClipboardCopy size={13} />} onClick={copyOutputInfo}>
                      Copy info
                    </Button>
                  </div>
                </Panel>
              ) : (
                !live && (
                  <EmptyState
                    icon={isMaya ? <Sparkles size={20} /> : <Mic size={20} />}
                    title="Generated audio will appear here"
                    detail={isMaya ? 'Describe a voice, enter text and generate.' : 'Pick an actor (or upload clips), enter text and generate.'}
                  />
                )
              )}
            </Section>

            {isMaya && (
              <Section title="Saved voice presets">
                {mayaActors.length ? (
                  <div className="flex flex-col gap-2">
                    {mayaActors.map((a) => (
                      <Panel key={a.id} className={`flex items-start justify-between gap-3 p-3 ${a.id === mayaPresetId ? 'ring-1 ring-accent/60' : ''}`}>
                        <div className="min-w-0">
                          <div className="truncate text-[13px] font-medium text-ink">{a.name}</div>
                          <div className="line-clamp-2 text-[12px] text-ink-dim">{a.voice_description}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button size="sm" variant="ghost" onClick={() => selectPreset(a.id)}>Use</Button>
                          <IconButton
                            aria-label={`Delete ${a.name}`}
                            disabled={pending === `maya-del-${a.id}`}
                            onClick={() => void removePreset(a)}
                            className="text-ink-faint hover:text-bad"
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </Panel>
                    ))}
                  </div>
                ) : (
                  <EmptyState icon={<Sparkles size={20} />} title="No saved voices" detail="Describe a voice, name it and save it as a preset." />
                )}
              </Section>
            )}

            <Section title="Recent speech">
              <ArtifactGrid
                items={recent}
                columns={3}
                onReuse={reuseLibraryItem}
                onDelete={(item) => void removeLibraryItem(item)}
                empty={{ title: 'Nothing generated yet', detail: 'Generated speech is stored in your library.' }}
              />
            </Section>
          </div>
        )}

        {tab === 'actors' && (
          <Section
            title={<span className="flex items-center gap-2"><UserRound size={14} /> Your actors</span>}
            action={
              <span className="text-[12px] text-ink-faint">
                {actorQuery.trim() && filteredActors.length !== actors.length
                  ? `${filteredActors.length} of ${actors.length}`
                  : `${actors.length} actor${actors.length === 1 ? '' : 's'}`}
              </span>
            }
          >
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
              <Input value={actorQuery} onChange={(e) => setActorQuery(e.target.value)} placeholder="Search actors…" className="w-full pl-8" />
            </div>
            {!actors.length ? (
              <EmptyState
                icon={<UserRound size={20} />}
                title="No actors yet"
                detail="Create one from reference audio or a YouTube video."
                action={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>Create new actor</Button>}
              />
            ) : !filteredActors.length ? (
              <EmptyState icon={<Search size={20} />} title="No matching actors" />
            ) : (
              <div className="flex flex-col gap-2">
                {filteredActors.map((a) => (
                  <Panel key={a.id} className={`flex items-center gap-3 p-3 ${a.name === actorName ? 'ring-1 ring-accent/60' : ''}`}>
                    <button type="button" onClick={() => setDetailsName(a.name)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-accent to-accent-2 text-[14px] font-semibold text-white">
                        {a.name.charAt(0).toUpperCase()}
                      </span>
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-ink">{a.name}</div>
                        <div className="truncate text-[11.5px] text-ink-faint">
                          {languageName(languages, a.language)} · {a.audio_count} clip{a.audio_count === 1 ? '' : 's'}
                          {a.description ? ` · ${a.description}` : ''}
                        </div>
                      </div>
                    </button>
                    <Button size="sm" variant="ghost" onClick={() => setDetailsName(a.name)}>Details</Button>
                    <Button size="sm" onClick={() => pickActor(a)}>Use</Button>
                  </Panel>
                ))}
              </div>
            )}
          </Section>
        )}

        {tab === 'history' && (
          <Section
            title={<span className="flex items-center gap-2"><History size={14} /> TTS history</span>}
            action={
              <span className="text-[12px] text-ink-faint">
                {historyQuery.trim() && filteredHistory.length !== history.length
                  ? `${filteredHistory.length} of ${history.length} entries`
                  : `${history.length} entries`}
              </span>
            }
          >
            <div className="relative">
              <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
              <Input
                value={historyQuery}
                onChange={(e) => {
                  setHistoryQuery(e.target.value)
                  setHistoryPage(1)
                }}
                placeholder="Search text or voice…"
                className="w-full pl-8"
              />
            </div>
            {pageItems.length ? (
              <>
                <div className="flex flex-col gap-2">
                  {pageItems.map((h) => (
                    <Panel key={h.id} className="p-3">
                      <div className="flex items-start gap-3">
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Play size={13} />}
                          loading={pending === `hist-${h.id}`}
                          onClick={() => void playHistoryEntry(h)}
                        >
                          {playing[h.id] ? 'Hide' : 'Play'}
                        </Button>
                        <div className="min-w-0 flex-1">
                          <div className="line-clamp-2 text-[13px] text-ink" title={h.text}>{h.text}</div>
                          <div className="mt-0.5 truncate text-[11px] text-ink-faint">
                            {h.actor_name} · {languageName(languages, h.language)} · {formatDuration(h.duration_seconds)} · {new Date(h.created_at).toLocaleString()}
                          </div>
                          {playing[h.id] && <audio controls autoPlay src={playing[h.id]} className="mt-2 w-full" />}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <IconButton aria-label="Reuse text" title="Reuse text & voice" onClick={() => reuseHistoryEntry(h)}>
                            <RotateCcw size={14} />
                          </IconButton>
                          <IconButton
                            aria-label="Download"
                            title="Download WAV"
                            disabled={pending === `hist-dl-${h.id}`}
                            onClick={() => void downloadHistoryEntry(h)}
                          >
                            <Download size={14} />
                          </IconButton>
                          <IconButton
                            aria-label="Delete entry"
                            title="Delete"
                            disabled={pending === `hist-del-${h.id}`}
                            onClick={() => void removeHistoryEntry(h)}
                            className="text-ink-faint hover:text-bad"
                          >
                            <Trash2 size={14} />
                          </IconButton>
                        </div>
                      </div>
                    </Panel>
                  ))}
                </div>
                {historyPages > 1 && (
                  <div className="flex items-center justify-center gap-3">
                    <Button size="sm" icon={<ChevronLeft size={13} />} disabled={page <= 1} onClick={() => setHistoryPage(page - 1)}>
                      Prev
                    </Button>
                    <span className="text-[12px] text-ink-dim">Page {page} of {historyPages}</span>
                    <Button size="sm" disabled={page >= historyPages} onClick={() => setHistoryPage(page + 1)}>
                      Next <ChevronRight size={13} />
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <EmptyState
                icon={<History size={20} />}
                title={historyQuery.trim() ? 'No matching entries' : 'No history yet'}
                detail={historyQuery.trim() ? undefined : 'Speech generated with saved actors or Maya is recorded here.'}
              />
            )}
          </Section>
        )}
      </div>

      <CreateActorModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        languages={languages}
        onCreated={(created) => {
          setActors((list) => [created, ...list.filter((a) => a.id !== created.id)])
          setCreateOpen(false)
          pickActor(created)
        }}
      />

      <ActorDetailsModal
        actor={detailsActor}
        languages={languages}
        onClose={() => setDetailsName(null)}
        onAudioCountChange={(name, count) => setActors((list) => list.map((a) => (a.name === name ? { ...a, audio_count: count } : a)))}
        onDeleted={(deleted) => {
          setActors((list) => list.filter((a) => a.id !== deleted.id))
          setActorName((prev) => (prev === deleted.name ? '' : prev))
          setDetailsName(null)
        }}
        onUse={pickActor}
      />
    </div>
  )
}
