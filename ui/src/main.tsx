import { createRoot } from 'react-dom/client'
import { loadAppInfo } from './lib/appApi'
import { hydrateKv } from './lib/kv'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('#root missing')
const root = createRoot(el)

/**
 * Settings live in the app server's per-profile store and are read
 * synchronously by stores/pages at module load, so they must be hydrated
 * before anything that uses them is even imported.
 */
async function boot() {
  try {
    await Promise.all([loadAppInfo(), hydrateKv()])
  } catch (e) {
    root.render(<BootError message={e instanceof Error ? e.message : String(e)} />)
    return
  }
  const { initLibrary } = await import('./lib/library')
  void initLibrary()
  const { App } = await import('./App')
  root.render(<App />)
}

function BootError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg p-8 text-center text-ink">
      <div className="text-lg font-semibold">Local app server not reachable</div>
      <p className="max-w-md text-[13px] text-ink-dim">
        The library and settings are stored by the Silly Media UI server. Start the UI with <code className="rounded bg-panel-2 px-1.5 py-0.5">./ui.sh</code> instead of opening the files directly.
      </p>
      <p className="font-mono text-[11.5px] text-ink-faint">{message}</p>
      <button className="mt-2 rounded-lg border border-line px-3 py-1.5 text-[12.5px] hover:bg-panel-2" onClick={() => location.reload()}>Retry</button>
    </div>
  )
}

void boot()
