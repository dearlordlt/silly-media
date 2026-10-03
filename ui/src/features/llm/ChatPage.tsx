/**
 * LLM page — huihui-qwen3-4b, an uncensored creative-writing model.
 *
 * Two modes:
 *  - Chat: multi-conversation sidebar persisted in the profile's settings (kv),
 *    editable / deletable messages, regenerate + continue, Markdown/JSON export.
 *  - Raw: single `prompt` (+ optional `system_prompt`) completion, no chat
 *    history — the backend skips the chat template when no system prompt is set.
 *
 * Both modes support token-by-token SSE streaming with abort (or a
 * non-streaming call that reports token counts), Qwen3 `<think>` blocks rendered
 * as a collapsed "thought process", and per-reply speed stats (TTFT, tok/s).
 */
import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  Bot, Brain, Check, ChevronDown, ChevronRight, Copy, CornerDownLeft, Eraser, FileJson, FileText,
  MessagesSquare, Pencil, Plus, RefreshCw, RotateCcw, Save, Send, Sparkles, Square, Terminal, Trash2,
  User as UserIcon, X,
} from 'lucide-react'
import type { ChatMessage, LLMRequest } from '../../lib/types'
import { errorMessage, toast, useClient } from '../../lib/hooks'
import { downloadBlob } from '../../lib/media'
import { useApp } from '../../lib/store'
import { kv } from '../../lib/kv'
import { MOD_KEY, useCommands, usePrimaryAction } from '../../lib/commands'
import {
  Button, Chip, EmptyState, IconButton, Input, Label, Panel, Section,
  Segmented, Slider, Spinner, StatusDot, Switch, Textarea,
} from '../../components/ui/primitives'

/* ------------------------------------------------------------ persistence */

interface GenStats {
  inputTokens?: number
  outputTokens: number
  seconds: number
  ttft?: number
  tokPerSec: number
  streamed: boolean
}

interface ConvMessage {
  role: 'user' | 'assistant'
  content: string
  inputTokens?: number
  outputTokens?: number
  seconds?: number
  ttft?: number
  tokPerSec?: number
  streamed?: boolean
}

interface Conversation {
  id: string
  title: string
  system: string
  messages: ConvMessage[]
  updatedAt: number
}

interface LLMParams {
  temperature: number
  top_p: number
  top_k: number
  max_tokens: number
  repetition_penalty: number
  /** Optional — kept as string so an empty field means "unset". */
  min_p: string
  /** Empty or negative = random. */
  seed: string
  enable_thinking: boolean
}

type Mode = 'chat' | 'raw'

interface RawState {
  prompt: string
  system: string
  output: string
  stats: GenStats | null
}

interface PersistedState {
  conversations: Conversation[]
  activeId: string | null
  params: LLMParams
  streaming: boolean
  mode: Mode
  raw: RawState
}

const STORE_KEY = 'silly-media-chat-v1'

/** Legacy llm.html default system prompt. */
const DEFAULT_SYSTEM = 'You are a creative and helpful assistant. Be concise but thorough.'

const SYSTEM_PRESETS: { label: string; text: string }[] = [
  { label: 'Default', text: DEFAULT_SYSTEM },
  {
    label: 'Storyteller',
    text: 'You are a bold, uncensored creative-writing partner. Write vivid, immersive prose with strong sensory detail and natural dialogue. Continue the story from where the user leaves off and never summarize.',
  },
  {
    label: 'Roleplay',
    text: 'Stay fully in character as the persona the user describes. Never break character, never add disclaimers. Write in first person; put actions in *italics*.',
  },
  {
    label: 'Image prompts',
    text: 'You turn short ideas into detailed text-to-image prompts covering subject, setting, composition, lighting, style and camera. Reply with the prompt only, as a single paragraph.',
  },
  {
    label: 'Lyrics',
    text: 'You are a songwriter. Write song lyrics with [verse], [chorus] and [bridge] section tags, consistent meter and memorable hooks. Output only the lyrics.',
  },
  {
    label: 'Coder',
    text: 'You are an expert programmer. Give correct, idiomatic code with brief explanations. Prefer complete, runnable examples.',
  },
  { label: 'None', text: '' },
]

const DEFAULT_PARAMS: LLMParams = {
  temperature: 0.8,
  top_p: 0.9,
  top_k: 50,
  max_tokens: 32768,
  repetition_penalty: 1.1,
  min_p: '',
  seed: '',
  enable_thinking: false,
}

const EMPTY_RAW: RawState = { prompt: '', system: '', output: '', stats: null }

function newConversation(system: string = DEFAULT_SYSTEM): Conversation {
  return {
    id: crypto.randomUUID(),
    title: 'New chat',
    system,
    messages: [],
    updatedAt: Date.now(),
  }
}

