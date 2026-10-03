/**
 * Vision page — ask the vision model about an image, then keep asking
 * follow-up questions about the same image. Each thread is saved to the local
 * library (source "vision") so it can be re-opened later.
 *
 * Other pages hand an image over via `handOffImage('vision', blob)` (lib/handoff);
 * it is consumed on mount and analyzed straight away with the full-description
 * preset (the legacy gallery "Vision" button behaviour).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Eye, MessageSquarePlus, RotateCcw, Send, Sparkles, Trash2 } from 'lucide-react'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useLibrary, library } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { blobToDataUrl, stripDataUrl } from '../../lib/media'
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
  Slider,
  Spinner,
  StatusDot,
  Textarea,
} from '../../components/ui/primitives'
import { ImageDrop } from '../../components/ImageDrop'
import { useHandoffImage } from '../../lib/handoff'

/** The comprehensive prompt the legacy ui.html "Vision" button used. */
const FULL_DESCRIPTION = `Describe this image in comprehensive detail. Include:

- The main subject(s) and their appearance
- If there is a person and they appear to be a known public figure, celebrity, or fictional character, identify who they might be
- For each person visible, estimate their age (provide your best guess as a specific number, e.g., "approximately 34 years old")
- Location: identify where this might be (known landmark, city, country, or fictional location from a movie/game/book). If you can't identify a specific place, describe what type of location it appears to be
- Colors, lighting, and atmosphere
- Any text visible in the image
- The overall mood or style
- Notable details that stand out

Be thorough and specific in your description.`

/** Common analysis instructions offered as one-click chips. */
const PRESET_QUERIES: { label: string; query: string }[] = [
  { label: 'Full description', query: FULL_DESCRIPTION },
  { label: 'Describe in detail', query: 'Describe this image in detail' },
  { label: 'Read all text (OCR)', query: 'Read all text (OCR)' },
  { label: 'What is unusual?', query: 'What is unusual here?' },
  { label: 'Camera & lighting', query: 'Estimate the camera angle and lighting' },
  { label: 'Objects & positions', query: 'List the objects and their positions' },
  {
    label: 'Image prompt',
    query: 'Write a detailed text-to-image prompt that would recreate this image: subject, setting, composition, lighting, style and camera. Reply with the prompt only.',
  },
]

/** How many earlier turns are replayed as context for a follow-up. */
const FOLLOWUP_CONTEXT_TURNS = 4

interface Turn {
  query: string
  response: string
  model: string
}

interface Thread {
  /** Library item backing this thread; null until the first save succeeds. */
  itemId: string | null
  image: string
  turns: Turn[]
}

function isTurn(v: unknown): v is Turn {
  return (
    typeof v === 'object' && v !== null &&
    'query' in v && typeof v.query === 'string' &&
    'response' in v && typeof v.response === 'string' &&
    'model' in v && typeof v.model === 'string'
  )
}

/** Read saved turns from a library item's meta (older entries only have query/response/model). */
function readTurns(meta: Record<string, unknown> | undefined): Turn[] {
  if (!meta) return []
  if (Array.isArray(meta.thread)) {
    const turns = meta.thread.filter(isTurn)
    if (turns.length) return turns
  }
  const query = typeof meta.query === 'string' ? meta.query : ''
  const response = typeof meta.response === 'string' ? meta.response : ''
  const model = typeof meta.model === 'string' ? meta.model : ''
  return query || response ? [{ query, response, model }] : []
}

function threadMeta(turns: Turn[]): Record<string, unknown> {
  const first = turns[0]
  return { query: first?.query ?? '', response: first?.response ?? '', model: first?.model ?? '', thread: turns }
}

/** Fold earlier turns into the query: the endpoint is single-shot. */
function followUpQuery(turns: Turn[], question: string): string {
  const recent = turns.slice(-FOLLOWUP_CONTEXT_TURNS)
  const history = recent.map((t) => `Q: ${t.query}\nA: ${t.response}`).join('\n\n')
  return `You already answered questions about this image.\n\n${history}\n\nAnswer this follow-up question about the same image:\n${question}`
}

