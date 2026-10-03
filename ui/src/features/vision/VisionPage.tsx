/**
 * Vision page — ask the vision model about an image, then keep asking
 * follow-up questions about the same image. Each thread is saved to the local
 * library (source "vision") so it can be re-opened later.
 *
 * Questions run on the app-wide GPU queue; the page renders the job it is
 * viewing (pending question, answer) so leaving and returning keeps it.
 *
 * Other pages hand an image over via `handOffImage('vision', blob)` (lib/handoff);
 * it is consumed on mount and analyzed straight away with the full-description
 * preset (the legacy gallery "Vision" button behaviour).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Copy, Eye, MessageSquarePlus, RotateCcw, Send, Sparkles, Trash2 } from 'lucide-react'
import type { SillyClient } from '../../lib/api'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { itemBlob, useLibrary, library } from '../../lib/library'
import type { MediaItem } from '../../lib/library'
import { blobToDataUrl, stripDataUrl } from '../../lib/media'
import { useApp } from '../../lib/store'
import { jobs, useJob, usePageJobs } from '../../lib/jobs'
import type { JobContext } from '../../lib/jobs'
import { useCommands, usePrimaryAction } from '../../lib/commands'
import { JobStrip } from '../../components/Progress'
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

/** Job payload: the question being asked, and (once answered) the resulting thread. */
interface VisionJobData {
  image: string
  question: string
  prevItemId: string | null
  prevTurns: Turn[]
  turns?: Turn[]
  itemId?: string | null
}

function isVisionData(v: unknown): v is VisionJobData {
  return typeof v === 'object' && v !== null
    && 'image' in v && typeof v.image === 'string'
    && 'question' in v && typeof v.question === 'string'
    && 'prevTurns' in v && Array.isArray(v.prevTurns)
}

type VisionBody = Parameters<SillyClient['vision']>[0]