function emptyState(): PersistedState {
  const conv = newConversation()
  return { conversations: [conv], activeId: conv.id, params: DEFAULT_PARAMS, streaming: true, mode: 'chat', raw: EMPTY_RAW }
}

function loadState(): PersistedState {
  const parsed = kv.getJson<Partial<PersistedState> | null>(STORE_KEY, null)
  if (!parsed || typeof parsed !== 'object') return emptyState()
  const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : []
  if (conversations.length === 0) return emptyState()
  return {
    conversations,
    activeId: parsed.activeId ?? conversations[0]?.id ?? null,
    params: { ...DEFAULT_PARAMS, ...(parsed.params ?? {}) },
    streaming: parsed.streaming ?? true,
    mode: parsed.mode === 'raw' ? 'raw' : 'chat',
    raw: { ...EMPTY_RAW, ...(parsed.raw ?? {}) },
  }
}

/* ------------------------------------------------------------- utilities */

function makeTitle(text: string): string {
  const clean = text.trim().replace(/\s+/g, ' ')
  return clean.length > 42 ? `${clean.slice(0, 42)}…` : clean || 'New chat'
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException ? e.name === 'AbortError' : e instanceof Error && e.name === 'AbortError'
}

function sampling(p: LLMParams): Omit<LLMRequest, 'messages' | 'prompt' | 'system_prompt'> {
  const minP = p.min_p.trim() === '' ? null : Number(p.min_p)
  const rawSeed = p.seed.trim() === '' ? null : Number(p.seed)
  const seed = rawSeed != null && Number.isFinite(rawSeed) && rawSeed >= 0 ? Math.trunc(rawSeed) : null
  return {
    temperature: p.temperature,
    top_p: p.top_p,
    top_k: p.top_k,
    max_tokens: p.max_tokens,
    repetition_penalty: p.repetition_penalty,
    min_p: minP != null && Number.isFinite(minP) ? minP : null,
    seed,
    enable_thinking: p.enable_thinking,
  }
}

function buildChatBody(messages: ConvMessage[], system: string, p: LLMParams): LLMRequest {
  const wire: ChatMessage[] = []
  const sys = system.trim()
  if (sys) wire.push({ role: 'system', content: sys })
  for (const m of messages) if (m.content.trim()) wire.push({ role: m.role, content: m.content })
  return { messages: wire, ...sampling(p) }
}

function buildRawBody(raw: RawState, p: LLMParams): LLMRequest {
  const sys = raw.system.trim()
  return { prompt: raw.prompt, system_prompt: sys || null, ...sampling(p) }
}

/**
 * Split a Qwen3 reply into its `<think>` reasoning and the visible answer.
 * Handles an unterminated block (still streaming) and a bare `</think>` (when
 * the chat template already emitted the opening tag).
 */
function splitThinking(text: string): { thinking: string | null; answer: string; done: boolean } {
  const open = text.indexOf('<think>')
  const close = text.indexOf('</think>')
  if (open === -1 && close === -1) return { thinking: null, answer: text, done: true }
  if (close === -1 || (open !== -1 && close < open)) {
    return { thinking: text.slice(open + '<think>'.length).trim(), answer: text.slice(0, open).trim(), done: false }
  }
  const hasOpen = open !== -1 && open < close
  const before = hasOpen ? text.slice(0, open) : ''
  const thinking = text.slice(hasOpen ? open + '<think>'.length : 0, close).trim()
  return { thinking, answer: `${before}${text.slice(close + '</think>'.length)}`.trim(), done: true }
}

function statsLabel(s: { inputTokens?: number; outputTokens?: number; seconds?: number; ttft?: number; tokPerSec?: number; streamed?: boolean }): string | undefined {
  if (s.outputTokens == null) return undefined
  const tps = s.tokPerSec != null ? ` · ${s.tokPerSec.toFixed(1)} tok/s` : ''
  if (s.streamed) {
    const ttft = s.ttft != null ? ` · TTFT ${s.ttft.toFixed(2)}s` : ''
    return `${s.outputTokens} tok${ttft}${tps} · ${(s.seconds ?? 0).toFixed(1)}s`
  }
  return `${s.inputTokens ?? 0} in / ${s.outputTokens} out · ${(s.seconds ?? 0).toFixed(1)}s${tps}`
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat'
}

