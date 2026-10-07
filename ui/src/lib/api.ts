/**
 * Typed client for the Silly Media API (http://localhost:4201 by default).
 * Every call accepts an optional AbortSignal so requesters can cancel.
 */
import type {
  Actor,
  ActorAudioFile,
  HealthResponse,
  LLMRequest,
  LLMResponse,
  LoraListResponse,
  MayaActor,
  MayaTTSRequest,
  Model3DRequest,
  Model3DResult,
  ModelLorasResponse,
  ModelsResponse,
  MusicGenerateRequest,
  ProgressResponse,
  SpriteRequest,
  TTSHistoryEntry,
  TTSLanguageInfo,
  TTSLanguage,
  TTSRequest,
  VideoGenerateRequest,
  VideoHistoryEntry,
  VisionResponse,
  JobStatus,
  GenerateRequest,
  Img2ImgRequest,
} from './types'

export class ApiError extends Error {
  status: number
  detail: unknown
  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : JSON.stringify(detail))
    this.status = status
    this.detail = detail
  }
}

interface CallOpts { signal?: AbortSignal; base?: string }

async function readError(res: Response): Promise<ApiError> {
  // Read once: a failed json() consumes the body, so parse the text ourselves.
  let detail: unknown = res.statusText
  try {
    const text = await res.text()
    if (text) {
      try {
        const body: unknown = JSON.parse(text)
        detail = typeof body === 'object' && body !== null && 'detail' in body ? body.detail : body
      } catch {
        detail = text
      }
    }
  } catch { /* keep statusText */ }
  return new ApiError(res.status, detail)
}

/** Runtime narrowing for the SSE payload shape `{ delta?, error?, finish_reason? }`. */
function isStreamChunk(value: unknown): value is { delta?: string; error?: string } {
  if (typeof value !== 'object' || value === null) return false
  const d = 'delta' in value ? value.delta : undefined
  const e = 'error' in value ? value.error : undefined
  return (d === undefined || typeof d === 'string') && (e === undefined || typeof e === 'string')
}

export class SillyClient {
  base: string
  constructor(base: string) { this.base = base.replace(/\/+$/, '') }

  url(path: string): string { return `${this.base}${path}` }