/** Self-contained queue job: ask, then save/extend the thread's library item. */
async function runVision(ctx: JobContext, client: SillyClient, body: VisionBody, data: VisionJobData): Promise<void> {
  ctx.report({ message: 'Analyzing image…' })
  let res
  try {
    res = await client.vision(body, ctx.signal)
  } catch (e) {
    if (!ctx.signal.aborted) toast.error(errorMessage(e))
    throw e
  }
  const turns = [...data.prevTurns, { query: data.question, response: res.response, model: res.model }]
  let itemId = data.prevItemId
  try {
    if (itemId) {
      await library.update(itemId, { meta: threadMeta(turns) })
    } else {
      const blob = await fetch(data.image).then((r) => r.blob())
      const item = await library.add({
        kind: 'image',
        source: 'vision',
        blob,
        name: `vision-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
        prompt: data.question,
        model: res.model,
        meta: threadMeta(turns),
      })
      itemId = item.id
    }
    ctx.addItem(itemId)
  } catch {
    toast.info('Analysis not saved to library')
  }
  ctx.setData({ ...data, turns, itemId } satisfies VisionJobData)
}

/** What the results pane shows: a queued/answered job, or a re-opened saved thread. */
type View = { kind: 'job'; jobId: string } | { kind: 'thread'; thread: Thread }

export function VisionPage() {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)

  // Returning to the page: show the newest vision job again.
  const [view, setView] = useState<View | null>(() => {
    const last = jobs.all().find((j) => j.page === 'vision')
    return last ? { kind: 'job', jobId: last.id } : null
  })
  const [image, setImage] = useState<string | null>(() => {
    const last = jobs.all().find((j) => j.page === 'vision')
    return last && isVisionData(last.data) ? last.data.image : null
  })
  const [query, setQuery] = useState(FULL_DESCRIPTION)
  const [maxTokens, setMaxTokens] = useState('')
  const [temperature, setTemperature] = useState(0.7)
  const [followUp, setFollowUp] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const threadEndRef = useRef<HTMLDivElement | null>(null)

  const viewJob = useJob(view?.kind === 'job' ? view.jobId : null)
  const viewData = viewJob && isVisionData(viewJob.data) ? viewJob.data : null
  const viewActive = viewJob?.state === 'queued' || viewJob?.state === 'running'
  /** The question currently being answered (rendered as a pending turn). */
  const pending = viewActive && viewData ? viewData.question : null
  const thread: Thread | null = useMemo(() => {
    if (view?.kind === 'thread') return view.thread
    if (!viewData) return null
    const turns = viewData.turns ?? viewData.prevTurns
    const itemId = viewData.itemId !== undefined ? viewData.itemId : viewData.prevItemId
    return turns.length || viewActive ? { itemId, image: viewData.image, turns } : null
  }, [view, viewData, viewActive])
  const busy = pending != null

  const pageJobs = usePageJobs('vision')
  const otherActive = useMemo(
    () => pageJobs.filter((j) => (j.state === 'queued' || j.state === 'running') && j.id !== viewJob?.id).reverse(),
    [pageJobs, viewJob?.id],
  )

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

  const ask = (img: string, question: string, previous: Thread | null) => {
    const parsedTokens = maxTokens.trim() ? Number(maxTokens) : undefined
    const body: VisionBody = {
      image: stripDataUrl(img),
      query: previous?.turns.length ? followUpQuery(previous.turns, question) : question,
      max_tokens: parsedTokens !== undefined && Number.isFinite(parsedTokens) ? parsedTokens : undefined,
      temperature,
    }
    const data: VisionJobData = { image: img, question, prevItemId: previous?.itemId ?? null, prevTurns: previous?.turns ?? [] }
    const jobId = jobs.enqueue({
      page: 'vision',
      label: `${previous?.turns.length ? 'Follow-up' : 'Vision'}: ${question.slice(0, 40)}`,
      data,
      run: (ctx) => runVision(ctx, client, body, data),
    })
    setView({ kind: 'job', jobId })
    setCopied(null)
  }

  /* hand-off from other pages: consume once, analyze immediately */
  useHandoffImage('vision', (handoff) => {
    setImage(handoff)
    setQuery(FULL_DESCRIPTION)
    ask(handoff, FULL_DESCRIPTION, null)
  })

  const onImageChange = (next: string | null) => {
    setImage(next)
    if (next !== thread?.image) setView(null)
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
    ask(image, query.trim(), null)
  }

  const sendFollowUp = () => {
    const q = followUp.trim()
    if (!thread || !q || busy) return
    setFollowUp('')
    ask(thread.image, q, thread)
  }

  const reopen = async (item: MediaItem, turns: Turn[]) => {
    try {
      const dataUrl = await blobToDataUrl(await itemBlob(item))
      setImage(dataUrl)
      setQuery(turns[0]?.query ?? '')
      setView({ kind: 'thread', thread: { itemId: item.id, image: dataUrl, turns } })
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
      if (thread?.itemId === item.id) setView(null)
      toast.success('Deleted')
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const canAnalyze = Boolean(image) && query.trim().length > 0
  const canFollowUp = Boolean(thread) && !busy && followUp.trim().length > 0
  const shownImage = thread?.image ?? null
  const lastAnswer = thread?.turns[thread.turns.length - 1]?.response

  usePrimaryAction(canFollowUp
    ? { label: 'Ask follow-up', run: sendFollowUp }
    : { label: thread ? 'New analysis' : 'Analyze', run: analyze, disabled: !canAnalyze })

  useCommands([
    { id: 'vision.new', label: 'Start over on this image', group: 'Vision', keywords: 'clear reset thread', disabled: !thread || busy, run: () => { if (thread) { setView(null); setImage(thread.image) } } },
    { id: 'vision.copy-answer', label: 'Copy last answer', group: 'Vision', disabled: !lastAnswer, run: () => { if (lastAnswer) void copyText(lastAnswer) } },
    { id: 'vision.copy-thread', label: 'Copy whole thread', group: 'Vision', disabled: !thread || thread.turns.length < 2, run: () => { if (thread) void copyText(threadMarkdown(thread.turns)) } },
    { id: 'vision.query.full', label: 'Use full-description query', group: 'Vision', run: () => setQuery(FULL_DESCRIPTION) },
    { id: 'vision.cancel', label: 'Cancel current vision question', group: 'Vision', disabled: !viewActive, run: () => { if (viewJob) jobs.cancel(viewJob.id) } },
  ])

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

          <Button variant="primary" icon={<Sparkles size={15} />} disabled={!canAnalyze} onClick={analyze}>
            {thread ? 'New analysis' : 'Analyze'}
          </Button>
        </div>
      </div>

      {/* results */}
      <div className="flex-1 scroll-area p-5">
        <div className="flex flex-col gap-5">
          {otherActive.length > 0 && (
            <div className="flex flex-col gap-2">
              {otherActive.map((j) => <JobStrip key={j.id} job={j} />)}
            </div>
          )}
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
                        onClick={() => { setView(null); setImage(thread.image) }}
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
                    <div className="flex flex-col gap-2 px-4 py-3">
                      <div className="line-clamp-2 text-[12px] text-ink-dim" title={pending}>
                        <span className="font-semibold text-accent">{turnCount ? 'Follow-up' : 'Q'}:</span> {pending}
                      </div>
                      <JobStrip job={viewJob} label="Analyzing image" />
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
