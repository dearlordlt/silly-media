/** XTTS actor modals: create (file upload or YouTube) and details (clips, add, delete). */
import { useEffect, useState } from 'react'
import { Download, Plus, Trash2, Upload, Youtube } from 'lucide-react'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import type { Actor, ActorAudioFile, TTSLanguageInfo } from '../../lib/types'
import { downloadUrl } from '../../lib/media'
import { useApp } from '../../lib/store'
import { Modal } from '../../components/ui/Modal'
import { Button, IconButton, Input, Label, Segmented, Select, Slider, Spinner, Switch } from '../../components/ui/primitives'
import { AudioDrop, AudioFileList } from './AudioDrop'

const YOUTUBE_PATTERNS = [
  /(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/watch\?(?:.*&)?v=[a-zA-Z0-9_-]{11}/,
  /(?:https?:\/\/)?youtu\.be\/[a-zA-Z0-9_-]{11}/,
  /(?:https?:\/\/)?(?:www\.)?youtube\.com\/shorts\/[a-zA-Z0-9_-]{11}/,
]

export function languageName(languages: TTSLanguageInfo[], code: string): string {
  return languages.find((l) => l.code === code)?.name ?? code
}

type Source = 'upload' | 'youtube'

export function CreateActorModal({ open, onClose, languages, onCreated }: {
  open: boolean
  onClose: () => void
  languages: TTSLanguageInfo[]
  onCreated: (actor: Actor) => void
}) {
  const client = useClient()
  const [source, setSource] = useState<Source>('upload')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState('en')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [url, setUrl] = useState('')
  const [maxDuration, setMaxDuration] = useState(30)
  const [separateVocals, setSeparateVocals] = useState(true)
  const [busy, setBusy] = useState(false)

  // Fresh form every time the modal opens (legacy showCreateActorModal reset).
  useEffect(() => {
    if (!open) return
    setSource('upload')
    setName('')
    setLanguage('en')
    setDescription('')
    setFiles([])
    setUrl('')
    setMaxDuration(30)
    setSeparateVocals(true)
  }, [open])

  const trimmedUrl = url.trim()
  const urlValid = YOUTUBE_PATTERNS.some((p) => p.test(trimmedUrl))

  async function submit() {
    if (!name.trim()) {
      toast.error('Enter an actor name')
      return
    }
    if (source === 'upload' && !files.length) {
      toast.error('Add at least one reference audio file')
      return
    }
    if (source === 'youtube' && !urlValid) {
      toast.error(trimmedUrl ? 'Invalid YouTube URL' : 'Enter a YouTube URL')
      return
    }
    setBusy(true)
    try {
      const created =
        source === 'upload'
          ? await client.createActor(name.trim(), files, language, description.trim())
          : await client.createActorFromYoutube({
              name: name.trim(),
              youtube_url: trimmedUrl,
              language,
              description: description.trim(),
              max_duration: maxDuration,
              separate_vocals: separateVocals,
            })
      toast.success(`Actor "${created.name}" created`)
      onCreated(created)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !busy && onClose()}
      title="New actor"
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {busy && source === 'youtube' ? 'Extracting voice…' : 'Create actor'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div>
          <Label>Actor name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morgan Freeman" autoFocus />
        </div>
        <div>
          <Label>Primary language</Label>
          <Select value={language} onChange={(e) => setLanguage(e.target.value)} className="w-full">
            {languages.map((l) => (
              <option key={l.code} value={l.code}>{l.name}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label hint="optional">Description</Label>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Deep narrator voice" />
        </div>
        <div>
          <Label>Audio source</Label>
          <Segmented<Source>
            value={source}
            onChange={setSource}
            className="w-full"
            options={[
              { value: 'upload', label: <span className="inline-flex items-center gap-1.5"><Upload size={13} /> Upload files</span> },
              { value: 'youtube', label: <span className="inline-flex items-center gap-1.5"><Youtube size={13} /> YouTube URL</span> },
            ]}
          />
        </div>
        {source === 'upload' ? (
          <div className="flex flex-col gap-2">
            <AudioDrop
              title="Drop audio files here or click to browse"
              hint="WAV, MP3, FLAC, OGG — at least 6 seconds recommended"
              onFiles={(added) => setFiles((list) => [...list, ...added])}
            />
            <AudioFileList files={files} onRemove={(i) => setFiles((list) => list.filter((_, j) => j !== i))} />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <Label
                hint={
                  trimmedUrl ? (
                    <span className={urlValid ? 'text-good' : 'text-bad'}>{urlValid ? 'Valid YouTube URL' : 'Invalid YouTube URL'}</span>
                  ) : undefined
                }
              >
                YouTube URL
              </Label>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://youtube.com/watch?v=…" />
            </div>
            <Switch checked={separateVocals} onChange={setSeparateVocals} label="Remove background music (recommended)" />
            <div>
              <Slider label="Max duration" min={10} max={120} step={5} value={maxDuration} onValueChange={setMaxDuration} format={(v) => `${v}s`} />
              <div className="mt-1 text-[11.5px] text-ink-faint">30–60s recommended for best quality. Extraction can take a minute.</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

export function ActorDetailsModal({ actor, languages, onClose, onAudioCountChange, onDeleted, onUse }: {
  actor: Actor | null
  languages: TTSLanguageInfo[]
  onClose: () => void
  onAudioCountChange: (name: string, count: number) => void
  onDeleted: (actor: Actor) => void
  onUse: (actor: Actor) => void
}) {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)
  const [files, setFiles] = useState<ActorAudioFile[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const actorName = actor?.name ?? null

  useEffect(() => {
    setFiles(null)
    setPreview(null)
    if (!actorName) return
    const ctl = new AbortController()
    client
      .actorAudio(actorName, { signal: ctl.signal })
      .then(setFiles)
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) {
          toast.error(errorMessage(e))
          setFiles([])
        }
      })
    return () => ctl.abort()
  }, [client, actorName])

  if (!actor) return null

  async function addAudio(added: File[]) {
    if (!actor) return
    setBusy('add')
    let list = files ?? []
    try {
      for (const f of added) {
        const created = await client.addActorAudio(actor.name, f)
        list = [...list, created]
        setFiles(list)
      }
      toast.success(added.length === 1 ? 'Reference audio added' : `${added.length} clips added`)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      onAudioCountChange(actor.name, list.length)
      setBusy(null)
    }
  }

  async function removeAudio(f: ActorAudioFile) {
    if (!actor) return
    if (confirmDeletes && !window.confirm(`Delete reference audio "${f.original_name ?? f.filename}"? This cannot be undone.`)) return
    setBusy(`del-${f.id}`)
    try {
      await client.deleteActorAudio(actor.name, f.id)
      const list = (files ?? []).filter((x) => x.id !== f.id)
      setFiles(list)
      onAudioCountChange(actor.name, list.length)
      if (preview === f.id) setPreview(null)
      toast.success('Reference audio deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  async function removeActor() {
    if (!actor) return
    if (confirmDeletes && !window.confirm(`Delete actor "${actor.name}"? This cannot be undone.`)) return
    setBusy('actor')
    try {
      await client.deleteActor(actor.name)
      toast.success(`Actor "${actor.name}" deleted`)
      onDeleted(actor)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const totalSeconds = (files ?? []).reduce((s, f) => s + (f.duration_seconds ?? 0), 0)

  return (
    <Modal
      open
      onClose={onClose}
      title={actor.name}
      width="max-w-xl"
      footer={
        <>
          <Button variant="danger" icon={<Trash2 size={14} />} loading={busy === 'actor'} onClick={() => void removeActor()} className="mr-auto">
            Delete actor
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => onUse(actor)}>Use for speech</Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label>Language</Label>
            <div className="text-[13px] text-ink">{languageName(languages, actor.language)}</div>
          </div>
          <div>
            <Label>Created</Label>
            <div className="text-[13px] text-ink">{new Date(actor.created_at).toLocaleString()}</div>
          </div>
        </div>
        <div>
          <Label>Description</Label>
          <div className="text-[13px] text-ink-dim">{actor.description || 'No description'}</div>
        </div>
        <div>
          <Label hint={files ? `${files.length} clip${files.length === 1 ? '' : 's'} · ${totalSeconds.toFixed(1)}s total` : undefined}>Audio files</Label>
          {files === null ? (
            <div className="flex justify-center py-4"><Spinner /></div>
          ) : files.length ? (
            <div className="flex flex-col gap-1.5">
              {files.map((f) => (
                <div key={f.id} className="rounded-lg border border-line bg-panel-2 px-2.5 py-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setPreview((p) => (p === f.id ? null : f.id))}
                      title="Preview clip"
                    >
                      <div className="truncate text-[12px] text-ink">{f.original_name ?? f.filename}</div>
                      <div className="text-[11px] text-ink-faint">
                        {f.duration_seconds != null ? `${f.duration_seconds.toFixed(1)}s` : 'unknown duration'}
                      </div>
                    </button>
                    <IconButton aria-label="Download" onClick={() => downloadUrl(client.actorAudioUrl(actor.name, f.id), f.original_name ?? f.filename)}>
                      <Download size={13} />
                    </IconButton>
                    <IconButton
                      aria-label="Delete audio"
                      disabled={busy === `del-${f.id}`}
                      onClick={() => void removeAudio(f)}
                      className="text-ink-faint hover:text-bad"
                    >
                      <Trash2 size={13} />
                    </IconButton>
                  </div>
                  {preview === f.id && <audio controls autoPlay src={client.actorAudioUrl(actor.name, f.id)} className="mt-1.5 h-8 w-full" />}
                </div>
              ))}
            </div>
          ) : (
            <div className="py-2 text-center text-[12px] text-ink-faint">No audio files</div>
          )}
        </div>
        <div>
          <Label>Add more audio</Label>
          <AudioDrop
            title={busy === 'add' ? 'Uploading…' : 'Add reference audio'}
            hint="Drop or click — multiple files allowed"
            icon={<Plus size={20} />}
            disabled={busy === 'add'}
            onFiles={(added) => void addAudio(added)}
          />
        </div>
      </div>
    </Modal>
  )
}