  /** Absolute URL for a media path returned by the API (e.g. "/video/download/x"). */
  media(path: string | null | undefined): string | null {
    if (!path) return null
    if (/^https?:\/\//.test(path) || path.startsWith('data:') || path.startsWith('blob:')) return path
    return `${this.base}${path}`
  }

  private async json<T>(path: string, init?: RequestInit, opts?: { signal?: AbortSignal }): Promise<T> {
    // FormData must NOT get an explicit Content-Type: the browser has to add the
    // multipart boundary itself, otherwise the backend parses an empty form.
    const isJsonBody = init?.body != null && !(init.body instanceof FormData)
    const res = await fetch(this.url(path), {
      ...init,
      signal: opts?.signal,
      headers: { ...(isJsonBody ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    })
    if (!res.ok) throw await readError(res)
    // 204 / empty bodies (all DELETE endpoints) have nothing to parse.
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  private async blob(path: string, init?: RequestInit): Promise<Blob> {
    const res = await fetch(this.url(path), init)
    if (!res.ok) throw await readError(res)
    return res.blob()
  }

  // --- status ---------------------------------------------------------------
  health = (o?: CallOpts) => this.json<HealthResponse>('/health', undefined, o)
  models = (o?: CallOpts) => this.json<ModelsResponse>('/models', undefined, o)
  loras = (o?: CallOpts) => this.json<LoraListResponse>('/loras', undefined, o)
  modelLoras = (model: string, o?: CallOpts) =>
    this.json<ModelLorasResponse>(`/loras?model=${encodeURIComponent(model)}`, undefined, o)
  aspectRatios = (o?: CallOpts) => this.json<Record<string, { name: string; dimensions_at_1024: [number, number] }>>('/aspect-ratios', undefined, o)
  progress = (o?: CallOpts) => this.json<ProgressResponse>('/progress', undefined, o)

  // --- image generation -----------------------------------------------------
  async generate(model: string, body: GenerateRequest, signal?: AbortSignal): Promise<Blob> {
    return this.blob(`/generate/${encodeURIComponent(model)}`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
  }
  pixelart = (body: Record<string, unknown>, signal?: AbortSignal) =>
    this.blob('/pixelart/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal })
  sprite = (body: SpriteRequest, signal?: AbortSignal) =>
    this.blob('/sprite/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal })
  img2img = (model: string, body: Img2ImgRequest, signal?: AbortSignal) =>
    this.blob(`/img2img/edit/${encodeURIComponent(model)}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal })
  img2imgModels = (o?: CallOpts) => this.json<{ available: string[]; loaded: string[] }>('/img2img/models', undefined, o)
  img2imgProgress = (o?: CallOpts) => this.json<ProgressResponse>('/img2img/progress', undefined, o)

  // --- vision ---------------------------------------------------------------
  visionModels = (o?: CallOpts) => this.json<{ available: string[]; loaded: string[] }>('/vision/models', undefined, o)
  vision = (body: { image: string; query: string; max_tokens?: number; temperature?: number }, signal?: AbortSignal) =>
    this.json<VisionResponse>('/vision/analyze', { method: 'POST', body: JSON.stringify(body) }, { signal })

  // --- llm ------------------------------------------------------------------
  llmModels = (o?: CallOpts) => this.json<{ available: string[]; loaded: string[] }>('/llm/models', undefined, o)
  llm = (body: LLMRequest, signal?: AbortSignal) =>
    this.json<LLMResponse>('/llm/generate', { method: 'POST', body: JSON.stringify(body) }, { signal })
  /** Streaming chat via SSE; yields text deltas. */
  async *llmStream(body: LLMRequest, signal?: AbortSignal): AsyncGenerator<string, void, void> {
    const res = await fetch(this.url('/llm/stream'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
    if (!res.ok || !res.body) throw await readError(res)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop() ?? ''
      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') return
        try {
          const chunk: unknown = JSON.parse(payload)
          if (!isStreamChunk(chunk)) continue
          if (chunk.error) throw new ApiError(500, chunk.error)
          if (chunk.delta) yield chunk.delta
        } catch (e) {
          if (e instanceof ApiError) throw e
        }
      }
    }
  }

  // --- TTS ------------------------------------------------------------------
  ttsModels = (o?: CallOpts) => this.json<{ models: { id: string; name: string; description: string; voice_control: string; languages: string[]; vram_gb: number; supports_streaming: boolean; emotion_tags?: string[] }[]; default: string }>('/tts/models', undefined, o)
  languages = (o?: CallOpts) => this.json<{ languages: TTSLanguageInfo[] }>('/tts/languages', undefined, o)
  tts = (body: TTSRequest, signal?: AbortSignal) =>
    this.blob('/tts/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal })
  mayaTts = (body: MayaTTSRequest, signal?: AbortSignal) =>
    this.blob('/tts/maya/generate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal })
  /** POST /tts/stream or /tts/maya/stream; returns the raw Response so callers can read `body` progressively. */
  async speechStream(engine: 'xtts-v2' | 'maya', body: TTSRequest | MayaTTSRequest, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.url(engine === 'maya' ? '/tts/maya/stream' : '/tts/stream'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok) throw await readError(res)
    return res
  }
  /** One-shot XTTS voice clone from uploaded reference clips (no stored actor). */
  generateWithAudio = (p: { text: string; language: TTSLanguage; files: File[]; temperature: number; speed: number; splitSentences: boolean }, signal?: AbortSignal) => {
    const fd = new FormData()
    fd.append('text', p.text)
    fd.append('language', p.language)
    fd.append('temperature', String(p.temperature))
    fd.append('speed', String(p.speed))
    fd.append('split_sentences', String(p.splitSentences))
    for (const f of p.files) fd.append('reference_audio', f)
    return this.blob('/tts/generate-with-audio', { method: 'POST', body: fd, signal })
  }
  mayaEmotionTags = (o?: CallOpts) => this.json<{ tags: string[]; usage: string }>('/tts/maya/emotion-tags', undefined, o)
  mayaActors = (o?: CallOpts) => this.json<{ actors: MayaActor[]; total: number }>('/tts/maya/actors', undefined, o)
  createMayaActor = (name: string, voice_description: string) => {
    const fd = new FormData()
    fd.append('name', name)
    fd.append('voice_description', voice_description)
    return this.json<MayaActor>('/tts/maya/actors', { method: 'POST', body: fd })
  }
  updateMayaActor = (id: string, patch: { name?: string; voice_description?: string }) => {
    const fd = new FormData()
    if (patch.name) fd.append('name', patch.name)
    if (patch.voice_description) fd.append('voice_description', patch.voice_description)
    return this.json<MayaActor>(`/tts/maya/actors/${id}`, { method: 'PUT', body: fd })
  }
  deleteMayaActor = (id: string) => this.json<void>(`/tts/maya/actors/${id}`, { method: 'DELETE' })
  ttsHistory = (limit = 100, o?: CallOpts) => this.json<{ entries: TTSHistoryEntry[]; total: number }>(`/tts/history?limit=${limit}`, undefined, o)
  ttsHistoryAudio = (id: string) => this.blob(`/tts/history/${id}/audio`)
  deleteTtsHistoryEntry = (id: string) => this.json<void>(`/tts/history/${id}`, { method: 'DELETE' })
  clearTtsHistory = () => this.json<void>('/tts/history', { method: 'DELETE' })

  // --- actors ---------------------------------------------------------------
  actors = (o?: CallOpts) => this.json<{ actors: Actor[]; total: number }>('/actors', undefined, o)
  createActor = (name: string, files: File[], language: string, description: string) => {
    const fd = new FormData()
    fd.append('name', name)
    fd.append('language', language)
    fd.append('description', description)
    for (const f of files) fd.append('audio_files', f)
    return this.json<Actor>('/actors', { method: 'POST', body: fd })
  }
  createActorFromYoutube = (body: { name: string; youtube_url: string; language?: string; description?: string; max_duration?: number; separate_vocals?: boolean }) =>
    this.json<Actor>('/actors/from-youtube', { method: 'POST', body: JSON.stringify(body) })
  actorAudio = (name: string, o?: CallOpts) => this.json<ActorAudioFile[]>(`/actors/${encodeURIComponent(name)}/audio`, undefined, o)
  addActorAudio = (name: string, file: File) => {
    const fd = new FormData()
    fd.append('audio_file', file)
    return this.json<ActorAudioFile>(`/actors/${encodeURIComponent(name)}/audio`, { method: 'POST', body: fd })
  }
  deleteActorAudio = (name: string, id: string) => this.json<void>(`/actors/${encodeURIComponent(name)}/audio/${id}`, { method: 'DELETE' })
  actorAudioUrl = (name: string, id: string) => this.url(`/actors/${encodeURIComponent(name)}/audio/${id}/download`)
  deleteActor = (name: string) => this.json<void>(`/actors/${encodeURIComponent(name)}`, { method: 'DELETE' })

  // --- music ----------------------------------------------------------------
  musicModels = (o?: CallOpts) => this.json<{ models: { id: string; name: string; loaded: boolean; default_steps: number; estimated_vram_gb: number }[] }>('/music/models', undefined, o)
  music = (body: MusicGenerateRequest) => this.json<{ job_id: string; status: string; estimated_time_seconds: number }>('/music/generate', { method: 'POST', body: JSON.stringify(body) })
  musicStatus = (id: string, o?: CallOpts) => this.json<JobStatus>(`/music/status/${id}`, undefined, o)
  musicProgress = (o?: CallOpts) => this.json<ProgressResponse>('/music/progress', undefined, o)
  musicDownloadUrl = (jobId: string, index: number) => this.url(`/music/download/${jobId}/${index}`)
  deleteMusic = (id: string) => this.json<void>(`/music/${id}`, { method: 'DELETE' })

  // --- video ----------------------------------------------------------------
  videoModels = (o?: CallOpts) => this.json<{ models: { id: string; name: string; loaded: boolean; supports_t2v: boolean; supports_i2v: boolean; estimated_vram_gb: number }[] }>('/video/models', undefined, o)
  video = (kind: 't2v' | 'i2v', model: string, body: VideoGenerateRequest) =>
    this.json<{ job_id: string; status: string; estimated_time_seconds: number }>(`/video/${kind}/${encodeURIComponent(model)}`, { method: 'POST', body: JSON.stringify(body) })
  videoStatus = (id: string, o?: CallOpts) => this.json<JobStatus>(`/video/status/${id}`, undefined, o)
  videoHistory = (limit = 50, offset = 0, o?: CallOpts) => this.json<{ videos: VideoHistoryEntry[]; total: number }>(`/video/history?limit=${limit}&offset=${offset}`, undefined, o)
  deleteVideo = (id: string) => this.json<void>(`/video/${id}`, { method: 'DELETE' })

  // --- 3d -------------------------------------------------------------------
  model3dModels = (o?: CallOpts) => this.json<{ models: { id: string; name: string; loaded: boolean; supports_texture: boolean; estimated_vram_gb: number }[] }>('/model3d/models', undefined, o)
  async model3d(body: Model3DRequest, signal?: AbortSignal): Promise<{ id: string; blob: Blob; refUrl: string | null }> {
    const res = await fetch(this.url('/model3d/generate'), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal,
    })
    if (!res.ok) throw await readError(res)
    const id = res.headers.get('X-Model-Id') ?? 'model'
    const refUrl = res.headers.get('X-Ref-Url')
    return { id, blob: await res.blob(), refUrl }
  }
  model3dList = (limit = 50, o?: CallOpts) => this.json<{ models: Model3DResult[] }>(`/model3d/list?limit=${limit}`, undefined, o)
}
