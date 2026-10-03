/** Library — browse, filter, and manage every artifact the app has produced. */
import { useEffect, useMemo, useState } from 'react'
import { clsx } from 'clsx'
import { AlertTriangle, CheckSquare, Download, FileArchive, Heart, LayoutGrid, Search, Square, Trash2, X } from 'lucide-react'
import { itemFilename, library, useLibrary, useLibraryStatus, type MediaKind } from '../../lib/library'
import { downloadBlob, formatBytes } from '../../lib/media'
import { createZip } from '../../lib/zip'
import { toast, errorMessage } from '../../lib/hooks'
import { ArtifactGrid } from '../../components/Artifact'
import { Button, EmptyState, IconButton, Input, Segmented, Select, Spinner } from '../../components/ui/primitives'
import { useApp } from '../../lib/store'

const KIND_TABS: { value: 'all' | MediaKind; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'image', label: 'Images' },
  { value: 'audio', label: 'Audio' },
  { value: 'video', label: 'Video' },
  { value: 'model3d', label: '3D' },
]

type Sort = 'new' | 'old' | 'size'
const isSort = (v: string): v is Sort => v === 'new' || v === 'old' || v === 'size'

/** Tiles-per-row presets for the density control. */
const DENSITY = [3, 4, 6, 8]
const DENSITY_KEY = 'silly-library-density'

