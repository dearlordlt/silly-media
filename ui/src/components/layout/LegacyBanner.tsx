/**
 * Offers the one-time import of the pre-app-server browser storage (old
 * IndexedDB library + localStorage settings) into the current profile.
 */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { DatabaseBackup, X } from 'lucide-react'
import { dismissLegacy, importLegacy, useLegacyImport } from '../../lib/legacyImport'
import { errorMessage, toast } from '../../lib/hooks'
import { Button, ProgressBar } from '../ui/primitives'

export function LegacyBanner() {
  const { summary, refresh } = useLegacyImport()
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [hidden, setHidden] = useState(false)

  if (hidden || !summary || summary.imported || summary.dismissed || (summary.items === 0 && summary.keys === 0)) return null
  const busy = progress != null

  const runImport = async () => {
    setProgress({ done: 0, total: summary.items })
    try {
      const r = await importLegacy((done, total) => setProgress({ done, total }))
      toast.success(
        `Imported ${r.imported} item${r.imported === 1 ? '' : 's'}`,
        [r.skipped ? `${r.skipped} already present` : null, r.keys ? `${r.keys} setting${r.keys === 1 ? '' : 's'} restored` : null].filter(Boolean).join(' · ') || undefined,
      )
      refresh()
    } catch (e) {
      toast.error('Import failed', errorMessage(e))
    } finally {
      setProgress(null)
    }
  }

  const found = [
    summary.items ? `${summary.items} item${summary.items === 1 ? '' : 's'}` : null,
    summary.keys ? `${summary.keys} setting${summary.keys === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' and ')

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-accent/25 bg-accent/[0.07] px-5 py-2.5">
      <DatabaseBackup size={16} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[12.5px] font-medium text-ink">Found {found} from the old browser storage</div>
        {busy ? (
          <div className="mt-1 flex items-center gap-2">
            <ProgressBar value={progress.total ? (progress.done / progress.total) * 100 : 0} className="max-w-[320px]" />
            <span className="text-[11px] text-ink-dim">{progress.done}/{progress.total}</span>
          </div>
        ) : (
          <div className="text-[11.5px] text-ink-faint">Copy them into this profile so they show up in the library. The old copy is left untouched.</div>
        )}
      </div>
      <Button size="sm" variant="primary" loading={busy} onClick={() => void runImport()}>Import</Button>
      <Link to="/system" className="text-[12px] text-ink-dim hover:text-ink">Details</Link>
      <button
        onClick={() => { dismissLegacy(); setHidden(true); refresh() }}
        disabled={busy}
        title="Dismiss (import later from System)"
        className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-panel-2 hover:text-ink disabled:opacity-40"
      >
        <X size={14} />
      </button>
    </div>
  )
}
