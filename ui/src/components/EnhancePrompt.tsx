/**
 * "Enhance prompt": rewrites a short idea into a detailed prompt with the local
 * chat model. Runs through the GPU job queue (the LLM swaps into VRAM, so it
 * must not race a generation) and offers a one-click undo.
 */
import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { Loader2, Undo2, WandSparkles } from 'lucide-react'
import { useClient, toast } from '../lib/hooks'
import { jobs, useJob } from '../lib/jobs'
import type { JobPage } from '../lib/jobs'

export type EnhanceKind = 'image' | 'edit' | 'video' | 'music' | '3d'

const SYSTEM: Record<EnhanceKind, string> = {
  image: 'You turn short ideas into detailed text-to-image prompts covering subject, setting, composition, lighting, style and camera. Keep every concrete detail the user gave. Reply with the prompt only, as a single paragraph under 120 words.',
  edit: 'You rewrite image-editing instructions to be precise and unambiguous: say what to change, where, and what must stay the same. Reply with the instruction only, one or two sentences.',
  video: 'You turn short ideas into prompts for a text/image-to-video model: describe the subject, the motion over time, camera movement, lighting and mood in present tense. Keep every concrete detail the user gave. Reply with the prompt only, as a single paragraph under 100 words.',
  music: 'You turn short ideas into music-generation style tags: comma-separated genre, sub-genre, mood, instruments, vocal type, tempo (BPM) and production descriptors. Keep every concrete detail the user gave. Reply with the tags only, on one line.',
  '3d': 'You turn short ideas into prompts for a reference image used for image-to-3D: a single isolated subject, full view, neutral pose, plain background, clear silhouette, materials and colours. Keep every concrete detail the user gave. Reply with the prompt only, as a single paragraph under 80 words.',
}

const PAGE: Record<EnhanceKind, JobPage> = { image: 'studio', edit: 'edit', video: 'video', music: 'music', '3d': '3d' }

/** Strip thinking blocks, wrapping quotes and "Prompt:" style prefixes. */
function clean(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim()
    .replace(/^(?:enhanced\s+)?(?:prompt|instruction|tags)\s*:\s*/i, '')
    .replace(/^["'“”`]+|["'“”`]+$/g, '')
    .trim()
}

export function EnhancePrompt({ value, onChange, kind, className }: {
  value: string
  onChange: (next: string) => void
  kind: EnhanceKind
  className?: string
}) {
  const client = useClient()
  const [jobId, setJobId] = useState<string | null>(null)
  const [undo, setUndo] = useState<string | null>(null)
  const job = useJob(jobId)
  const before = useRef('')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!job || job.state === 'queued' || job.state === 'running') return
    setJobId(null)
    if (job.state === 'failed') toast.error('Enhance failed', job.error)
    const data = job.data
    if (job.state === 'done' && data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' && data.text) {
      setUndo(before.current)
      onChangeRef.current(data.text)
    }
  }, [job])

  const busy = jobId != null
  const start = () => {
    const idea = value.trim()
    if (!idea) { toast.info('Write a short idea first', 'Enhance expands it into a detailed prompt.'); return }
    before.current = value
    setUndo(null)
    setJobId(jobs.enqueue({
      page: PAGE[kind],
      label: 'Enhance prompt',
      detail: idea.slice(0, 80),
      run: async (ctx) => {
        ctx.report({ message: 'Asking the chat model…' })
        const res = await client.llm({
          messages: [{ role: 'system', content: SYSTEM[kind] }, { role: 'user', content: idea }],
          temperature: 0.7,
          max_tokens: 400,
          enable_thinking: false,
        }, ctx.signal)
        ctx.setData({ text: clean(res.text) })
      },
    }))
  }

  return (
    <span className={clsx('inline-flex items-center gap-0.5', className)}>
      <button
        type="button"
        onClick={busy ? () => jobId && jobs.cancel(jobId) : start}
        title={busy ? 'Cancel' : 'Enhance with the local chat model (swaps the GPU model; the next generation reloads its model)'}
        className={clsx(
          'inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium transition-colors',
          busy ? 'text-accent' : 'text-ink-dim hover:bg-panel-2 hover:text-ink',
        )}
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <WandSparkles size={13} />}
        {busy ? (job?.state === 'queued' ? 'Waiting…' : 'Enhancing…') : 'Enhance'}
      </button>
      {undo != null && !busy && (
        <button
          type="button"
          onClick={() => { onChange(undo); setUndo(null) }}
          title="Restore the text before enhancing"
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-ink-faint hover:bg-panel-2 hover:text-ink"
        >
          <Undo2 size={12} /> Undo
        </button>
      )}
    </span>
  )
}