export function LibraryPage() {
  const all = useLibrary()
  const status = useLibraryStatus()
  const { confirmDeletes } = useApp()
  const [kind, setKind] = useState<'all' | MediaKind>('all')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('new')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [zipping, setZipping] = useState<string | null>(null)
  const [columns, setColumns] = useState(() => {
    const n = Number(localStorage.getItem(DENSITY_KEY))
    return DENSITY.includes(n) ? n : 6
  })

  useEffect(() => { localStorage.setItem(DENSITY_KEY, String(columns)) }, [columns])

  const sources = useMemo(() => ['all', ...new Set(all.map((i) => i.source))], [all])

  const items = useMemo(() => {
    let out = all
    if (kind !== 'all') out = out.filter((i) => i.kind === kind)
    if (source !== 'all') out = out.filter((i) => i.source === source)
    if (favoritesOnly) out = out.filter((i) => i.favorite)
    const q = query.trim().toLowerCase()
    if (q) {
      out = out.filter((i) => [i.prompt, i.negativePrompt, i.name, i.model, i.source]
        .some((f) => (f ?? '').toLowerCase().includes(q)))
    }
    out = [...out]
    if (sort === 'new') out.sort((a, b) => b.createdAt - a.createdAt)
    if (sort === 'old') out.sort((a, b) => a.createdAt - b.createdAt)
    if (sort === 'size') out.sort((a, b) => b.blob.size - a.blob.size)
    return out
  }, [all, kind, source, favoritesOnly, query, sort])

  // Bulk actions only ever touch what is visible: drop selections the filters hide
  // (or that were deleted elsewhere).
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(items.map((i) => i.id))
      const next = new Set([...prev].filter((id) => visible.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [items])

  const selectedItems = useMemo(() => items.filter((i) => selected.has(i.id)), [items, selected])
  const allSelected = items.length > 0 && selectedItems.length === items.length
  const totalBytes = items.reduce((n, i) => n + i.blob.size, 0)

  const toggleSelect = (id: string) => setSelected((prev) => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id); else n.add(id)
    return n
  })

  const deleteSelected = async () => {
    if (!selectedItems.length) return
    if (confirmDeletes && !confirm(`Delete ${selectedItems.length} item(s)?`)) return
    await Promise.all(selectedItems.map((i) => library.remove(i.id)))
    setSelected(new Set())
  }

  const zipSelected = async () => {
    if (!selectedItems.length) return
    setZipping('0%')
    try {
      const zip = await createZip(
        selectedItems.map((i) => ({ name: itemFilename(i), blob: i.blob, date: new Date(i.createdAt) })),
        (done, total) => setZipping(`${Math.round((done / total) * 100)}%`),
      )
      downloadBlob(zip, `silly-media-${selectedItems.length}-items.zip`)
    } catch (e) {
      toast.error('ZIP export failed', errorMessage(e))
    } finally {
      setZipping(null)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/50 px-5 py-3">
        <Segmented value={kind} onChange={setKind} options={KIND_TABS} />
        <div className="relative w-64">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts, names, models…" className="pl-9" />
        </div>
        <div className="w-40">
          <Select value={source} onChange={(e) => setSource(e.target.value)}>
            {sources.map((s) => <option key={s} value={s}>{s === 'all' ? 'All sources' : s}</option>)}
          </Select>
        </div>
        <div className="w-32">
          <Select value={sort} onChange={(e) => { if (isSort(e.target.value)) setSort(e.target.value) }}>
            <option value="new">Newest</option>
            <option value="old">Oldest</option>
            <option value="size">Largest</option>
          </Select>
        </div>
        <button
          onClick={() => setFavoritesOnly((v) => !v)}
          className={clsx('inline-flex h-9 items-center gap-1.5 rounded-[10px] border px-3 text-[12.5px]',
            favoritesOnly ? 'border-warn/40 bg-warn/10 text-warn' : 'border-line text-ink-dim hover:text-ink')}
        >
          <Heart size={13} className={clsx(favoritesOnly && 'fill-warn')} /> Favourites
        </button>

        <div className="ml-auto flex items-center gap-3 text-[11.5px] text-ink-faint">
          <span className="inline-flex items-center gap-1.5" title="Tiles per row">
            <LayoutGrid size={13} />
            {DENSITY.map((n) => (
              <button
                key={n}
                onClick={() => setColumns(n)}
                className={clsx('rounded px-1.5 py-0.5', columns === n ? 'bg-accent/20 text-ink' : 'hover:text-ink')}
              >{n}</button>
            ))}
          </span>
          <span>{items.length} items · {formatBytes(totalBytes)}</span>
        </div>
      </div>

      {selectedItems.length > 0 && (
        <div className="flex items-center gap-2 border-b border-line bg-accent/5 px-5 py-2">
          <span className="text-[12.5px] text-ink">{selectedItems.length} selected</span>
          <Button variant="ghost" size="sm" icon={<FileArchive size={14} />} loading={!!zipping} onClick={() => void zipSelected()}>
            {zipping ? `Zipping ${zipping}` : 'Download ZIP'}
          </Button>
          <Button variant="ghost" size="sm" icon={<Download size={14} />} onClick={() => selectedItems.forEach((i) => downloadBlob(i.blob, itemFilename(i)))}>
            Download files
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} onClick={() => void deleteSelected()}>Delete</Button>
          <IconButton onClick={() => setSelected(new Set())} title="Clear selection"><X size={14} /></IconButton>
        </div>
      )}

      <div className="scroll-area flex-1 p-5">
        {status.state === 'loading' ? (
          <div className="flex items-center justify-center gap-2 py-16 text-[12.5px] text-ink-dim"><Spinner /> Loading library…</div>
        ) : status.state === 'error' ? (
          <EmptyState icon={<AlertTriangle size={22} />} title="Couldn't open the local library" detail={status.message} />
        ) : !items.length ? (
          <EmptyState
            title={all.length ? 'Nothing matches these filters' : 'Your library is empty'}
            detail={all.length ? 'Clear the search or filters to see everything.' : 'Generate something in Studio, Edit, or one of the media pages.'}
          />
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <button
                className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-dim hover:text-ink"
                onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
              >
                {allSelected ? <CheckSquare size={13} /> : <Square size={13} />} Select all
              </button>
            </div>
            <ArtifactGrid
              items={items}
              columns={columns}
              selected={selected}
              onToggleSelect={(i) => toggleSelect(i.id)}
              extraActions={(i) => (
                <IconButton onClick={() => downloadBlob(i.blob, itemFilename(i))} title="Download"><Download size={14} /></IconButton>
              )}
            />
          </>
        )}
      </div>
    </div>
  )
}