function threadMarkdown(turns: Turn[]): string {
  return turns.map((t) => `**Q:** ${t.query}\n\n${t.response}`).join('\n\n---\n\n')
}

export function VisionPage() {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)

  const [image, setImage] = useState<string | null>(null)
  const [query, setQuery] = useState(FULL_DESCRIPTION)
  const [maxTokens, setMaxTokens] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [busy, setBusy] = useState(false)
  /** The question currently being answered (rendered as a pending turn). */
  const [pending, setPending] = useState<string | null>(null)
  const [thread, setThread] = useState<Thread | null>(null)
  const [followUp, setFollowUp] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  const images = useLibrary('image')

  const session = useMemo(
    () =>
      images
        .filter((i) => i.source === 'vision')
        .map((item) => ({ item, turns: readTurns(item.meta) })),
    [images],
  )

  const modelsQ = useQuery({
    queryKey: ['vision-models', client.base],
    queryFn: () => client.visionModels(),
    retry: 1,
  })

  const turnCount = thread?.turns.length ?? 0
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [turnCount, pending])

  const ask = async (img: string, question: string, previous: Thread | null) => {
    setBusy(true)
    setPending(question)
    setCopied(null)
    try {
      const parsedTokens = maxTokens.trim() ? Number(maxTokens) : undefined
      const res = await client.vision({
        image: stripDataUrl(img),
        query: previous?.turns.length ? followUpQuery(previous.turns, question) : question,
        max_tokens: parsedTokens !== undefined && Number.isFinite(parsedTokens) ? parsedTokens : undefined,
        temperature,
      })
      const turns = [...(previous?.turns ?? []), { query: question, response: res.response, model: res.model }]
      let itemId = previous?.itemId ?? null
      try {
        if (itemId) {
          await library.update(itemId, { meta: threadMeta(turns) })
        } else {
          const blob = await fetch(img).then((r) => r.blob())
          const item = await library.add({
            kind: 'image',
            source: 'vision',
            blob,
            name: `vision-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
            prompt: question,
            model: res.model,
            meta: threadMeta(turns),
          })
          itemId = item.id
        }
      } catch {
        toast.info('Analysis not saved to library')
      }
      setThread({ itemId, image: img, turns })
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setPending(null)
      setBusy(false)
    }
  }

  /* hand-off from other pages: consume once, analyze immediately */
  useHandoffImage('vision', (handoff) => {
    setImage(handoff)
    setThread(null)
    setQuery(FULL_DESCRIPTION)
    void ask(handoff, FULL_DESCRIPTION, null)
  })

  const onImageChange = (next: string | null) => {
    setImage(next)
    if (next !== thread?.image) setThread(null)
  }

  const analyze = () => {
    if (!image) {
      toast.error('Add an image to analyze')
      return
    }
    if (!query.trim()) {
      toast.error('Enter a query')
      return
    }
    void ask(image, query.trim(), null)
  }

  const sendFollowUp = () => {
    const q = followUp.trim()
    if (!thread || !q || busy) return
    setFollowUp('')
    void ask(thread.image, q, thread)
  }

  const reopen = async (item: MediaItem, turns: Turn[]) => {
    try {
      const dataUrl = await blobToDataUrl(item.blob)
      setImage(dataUrl)
      setQuery(turns[0]?.query ?? '')
      setThread({ itemId: item.id, image: dataUrl, turns })
      setCopied(null)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      toast.success('Copied to clipboard')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const removeEntry = async (item: MediaItem) => {
    if (confirmDeletes && !window.confirm('Delete this analysis?')) return
    try {
      await library.remove(item.id)
      if (thread?.itemId === item.id) setThread(null)
      toast.success('Deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const canAnalyze = Boolean(image) && query.trim().length > 0 && !busy
  const shownImage = thread?.image ?? (pending ? image : null)

  return (
    <div className="flex h-full">
      {/* controls */}
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-5">
          <Section title="Source image">
            <ImageDrop value={image} onChange={onImageChange} label="Drop, paste or click to choose an image" />
          </Section>

          <Section title="Query">
            <Textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (canAnalyze) analyze() }
              }}
              rows={query === FULL_DESCRIPTION ? 8 : 4}
              placeholder="What should the model look for?"
              className="text-[12.5px]"
            />
            <div className="flex flex-wrap gap-1.5">
              {PRESET_QUERIES.map((p) => (
                <Chip key={p.label} active={query.trim() === p.query} onClick={() => setQuery(p.query)} title={p.query}>
                  {p.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section title="Options">
            <div className="flex flex-col gap-3">
              <div>
                <Label hint="optional">Max tokens</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={maxTokens}
                  placeholder="auto"
                  onChange={(e) => setMaxTokens(e.target.value)}
                />
              </div>
              <Slider
                label="Temperature"
                value={temperature}
                min={0}
                max={2}
                step={0.05}
                onValueChange={setTemperature}
                format={(v) => v.toFixed(2)}
              />
            </div>
          </Section>

          <Section title="Model">
            {modelsQ.isLoading ? (
              <div className="text-xs text-ink-faint">Checking…</div>
            ) : modelsQ.isError ? (
              <StatusDot ok={false} label="Vision endpoint unavailable" />
            ) : (
              <div className="flex flex-col gap-2">
                <StatusDot
                  ok={(modelsQ.data?.loaded.length ?? 0) > 0}
                  label={(modelsQ.data?.loaded.length ?? 0) > 0 ? 'Loaded' : 'Not loaded (auto on first run)'}
                />
                <div className="flex flex-wrap gap-1.5">
                  {(modelsQ.data?.available ?? []).length ? (
                    (modelsQ.data?.available ?? []).map((m) => (
                      <span key={m} className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink-dim">
                        {m}
                      </span>
                    ))
                  ) : (
                    <span className="text-xs text-ink-faint">No vision models reported</span>
                  )}
                </div>
              </div>
            )}
          </Section>

          <Button variant="primary" icon={<Sparkles size={15} />} loading={busy} disabled={!canAnalyze} onClick={analyze}>
            {thread ? 'New analysis' : 'Analyze'}
          </Button>
        </div>
      </div>

      {/* results */}
      <div className="flex-1 scroll-area p-5">
        <div className="flex flex-col gap-5">
          {shownImage ? (
            <div className="flex items-start gap-4">
              <Panel className="sticky top-0 w-[320px] shrink-0 overflow-hidden">
                <img src={shownImage} alt="Analyzed image" className="max-h-[480px] w-full object-contain" />
              </Panel>
              <Panel className="flex min-w-0 flex-1 flex-col">
                <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Eye size={15} className="shrink-0 text-accent" />
                    <span className="text-[13px] font-medium text-ink">Vision analysis</span>
                    {turnCount > 1 && <span className="text-[11.5px] text-ink-faint">{turnCount} answers</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {thread?.turns[0]?.model && (
                      <span className="rounded-full border border-line bg-panel-2 px-2 py-0.5 text-[11px] text-ink-dim">
                        {thread.turns[0].model}
                      </span>
                    )}
                    {thread && thread.turns.length > 1 && (
                      <IconButton title="Copy whole thread" onClick={() => void copyText(threadMarkdown(thread.turns))}>
                        {copied === threadMarkdown(thread.turns) ? <Check size={14} className="text-good" /> : <Copy size={14} />}
                      </IconButton>
                    )}
                    {thread && (
                      <IconButton
                        title="Start over on this image"
                        disabled={busy}
                        onClick={() => { setThread(null); setImage(thread.image) }}
                      >
                        <RotateCcw size={14} />
                      </IconButton>
                    )}
                  </div>
                </div>

                <div className="flex flex-col divide-y divide-line">
                  {(thread?.turns ?? []).map((t, i) => (
                    <div key={i} className="group px-4 py-3">
                      <div className="mb-1.5 flex items-start justify-between gap-3">
                        <div className={`text-[12px] text-ink-dim ${i === 0 ? 'line-clamp-2' : ''}`} title={t.query}>
                          <span className="font-semibold text-accent">{i === 0 ? 'Q' : 'Follow-up'}:</span> {t.query}
                        </div>
                        <IconButton
                          className="h-6 w-6 shrink-0"
                          title="Copy answer"
                          onClick={() => void copyText(t.response)}
                        >
                          {copied === t.response ? <Check size={13} className="text-good" /> : <Copy size={13} />}
                        </IconButton>
                      </div>
                      <div className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">{t.response}</div>
                    </div>
                  ))}
                  {pending && (
                    <div className="px-4 py-3">
                      <div className="mb-1.5 line-clamp-2 text-[12px] text-ink-dim" title={pending}>
                        <span className="font-semibold text-accent">{turnCount ? 'Follow-up' : 'Q'}:</span> {pending}
                      </div>
                      <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
                        <Spinner className="h-3.5 w-3.5" /> Analyzing image…
                      </div>
                    </div>
                  )}
                  <div ref={threadEndRef} />
                </div>

                {thread && (
                  <div className="flex items-end gap-2 border-t border-line px-4 py-3">
                    <Textarea
                      rows={2}
                      value={followUp}
                      onChange={(e) => setFollowUp(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFollowUp() }
                      }}
                      disabled={busy}
                      placeholder="Ask a follow-up about this image…  (Enter to send)"
                      className="min-h-[52px] flex-1 text-[13px]"
                    />
                    <Button
                      variant="primary"
                      icon={busy ? undefined : <Send size={13} />}
                      loading={busy}
                      disabled={!followUp.trim()}
                      onClick={sendFollowUp}
                    >
                      Ask
                    </Button>
                  </div>
                )}
              </Panel>
            </div>
          ) : (
            <EmptyState
              icon={<Eye size={26} />}
              title="No analysis yet"
              detail="Drop or paste an image, pick a query and hit Analyze, then ask follow-up questions about it. Threads are saved to your library."
            />
          )}

          <Section
            title="Session"
            action={<span className="text-[11.5px] text-ink-faint">{session.length} saved</span>}
          >
            {session.length ? (
              <div className="grid grid-cols-2 gap-3">
                {session.map(({ item, turns }) => {
                  const first = turns[0]
                  return (
                    <Panel
                      key={item.id}
                      className={`flex gap-3 p-3 ${thread?.itemId === item.id ? 'ring-1 ring-accent' : ''}`}
                    >
                      <button
                        className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-bg"
                        title="Re-open"
                        onClick={() => void reopen(item, turns)}
                      >
                        <img src={item.url} alt="" loading="lazy" className="h-full w-full object-contain" />
                      </button>
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="truncate text-[12.5px] font-medium text-ink" title={first?.query}>
                          {first?.query || 'Untitled query'}
                        </div>
                        <div className="line-clamp-3 text-[12px] leading-snug text-ink-faint">
                          {first?.response}
                        </div>
                        <div className="mt-auto flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] text-ink-faint">
                            {first?.model}
                            {turns.length > 1 && (
                              <span className="inline-flex shrink-0 items-center gap-0.5">
                                <MessageSquarePlus size={11} /> {turns.length - 1}
                              </span>
                            )}
                          </span>
                          <div className="flex shrink-0 items-center gap-1">
                            <IconButton
                              title="Copy response"
                              onClick={() => void copyText(turns.length > 1 ? threadMarkdown(turns) : first?.response ?? '')}
                            >
                              <Copy size={13} />
                            </IconButton>
                            <IconButton title="Delete" onClick={() => void removeEntry(item)}>
                              <Trash2 size={13} />
                            </IconButton>
                          </div>
                        </div>
                      </div>
                    </Panel>
                  )
                })}
              </div>
            ) : (
              <div className="text-xs text-ink-faint">Analyzed images appear here for quick re-opening.</div>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
