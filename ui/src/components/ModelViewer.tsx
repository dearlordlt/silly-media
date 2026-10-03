/**
 * Shared <model-viewer> support: one-time CDN load, JSX typing, an interactive
 * viewer component, and a serialized GLB → poster renderer for thumbnails.
 *
 * Posters exist because browsers cap live WebGL contexts (~16): a grid of
 * GLBs can't each run a viewer, so every model is rendered once off-screen
 * and the captured image is stored with the library item.
 */
import { useEffect, useState } from 'react'
import type { CSSProperties, DetailedHTMLProps, HTMLAttributes } from 'react'
import { clsx } from 'clsx'
import { RotateCcw } from 'lucide-react'

const MODEL_VIEWER_SRC = 'https://unpkg.com/@google/model-viewer@4/dist/model-viewer.min.js'
const LOAD_TIMEOUT_MS = 8000

type ModelViewerAttributes = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  src?: string
  alt?: string
  poster?: string
  exposure?: number | string
  'camera-controls'?: boolean
  'auto-rotate'?: boolean
  'auto-rotate-delay'?: number | string
  'rotation-per-second'?: string
  'shadow-intensity'?: number | string
  'environment-image'?: string
  'touch-action'?: string
  'camera-orbit'?: string
  'min-camera-orbit'?: string
  'max-camera-orbit'?: string
  'interaction-prompt'?: string
  ar?: boolean
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'model-viewer': ModelViewerAttributes
    }
  }
}

/* ----------------------------------------------------------------- loading */

let loadPromise: Promise<boolean> | null = null

/** Inject the model-viewer module once; resolves false if it can't load. */
export function loadModelViewer(): Promise<boolean> {
  if (loadPromise) return loadPromise
  loadPromise = new Promise<boolean>((resolve) => {
    if (typeof document === 'undefined') { resolve(false); return }
    if (customElements.get('model-viewer')) { resolve(true); return }
    let script = document.querySelector<HTMLScriptElement>('script[data-model-viewer]')
    if (!script) {
      script = document.createElement('script')
      script.type = 'module'
      script.src = MODEL_VIEWER_SRC
      script.dataset.modelViewer = 'true'
      document.head.appendChild(script)
    }
    const timer = window.setTimeout(() => resolve(!!customElements.get('model-viewer')), LOAD_TIMEOUT_MS)
    script.addEventListener('error', () => { window.clearTimeout(timer); resolve(false) }, { once: true })
    void customElements.whenDefined('model-viewer').then(() => { window.clearTimeout(timer); resolve(true) })
  })
  return loadPromise
}

export type ViewerState = 'loading' | 'ready' | 'failed'

export function useModelViewer(): ViewerState {
  const [state, setState] = useState<ViewerState>(() => (customElements.get('model-viewer') ? 'ready' : 'loading'))
  useEffect(() => {
    let alive = true
    void loadModelViewer().then((ok) => { if (alive) setState(ok ? 'ready' : 'failed') })
    return () => { alive = false }
  }, [])
  return state
}

/* --------------------------------------------------------- interactive view */

const BACKGROUNDS = { dark: '#0d1117', grey: '#3a3f4b', light: '#e9e9ee' } as const
type Background = keyof typeof BACKGROUNDS

/**
 * Full interactive viewer: drag to orbit, scroll to zoom, right-drag to pan.
 * `toolbar` adds the 3D page's viewer controls (auto-rotate, exposure,
 * background, reset view).
 */