function conversationMarkdown(c: Conversation): string {
  const lines = [`# ${c.title}`, '', `_Exported ${new Date().toLocaleString()}_`, '']
  if (c.system.trim()) lines.push('## System', '', c.system.trim(), '')
  for (const m of c.messages) {
    lines.push(`## ${m.role === 'user' ? 'User' : 'Assistant'}`, '', m.content.trim(), '')
    const meta = m.role === 'assistant' ? statsLabel(m) : undefined
    if (meta) lines.push(`<sub>${meta}</sub>`, '')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ page */

export function ChatPage() {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)

  const [boot] = useState(loadState)
  const [conversations, setConversations] = useState<Conversation[]>(boot.conversations)
  const [activeId, setActiveId] = useState<string | null>(boot.activeId)
  const [params, setParams] = useState<LLMParams>(boot.params)
  const [streaming, setStreaming] = useState(boot.streaming)
  const [mode, setMode] = useState<Mode>(boot.mode)
  const [raw, setRaw] = useState<RawState>(boot.raw)

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState('')
  /** Conversation id being generated into, or 'raw'. */
  const [liveTarget, setLiveTarget] = useState<string | null>(null)
  const [sysOpen, setSysOpen] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)
  const accRef = useRef('')
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  const [models, setModels] = useState<{ available: string[]; loaded: string[] } | null>(null)
  const [modelsError, setModelsError] = useState(false)

  const active =
    conversations.find((c) => c.id === activeId) ?? conversations[0] ?? null

  /* -- persistence ------------------------------------------------------- */
  /** Last persisted snapshot; lets a reply that settles after unmount still be saved. */
  const savedRef = useRef<PersistedState>(boot)
  const mountedRef = useRef(true)
  const persist = (state: PersistedState) => {
    savedRef.current = state
    kv.setJson(STORE_KEY, state)
  }
  useEffect(() => {
    persist({ conversations, activeId: active?.id ?? null, params, streaming, mode, raw })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persist only touches refs/kv
  }, [conversations, activeId, params, streaming, mode, raw, active?.id])

  /* Navigating away aborts the in-flight request; its partial reply is saved via savedRef. */
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
    }
  }, [])

  /* -- models ------------------------------------------------------------ */
  /** Bumped after each generation so the loaded/unloaded status refreshes. */
  const [modelsTick, setModelsTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    client
      .llmModels()
      .then((m) => { if (!cancelled) { setModels(m); setModelsError(false) } })
      .catch(() => { if (!cancelled) { setModels({ available: [], loaded: [] }); setModelsError(true) } })
    return () => { cancelled = true }
  }, [client, modelsTick])

  /* -- autoscroll -------------------------------------------------------- */
  const messageCount = active?.messages.length ?? 0
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messageCount, live, busy, mode])

  /* -- mutations --------------------------------------------------------- */
  const updateConv = (id: string, fn: (c: Conversation) => Conversation) =>
    setConversations((prev) => prev.map((c) => (c.id === id ? fn(c) : c)))

  const createChat = () => {
    const conv = newConversation(active?.system ?? DEFAULT_SYSTEM)
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
    setDraft('')
    setSysOpen(false)
    setMode('chat')
  }

  const deleteChat = (id: string) => {
    const target = conversations.find((c) => c.id === id)
    if (confirmDeletes && !window.confirm(`Delete “${target?.title ?? 'chat'}”? This cannot be undone.`)) return
    const rest = conversations.filter((c) => c.id !== id)
    if (rest.length === 0) {
      const fresh = newConversation()
      setConversations([fresh])
      setActiveId(fresh.id)
      return
    }
    setConversations(rest)
    if (id === active?.id) setActiveId(rest[0].id)
  }

  const clearMessages = () => {
    if (!active || active.messages.length === 0) return
    if (confirmDeletes && !window.confirm('Clear all messages in this chat?')) return
    updateConv(active.id, (c) => ({ ...c, messages: [], title: 'New chat', updatedAt: Date.now() }))
  }

  const commitRename = () => {
    if (!renamingId) return
    const title = makeTitle(renameDraft)
    updateConv(renamingId, (c) => ({ ...c, title }))
    setRenamingId(null)
  }

  const copyText = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200)
    } catch (e) {
      toast.error(errorMessage(e))
    }
  }

  const exportChat = (format: 'md' | 'json') => {
    if (!active) return
    const name = `chat-${slug(active.title)}`
    if (format === 'md') {
      downloadBlob(new Blob([conversationMarkdown(active)], { type: 'text/markdown' }), `${name}.md`)
    } else {
      const payload = {
        title: active.title,
        system: active.system,
        messages: active.messages,
        params,
        exportedAt: new Date().toISOString(),
      }
      downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${name}.json`)
    }
  }

  const setMessage = (convId: string, index: number, content: string) =>
    updateConv(convId, (c) => ({
      ...c,
      messages: c.messages.map((m, i) => (i === index ? { ...m, content } : m)),
      updatedAt: Date.now(),
    }))

  const deleteMessage = (convId: string, index: number) =>
    updateConv(convId, (c) => ({ ...c, messages: c.messages.filter((_, i) => i !== index), updatedAt: Date.now() }))

  /* -- generation -------------------------------------------------------- */

  /** Run one request, streaming deltas into `live`. Partial text survives in accRef on error/abort. */
  const generateText = async (body: LLMRequest, signal: AbortSignal): Promise<{ text: string; stats: GenStats }> => {
    const t0 = performance.now()
    if (streaming) {
      let count = 0
      let first: number | null = null
      for await (const delta of client.llmStream(body, signal)) {
        if (first === null) first = performance.now()
        accRef.current += delta
        count++
        setLive(accRef.current)
      }
      const doneAt = performance.now()
      const genSeconds = (doneAt - (first ?? t0)) / 1000
      return {
        text: accRef.current,
        stats: {
          outputTokens: count,
          seconds: (doneAt - t0) / 1000,
          ttft: first !== null ? (first - t0) / 1000 : undefined,
          tokPerSec: count > 0 && genSeconds > 0 ? count / genSeconds : 0,
          streamed: true,
        },
      }
    }
    const res = await client.llm(body, signal)
    const wall = (performance.now() - t0) / 1000
    const seconds = res.generation_time_seconds > 0 ? res.generation_time_seconds : wall
    accRef.current = res.text
    return {
      text: res.text,
      stats: {
        inputTokens: res.input_tokens,
        outputTokens: res.output_tokens,
        seconds,
        tokPerSec: res.output_tokens > 0 && seconds > 0 ? res.output_tokens / seconds : 0,
        streamed: false,
      },
    }
  }

  const begin = (target: string): AbortController => {
    setBusy(true)
    setLive('')
    setLiveTarget(target)
    accRef.current = ''
    const controller = new AbortController()
    abortRef.current = controller
    return controller
  }

  const end = () => {
    abortRef.current = null
    accRef.current = ''
    setLive('')
    setLiveTarget(null)
    setBusy(false)
    setModelsTick((t) => t + 1)
  }

  const appendAssistant = (convId: string, content: string, stats?: GenStats) => {
    const msg: ConvMessage = { role: 'assistant', content, ...stats }
    const apply = (list: Conversation[]) =>
      list.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, msg], updatedAt: Date.now() } : c))
    if (mountedRef.current) setConversations(apply)
    else persist({ ...savedRef.current, conversations: apply(savedRef.current.conversations) })
  }

  /** Generate an assistant reply for `base` (the full history to send) in `conv`. */
  const runChat = async (conv: Conversation, base: ConvMessage[], title = conv.title) => {
    if (busy || base.length === 0) return
    updateConv(conv.id, (c) => ({ ...c, title, messages: base, updatedAt: Date.now() }))
    const controller = begin(conv.id)
    try {
      const { text, stats } = await generateText(buildChatBody(base, conv.system, params), controller.signal)
      if (text.trim()) appendAssistant(conv.id, text, stats)
    } catch (e) {
      if (accRef.current.trim()) appendAssistant(conv.id, accRef.current)
      if (!mountedRef.current) return
      if (isAbort(e)) toast.info('Generation stopped')
      else toast.error(errorMessage(e))
    } finally {
      end()
      composerRef.current?.focus()
    }
  }

  const send = (text: string) => {
    if (!active) return
    const typed = text.trim()
    const base: ConvMessage[] = [...active.messages]
    if (typed) base.push({ role: 'user', content: typed })
    const title = active.messages.length === 0 && typed ? makeTitle(typed) : active.title
    setDraft('')
    void runChat(active, base, title)
  }

  /** Drop the trailing assistant reply (if any) and generate it again. */
  const regenerate = () => {
    if (!active) return
    const base = [...active.messages]
    while (base.length && base[base.length - 1].role === 'assistant') base.pop()
    if (base.length === 0) return
    void runChat(active, base)
  }

  /** Replace a user message, drop everything after it, and regenerate from there. */
  const resendFrom = (index: number, content: string) => {
    if (!active || !content.trim()) return
    const base = [...active.messages.slice(0, index), { role: 'user' as const, content: content.trim() }]
    void runChat(active, base, index === 0 ? makeTitle(content) : active.title)
  }

  const runRaw = async () => {
    if (busy || !raw.prompt.trim()) return
    const controller = begin('raw')
    setRaw((r) => ({ ...r, output: '', stats: null }))
    try {
      const { text, stats } = await generateText(buildRawBody(raw, params), controller.signal)
      if (mountedRef.current) setRaw((r) => ({ ...r, output: text, stats }))
      else persist({ ...savedRef.current, raw: { ...savedRef.current.raw, output: text, stats } })
    } catch (e) {
      const partial = accRef.current
      if (mountedRef.current) setRaw((r) => ({ ...r, output: partial, stats: null }))
      else persist({ ...savedRef.current, raw: { ...savedRef.current.raw, output: partial, stats: null } })
      if (!mountedRef.current) return
      if (isAbort(e)) toast.info('Generation stopped')
      else toast.error(errorMessage(e))
    } finally {
      end()
    }
  }

  const onComposerKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(draft)
    }
  }

  const setP = (patch: Partial<LLMParams>) => setParams((p) => ({ ...p, ...patch }))

  const messages = active?.messages ?? []
  const canContinue = !busy && messages.length > 0
  const canRegenerate = !busy && messages.some((m) => m.role === 'user')
  const lastAssistant = messages.length > 0 && messages[messages.length - 1].role === 'assistant' ? messages.length - 1 : -1

  // Ctrl/⌘+Enter: send in chat (plain Enter in the composer also sends), generate in raw mode.
  usePrimaryAction(mode === 'chat'
    ? { label: 'Send', run: () => send(draft), disabled: busy || !draft.trim() }
    : { label: 'Generate', run: () => void runRaw(), disabled: busy || !raw.prompt.trim() })

  useCommands([
    { id: 'chat.new', label: 'New conversation', group: 'Chat', keywords: 'llm create', disabled: busy, run: createChat },
    { id: 'chat.clear', label: 'Clear messages in this chat', group: 'Chat', keywords: 'llm reset', disabled: busy || mode !== 'chat' || messages.length === 0, run: clearMessages },
    { id: 'chat.regenerate', label: 'Regenerate last reply', group: 'Chat', disabled: mode !== 'chat' || !canRegenerate, run: regenerate },
    { id: 'chat.continue', label: 'Continue last reply', group: 'Chat', disabled: mode !== 'chat' || !canContinue, run: () => send('') },
    { id: 'chat.stop', label: 'Stop generating', group: 'Chat', disabled: !busy, run: () => abortRef.current?.abort() },
    { id: 'chat.mode', label: mode === 'chat' ? 'Switch to raw completion' : 'Switch to chat', group: 'Chat', disabled: busy, run: () => setMode(mode === 'chat' ? 'raw' : 'chat') },
    { id: 'chat.export.md', label: 'Export chat as Markdown', group: 'Chat', disabled: !active || messages.length === 0, run: () => exportChat('md') },
    { id: 'chat.export.json', label: 'Export chat as JSON', group: 'Chat', disabled: !active || messages.length === 0, run: () => exportChat('json') },
    { id: 'chat.focus', label: 'Focus message box', group: 'Chat', disabled: mode !== 'chat', run: () => composerRef.current?.focus() },
  ])

  const systemValue = mode === 'raw' ? raw.system : active?.system ?? ''
  const setSystemValue = (v: string) => {
    if (mode === 'raw') setRaw((r) => ({ ...r, system: v }))
    else if (active) updateConv(active.id, (c) => ({ ...c, system: v }))
  }

  const rawLive = busy && liveTarget === 'raw'
  const rawShown = rawLive ? live : raw.output
  const rawSplit = splitThinking(rawShown)

  return (
    <div className="flex h-full">
      {/* -------------------------------------------------- controls column */}
      <div className="w-[360px] shrink-0 scroll-area border-r border-line p-5">
        <div className="flex flex-col gap-6">
          {mode === 'chat' && (
            <Section
              title="Conversations"
              action={
                <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={createChat}>
                  New
                </Button>
              }
            >
              <div className="flex flex-col gap-1">
                {conversations.map((c) => {
                  const selected = c.id === active?.id
                  return (
                    <div
                      key={c.id}
                      className={`group flex items-center gap-1 rounded-[10px] border px-2 py-1.5 transition-colors ${
                        selected ? 'border-accent/50 bg-accent/10' : 'border-line bg-panel hover:border-line-strong'
                      }`}
                    >
                      {renamingId === c.id ? (
                        <Input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitRename()
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          className="h-7 flex-1 text-[12.5px]"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActiveId(c.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <div className={`truncate text-[12.5px] ${selected ? 'text-ink' : 'text-ink-dim'}`}>{c.title}</div>
                          <div className="truncate text-[10.5px] text-ink-faint">
                            {c.messages.length} message{c.messages.length === 1 ? '' : 's'}
                          </div>
                        </button>
                      )}
                      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
                        <IconButton
                          className="h-6 w-6"
                          title="Rename"
                          onClick={() => { setRenamingId(c.id); setRenameDraft(c.title) }}
                        >
                          <Pencil size={12} />
                        </IconButton>
                        <IconButton
                          className="h-6 w-6 hover:text-bad"
                          title="Delete"
                          onClick={() => deleteChat(c.id)}
                        >
                          <Trash2 size={12} />
                        </IconButton>
                      </div>
                    </div>
                  )
                })}
              </div>
            </Section>
          )}

          <Section
            title={mode === 'raw' ? 'System prompt (optional)' : 'System prompt'}
            action={
              <IconButton onClick={() => setSysOpen((v) => !v)} title={sysOpen ? 'Collapse' : 'Expand'}>
                {sysOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </IconButton>
            }
          >
            {sysOpen ? (
              <Textarea
                rows={5}
                placeholder={mode === 'raw' ? 'Empty = pure completion, no chat template' : 'You are a helpful assistant…'}
                value={systemValue}
                onChange={(e) => setSystemValue(e.target.value)}
                className="text-[12.5px]"
              />
            ) : (
              <button
                type="button"
                onClick={() => setSysOpen(true)}
                className="w-full truncate rounded-[10px] border border-line bg-bg px-2.5 py-2 text-left text-[12px] text-ink-faint hover:border-line-strong"
              >
                {systemValue.trim() || (mode === 'raw' ? 'None — raw completion without chat template' : 'None — click to add a system prompt')}
              </button>
            )}
            <div className="flex flex-wrap gap-1.5">
              {SYSTEM_PRESETS.map((p) => (
                <Chip
                  key={p.label}
                  active={systemValue.trim() === p.text}
                  title={p.text || 'Clear the system prompt'}
                  onClick={() => { setSystemValue(p.text); if (p.text) setSysOpen(true) }}
                >
                  {p.label}
                </Chip>
              ))}
            </div>
          </Section>

          <Section
            title="Parameters"
            action={
              <IconButton title="Reset to defaults" onClick={() => setParams(DEFAULT_PARAMS)}>
                <RotateCcw size={14} />
              </IconButton>
            }
          >
            <Panel className="flex flex-col gap-3.5 p-3.5">
              <Slider label="Temperature" min={0} max={2} step={0.05} value={params.temperature} onValueChange={(v) => setP({ temperature: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Top P" min={0} max={1} step={0.01} value={params.top_p} onValueChange={(v) => setP({ top_p: v })} format={(v) => v.toFixed(2)} />
              <Slider label="Top K" min={1} max={100} step={1} value={params.top_k} onValueChange={(v) => setP({ top_k: v })} />
              <Slider label="Max tokens" min={256} max={32768} step={256} value={params.max_tokens} onValueChange={(v) => setP({ max_tokens: v })} />
              <Slider label="Repetition penalty" min={1} max={2} step={0.01} value={params.repetition_penalty} onValueChange={(v) => setP({ repetition_penalty: v })} format={(v) => v.toFixed(2)} />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label hint="optional">Min P</Label>
                  <Input
                    type="number" min={0} max={1} step={0.01} placeholder="auto"
                    value={params.min_p}
                    onChange={(e) => setP({ min_p: e.target.value })}
                    className="h-8 text-[12.5px]"
                  />
                </div>
                <div>
                  <Label hint="-1 = random">Seed</Label>
                  <Input
                    type="number" step={1} min={-1} placeholder="random"
                    value={params.seed}
                    onChange={(e) => setP({ seed: e.target.value })}
                    className="h-8 text-[12.5px]"
                  />
                </div>
              </div>
              <div className="flex flex-col gap-2.5 border-t border-line pt-3">
                <Switch checked={streaming} onChange={setStreaming} label="Streaming" />
                <Switch checked={params.enable_thinking} onChange={(v) => setP({ enable_thinking: v })} label="Enable thinking" />
              </div>
            </Panel>
          </Section>

          <Section title="Models">
            <Panel className="p-3">
              {!models ? (
                <div className="flex items-center gap-2 text-[12px] text-ink-faint"><Spinner className="h-3.5 w-3.5" /> Loading models…</div>
              ) : modelsError ? (
                <StatusDot ok={false} label="API unavailable" />
              ) : models.available.length === 0 ? (
                <div className="text-[12px] text-ink-faint">No LLM models available.</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {models.available.map((m) => (
                    <StatusDot
                      key={m}
                      ok={models.loaded.includes(m)}
                      label={`${m} — ${busy ? 'generating…' : models.loaded.includes(m) ? 'loaded' : 'loads on first use'}`}
                    />
                  ))}
                </div>
              )}
            </Panel>
          </Section>
        </div>
      </div>

      {/* --------------------------------------------------- results column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {mode === 'chat' ? <MessagesSquare size={16} className="text-accent" /> : <Terminal size={16} className="text-accent" />}
            <span className="truncate text-sm font-semibold text-ink">
              {mode === 'chat' ? active?.title ?? 'Chat' : 'Raw completion'}
            </span>
            {params.enable_thinking && (
              <span className="inline-flex items-center gap-1 rounded-md border border-accent-2/50 bg-accent-2/10 px-1.5 py-0.5 text-[10.5px] text-accent-2">
                <Sparkles size={10} /> thinking
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {mode === 'chat' && (
              <>
                <IconButton title="Export as Markdown" onClick={() => exportChat('md')} disabled={messages.length === 0}>
                  <FileText size={15} />
                </IconButton>
                <IconButton title="Export as JSON" onClick={() => exportChat('json')} disabled={messages.length === 0}>
                  <FileJson size={15} />
                </IconButton>
                <IconButton title="Clear messages" onClick={clearMessages} disabled={busy || messages.length === 0}>
                  <Eraser size={15} />
                </IconButton>
              </>
            )}
            <Segmented
              value={mode}
              onChange={(m) => { if (!busy) setMode(m) }}
              options={[
                { value: 'chat', label: 'Chat' },
                { value: 'raw', label: 'Raw prompt' },
              ]}
            />
          </div>
        </div>

        {mode === 'chat' ? (
          <>
            <div ref={scrollRef} className="scroll-area min-h-0 flex-1 p-5">
              {messages.length === 0 && !busy ? (
                <EmptyState
                  icon={<Bot size={22} />}
                  title="Start a conversation"
                  detail="Ask anything or set a scene for the creative-writing model. Pick a system-prompt preset on the left to change its persona."
                />
              ) : (
                <div className="mx-auto flex max-w-3xl flex-col gap-3">
                  {messages.map((m, i) => (
                    <Bubble
                      key={`${active?.id ?? ''}-${i}`}
                      role={m.role}
                      content={m.content}
                      meta={m.role === 'assistant' ? statsLabel(m) : undefined}
                      copied={copiedId === `m${i}`}
                      onCopy={(text) => void copyText(`m${i}`, text)}
                      disabled={busy}
                      onSave={(text) => active && setMessage(active.id, i, text)}
                      onResend={m.role === 'user' ? (text) => resendFrom(i, text) : undefined}
                      onDelete={() => active && deleteMessage(active.id, i)}
                      onRegenerate={i === lastAssistant ? regenerate : undefined}
                    />
                  ))}
                  {busy && liveTarget === active?.id && (
                    <Bubble
                      role="assistant"
                      content={live}
                      streaming
                      copied={copiedId === 'live'}
                      onCopy={(text) => void copyText('live', text)}
                      disabled
                    />
                  )}
                </div>
              )}
            </div>

            <div className="border-t border-line px-5 py-4">
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <textarea
                  ref={composerRef}
                  rows={3}
                  placeholder="Message the model…  (Enter to send, Shift+Enter for a newline)"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onComposerKey}
                  disabled={busy}
                  className="field min-h-[76px] flex-1 resize-y text-[13px] leading-relaxed"
                />
                <div className="flex flex-col gap-2">
                  {busy ? (
                    <Button variant="danger" icon={<Square size={13} />} onClick={() => abortRef.current?.abort()}>Stop</Button>
                  ) : (
                    <Button variant="primary" icon={<Send size={13} />} onClick={() => send(draft)} disabled={!draft.trim()}>
                      Send
                    </Button>
                  )}
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<RefreshCw size={12} />}
                      onClick={regenerate}
                      disabled={!canRegenerate}
                      title="Discard the last reply and generate a new one"
                    >
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<CornerDownLeft size={12} />}
                      onClick={() => send('')}
                      disabled={!canContinue}
                      title="Re-send the conversation to keep generating"
                    >
                      Continue
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div ref={scrollRef} className="scroll-area min-h-0 flex-1 p-5">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              <div>
                <Label hint={`${raw.prompt.length} chars · ${MOD_KEY}+Enter to run`}>Prompt</Label>
                <Textarea
                  rows={10}
                  value={raw.prompt}
                  onChange={(e) => setRaw((r) => ({ ...r, prompt: e.target.value }))}
                  disabled={rawLive}
                  placeholder="Raw text sent as `prompt`. Without a system prompt the model simply continues this text."
                  className="text-[13px] leading-relaxed"
                />
              </div>
              <div className="flex items-center gap-2">
                {rawLive ? (
                  <Button variant="danger" icon={<Square size={13} />} onClick={() => abortRef.current?.abort()}>Stop</Button>
                ) : (
                  <Button variant="primary" icon={<Send size={13} />} onClick={() => void runRaw()} disabled={busy || !raw.prompt.trim()}>
                    Generate
                  </Button>
                )}
                <Button
                  variant="outline"
                  icon={<CornerDownLeft size={13} />}
                  disabled={busy || !rawSplit.answer}
                  onClick={() => setRaw((r) => ({ ...r, prompt: `${r.prompt}${splitThinking(r.output).answer}`, output: '', stats: null }))}
                  title="Append the output to the prompt so the next run continues it"
                >
                  Append to prompt
                </Button>
                <Button
                  variant="ghost"
                  icon={<Eraser size={13} />}
                  disabled={busy || (!raw.prompt && !raw.output)}
                  onClick={() => setRaw((r) => ({ ...r, prompt: '', output: '', stats: null }))}
                >
                  Clear
                </Button>
              </div>

              {(rawShown || rawLive) && (
                <Panel className="flex flex-col">
                  <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2 text-[11px] text-ink-faint">
                    <span>{rawLive ? <span className="text-accent">{streaming ? 'streaming…' : 'generating…'}</span> : raw.stats ? statsLabel(raw.stats) : 'Output'}</span>
                    {rawShown && (
                      <button
                        type="button"
                        onClick={() => void copyText('raw', rawSplit.answer || rawShown)}
                        className="inline-flex items-center gap-1 hover:text-ink"
                      >
                        {copiedId === 'raw' ? <Check size={11} /> : <Copy size={11} />}
                        {copiedId === 'raw' ? 'Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                  <div className="px-3.5 py-3">
                    {rawShown ? (
                      <MessageBody content={rawShown} />
                    ) : (
                      <div className="flex items-center gap-2 text-[12.5px] text-ink-faint"><Spinner className="h-3.5 w-3.5" /> Generating…</div>
                    )}
                  </div>
                </Panel>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------------------------------------------------------- message body */

function MessageBody({ content }: { content: string }) {
  const { thinking, answer, done } = splitThinking(content)
  return (
    <>
      {thinking !== null && (
        <details className="mb-2 rounded-lg border border-accent-2/30 bg-accent-2/5">
          <summary className="flex cursor-pointer select-none items-center gap-1.5 px-2.5 py-1.5 text-[11.5px] text-accent-2">
            <Brain size={12} />
            {done ? `Thought process · ${thinking.split(/\s+/).filter(Boolean).length} words` : 'Thinking…'}
          </summary>
          <div className="whitespace-pre-wrap break-words border-t border-accent-2/20 px-2.5 py-2 text-[12px] leading-relaxed text-ink-dim">
            {thinking || '…'}
          </div>
        </details>
      )}
      {answer && <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{answer}</div>}
    </>
  )
}

/* ---------------------------------------------------------------- bubble */

function Bubble({ role, content, meta, streaming, copied, onCopy, disabled, onSave, onResend, onDelete, onRegenerate }: {
  role: 'user' | 'assistant'
  content: string
  meta?: string
  streaming?: boolean
  copied: boolean
  onCopy: (text: string) => void
  disabled?: boolean
  onSave?: (text: string) => void
  onResend?: (text: string) => void
  onDelete?: () => void
  onRegenerate?: () => void
}) {
  const isUser = role === 'user'
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState(content)

  const startEdit = () => { setEditDraft(content); setEditing(true) }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isUser ? 'bg-accent/20 text-accent' : 'bg-panel-2 text-accent-2'}`}>
        {isUser ? <UserIcon size={14} /> : <Bot size={14} />}
      </div>
      <div className={`group min-w-0 rounded-xl border px-3.5 py-2.5 ${editing ? 'w-[85%]' : 'max-w-[85%]'} ${isUser ? 'border-accent/40 bg-accent/10' : 'border-line bg-panel'}`}>
        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea
              autoFocus
              rows={Math.min(14, Math.max(3, editDraft.split('\n').length + 1))}
              value={editDraft}
              onChange={(e) => setEditDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
              className="text-[13px] leading-relaxed"
            />
            <div className="flex justify-end gap-1.5">
              <Button size="sm" variant="ghost" icon={<X size={12} />} onClick={() => setEditing(false)}>Cancel</Button>
              {onSave && (
                <Button size="sm" variant="outline" icon={<Save size={12} />} onClick={() => { onSave(editDraft); setEditing(false) }}>
                  Save
                </Button>
              )}
              {onResend && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Send size={12} />}
                  disabled={disabled || !editDraft.trim()}
                  onClick={() => { onResend(editDraft); setEditing(false) }}
                  title="Save, drop every later message and regenerate the reply"
                >
                  Save & regenerate
                </Button>
              )}
            </div>
          </div>
        ) : content ? (
          <MessageBody content={content} />
        ) : (
          <div className="flex items-center gap-2 text-[12.5px] text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Generating…
          </div>
        )}
        {!editing && (
          <div className="mt-1.5 flex items-center gap-2 text-[10.5px] text-ink-faint">
            {meta && <span>{meta}</span>}
            {streaming && <span className="text-accent">streaming…</span>}
            {content && (
              <div className="ml-auto flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                {onRegenerate && !disabled && (
                  <button type="button" onClick={onRegenerate} className="inline-flex items-center gap-1 hover:text-ink">
                    <RefreshCw size={11} /> Regenerate
                  </button>
                )}
                {onSave && !disabled && (
                  <button type="button" onClick={startEdit} className="inline-flex items-center gap-1 hover:text-ink">
                    <Pencil size={11} /> Edit
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onCopy(splitThinking(content).answer || content)}
                  className="inline-flex items-center gap-1 hover:text-ink"
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                {onDelete && !disabled && (
                  <button type="button" onClick={onDelete} className="inline-flex items-center gap-1 hover:text-bad">
                    <Trash2 size={11} /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
