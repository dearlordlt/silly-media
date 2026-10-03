/**
 * Progressive playback of `/tts/stream` + `/tts/maya/stream` (transport lives in
 * SillyClient.speechStream; this module decodes and schedules the audio).
 *
 * Stream wire format (verified in src/silly_media/audio/{xtts,maya}.py):
 * - XTTS yields one complete RIFF/WAV file per inference chunk, concatenated.
 * - Maya yields a single WAV file split into raw byte slices.
 * Both are handled by framing on the RIFF size field, decoding each complete
 * WAV and scheduling it gap-free on an AudioContext.
 */
import type { SillyClient } from '../../lib/api'
import type { MayaTTSRequest, TTSRequest } from '../../lib/types'

/** Encode decoded buffers back into one 16-bit PCM WAV. */
export function encodeWav(buffers: AudioBuffer[], sampleRate: number): Blob {
  const channels = buffers.reduce((n, b) => Math.max(n, b.numberOfChannels), 1)
  const frames = buffers.reduce((n, b) => n + b.length, 0)
  const dataBytes = frames * channels * 2
  const out = new DataView(new ArrayBuffer(44 + dataBytes))
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out.setUint8(offset + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  out.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  out.setUint32(16, 16, true)
  out.setUint16(20, 1, true)
  out.setUint16(22, channels, true)
  out.setUint32(24, sampleRate, true)
  out.setUint32(28, sampleRate * channels * 2, true)
  out.setUint16(32, channels * 2, true)
  out.setUint16(34, 16, true)
  ascii(36, 'data')
  out.setUint32(40, dataBytes, true)
  let offset = 44
  for (const b of buffers) {
    const data = Array.from({ length: channels }, (_, c) => b.getChannelData(Math.min(c, b.numberOfChannels - 1)))
    for (let i = 0; i < b.length; i++) {
      for (let c = 0; c < channels; c++) {
        const s = Math.max(-1, Math.min(1, data[c][i]))
        out.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true)
        offset += 2
      }
    }
  }
  return new Blob([out.buffer], { type: 'audio/wav' })
}

export interface StreamStats {
  chunks: number
  /** ms from request start until the first audio was scheduled. */
  firstAudioMs: number | null
  /** Seconds of audio received so far. */
  seconds: number
}

export interface StreamResult extends StreamStats {
  blob: Blob
}

/**
 * Stream speech from `/tts/stream` or `/tts/maya/stream`, playing audio as it
 * arrives. Resolves with the full recording once the stream ends.
 * Aborting `signal` stops both the download and playback.
 */
export async function streamSpeech(
  client: SillyClient,
  request: { engine: 'xtts-v2'; body: TTSRequest } | { engine: 'maya'; body: MayaTTSRequest },
  opts: { signal: AbortSignal; onProgress: (s: StreamStats) => void },
): Promise<StreamResult> {
  const started = performance.now()
  const res = await client.speechStream(request.engine, request.body, opts.signal)
  if (!res.body) throw new Error('Streaming is not supported by this browser')

  const ctx = new AudioContext()
  void ctx.resume()
  const stopPlayback = () => { if (ctx.state !== 'closed') void ctx.close().catch(() => undefined) }
  opts.signal.addEventListener('abort', stopPlayback, { once: true })

  const decoded: AudioBuffer[] = []
  const stats: StreamStats = { chunks: 0, firstAudioMs: null, seconds: 0 }
  let nextStart = 0

  const play = async (wav: Uint8Array) => {
    // decodeAudioData detaches its input, so hand it a private copy.
    const copy = new Uint8Array(wav.length)
    copy.set(wav)
    const buffer = await ctx.decodeAudioData(copy.buffer)
    decoded.push(buffer)
    if (ctx.state !== 'closed') {
      const src = ctx.createBufferSource()
      src.buffer = buffer
      src.connect(ctx.destination)
      nextStart = Math.max(nextStart, ctx.currentTime + 0.05)
      src.start(nextStart)
      nextStart += buffer.duration
    }
    stats.chunks += 1
    stats.seconds += buffer.duration
    if (stats.firstAudioMs === null) stats.firstAudioMs = performance.now() - started
    opts.onProgress({ ...stats })
  }

  const reader = res.body.getReader()
  let pending: Uint8Array = new Uint8Array(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const merged = new Uint8Array(pending.length + value.length)
      merged.set(pending, 0)
      merged.set(value, pending.length)
      pending = merged
      // Extract every complete RIFF file ("RIFF" magic + LE size) currently buffered.
      while (pending.length >= 8 && pending[0] === 0x52 && pending[1] === 0x49 && pending[2] === 0x46 && pending[3] === 0x46) {
        const size = new DataView(pending.buffer, pending.byteOffset, 8).getUint32(4, true) + 8
        if (size <= 8 || pending.length < size) break
        await play(pending.subarray(0, size))
        pending = pending.slice(size)
      }
    }
    // Unframed remainder (unknown RIFF size or non-WAV bytes): decode in one go.
    if (pending.length) await play(pending)
  } catch (e) {
    stopPlayback()
    throw e
  } finally {
    opts.signal.removeEventListener('abort', stopPlayback)
  }
  if (!decoded.length) {
    stopPlayback()
    throw new Error('The stream returned no audio')
  }

  const blob = encodeWav(decoded, decoded[0].sampleRate)
  // Release the context once the scheduled audio has finished playing.
  const remaining = Math.max(0, nextStart - (ctx.state === 'closed' ? 0 : ctx.currentTime))
  window.setTimeout(stopPlayback, remaining * 1000 + 250)
  opts.signal.addEventListener('abort', stopPlayback, { once: true })
  return { ...stats, blob }
}