export function ModelViewer({ src, autoRotate: initialRotate = true, exposure: initialExposure = 1, toolbar, className, style }: {
  src: string
  autoRotate?: boolean
  exposure?: number
  toolbar?: boolean
  className?: string
  style?: CSSProperties
}) {
  const state = useModelViewer()
  const [autoRotate, setAutoRotate] = useState(initialRotate)
  const [exposure, setExposure] = useState(initialExposure)
  const [bg, setBg] = useState<Background>('dark')
  // Remounting the element is the simplest exact "reset camera" there is.
  const [viewKey, setViewKey] = useState(0)

  if (state === 'failed') {
    return (
      <div className={className} style={style}>
        <div className="grid h-full place-items-center p-6 text-center text-[12.5px] text-ink-faint">
          3D viewer couldn't load (CDN blocked?). Download the .glb to inspect it.
        </div>
      </div>
    )
  }
  if (state === 'loading') {
    return <div className={className} style={style}><div className="grid h-full place-items-center text-[12px] text-ink-faint">Loading 3D viewer…</div></div>
  }

  const viewer = (
    <model-viewer
      key={viewKey}
      src={src}
      alt="3D model"
      camera-controls
      {...(autoRotate ? { 'auto-rotate': true } : {})}
      auto-rotate-delay={1500}
      rotation-per-second="24deg"
      shadow-intensity="1"
      exposure={exposure}
      environment-image="neutral"
      interaction-prompt="none"
      touch-action="pan-y"
      // React 18 sets `className` on custom elements as a literal "classname"
      // attribute, so size the element with inline style only.
      style={toolbar
        ? { width: '100%', flex: '1 1 0%', minHeight: 0, backgroundColor: BACKGROUNDS[bg] }
        : { width: '100%', height: '100%', backgroundColor: 'transparent' }}
    />
  )
  if (!toolbar) return <div className={className} style={style}>{viewer}</div>

  return (
    <div className={clsx('flex flex-col overflow-hidden rounded-lg', className)} style={style}>
      {viewer}
      <div className="flex items-center gap-4 whitespace-nowrap border-t border-line bg-panel px-3 py-2 text-[11.5px] text-ink-dim">
        <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={autoRotate} onChange={(e) => setAutoRotate(e.target.checked)} className="accent-[var(--color-accent)]" />
          Auto-rotate
        </label>
        <label className="inline-flex shrink-0 items-center gap-2">
          Exposure
          <input type="range" min={0.2} max={2.5} step={0.1} value={exposure} onChange={(e) => setExposure(Number(e.target.value))} className="h-1.5 w-28 cursor-pointer appearance-none rounded-full bg-line-strong" />
          <span className="w-6 tabular-nums">{exposure.toFixed(1)}</span>
        </label>
        <span className="inline-flex shrink-0 items-center gap-1">
          {(Object.keys(BACKGROUNDS) as Background[]).map((b) => (
            <button
              key={b}
              onClick={() => setBg(b)}
              title={`${b} background`}
              className={clsx('h-4 w-4 rounded border', bg === b ? 'border-accent ring-1 ring-accent' : 'border-line-strong')}
              style={{ backgroundColor: BACKGROUNDS[b] }}
            />
          ))}
        </span>
        <button
          onClick={() => setViewKey((k) => k + 1)}
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-panel-2 hover:text-ink"
        >
          <RotateCcw size={12} /> Reset view
        </button>
        <span className="ml-auto min-w-0 truncate text-ink-faint" title="Drag to orbit · scroll to zoom · right-drag to pan">Drag to orbit · scroll to zoom · right-drag to pan</span>
      </div>
    </div>
  )
}

/* --------------------------------------------------------- poster rendering */

const POSTER_SIZE = 384
let queue: Promise<unknown> = Promise.resolve()

function hasToBlob(el: Element): el is Element & { toBlob: (o: { mimeType: string; idealAspect: boolean }) => Promise<Blob> } {
  return 'toBlob' in el && typeof el.toBlob === 'function'
}

function nextFrames(n: number): Promise<void> {
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)))
    step(n)
  })
}

async function renderOnce(url: string): Promise<Blob | null> {
  if (!(await loadModelViewer())) return null
  const el = document.createElement('model-viewer')
  el.setAttribute('src', url)
  el.setAttribute('environment-image', 'neutral')
  el.setAttribute('shadow-intensity', '1')
  el.setAttribute('exposure', '1')
  el.setAttribute('interaction-prompt', 'none')
  el.setAttribute('camera-orbit', '30deg 75deg auto')
  // Must intersect the viewport or model-viewer skips rendering; opacity 0 hides it.
  Object.assign(el.style, {
    position: 'fixed', left: '0', top: '0', width: `${POSTER_SIZE}px`, height: `${POSTER_SIZE}px`,
    opacity: '0', pointerEvents: 'none', zIndex: '-1', backgroundColor: 'transparent',
  })
  try {
    const loaded = new Promise<boolean>((resolve) => {
      el.addEventListener('load', () => resolve(true), { once: true })
      el.addEventListener('error', () => resolve(false), { once: true })
      window.setTimeout(() => resolve(false), 20000)
    })
    document.body.appendChild(el)
    if (!(await loaded) || !hasToBlob(el)) return null
    await nextFrames(3) // let the first frame (textures, shadow) settle
    return await el.toBlob({ mimeType: 'image/png', idealAspect: false })
  } catch {
    return null
  } finally {
    el.remove()
  }
}

/** Render a GLB (object/blob URL) to a PNG poster; calls are serialized. */
export function renderGlbPoster(url: string): Promise<Blob | null> {
  const job = queue.then(() => renderOnce(url))
  queue = job.catch(() => null)
  return job
}
