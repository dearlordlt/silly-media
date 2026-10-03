/** Library — browse, filter, tag, and manage every artifact the app has produced. */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { clsx } from 'clsx'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
  AlertTriangle, CheckSquare, Download, FileArchive, Heart, HeartOff, LayoutGrid, Search, Square, Tag, Tags, Trash2, X,
} from 'lucide-react'
import { downloadItem, itemBlob, itemFilename, library, useLibrary, useLibraryStatus, useLibraryTags } from '../../lib/library'
import type { MediaItem, MediaKind } from '../../lib/library'
import { downloadBlob, formatBytes } from '../../lib/media'
import { createZip } from '../../lib/zip'
import { kv } from '../../lib/kv'
import { toast, errorMessage } from '../../lib/hooks'
import { ArtifactGrid, ArtifactModal } from '../../components/Artifact'
import { TagInput } from '../../components/TagEditor'
import { Button, Chip, EmptyState, IconButton, Input, Segmented, Select, Spinner } from '../../components/ui/primitives'
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

/** Parallel file fetches while building a ZIP. */
const ZIP_FETCH_CONCURRENCY = 4

export function LibraryPage() {
  const all = useLibrary()
  const status = useLibraryStatus()
  const tags = useLibraryTags()
  const navigate = useNavigate()
  const { confirmDeletes } = useApp()
  const [kind, setKind] = useState<'all' | MediaKind>('all')
  const [source, setSource] = useState('all')
  const [query, setQuery] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [untagged, setUntagged] = useState(false)
  const [sort, setSort] = useState<Sort>('new')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [viewId, setViewId] = useState<string | null>(null)
  const anchor = useRef<string | null>(null)
  const [columns, setColumns] = useState(() => {
    const n = Number(kv.getItem(DENSITY_KEY))
    return DENSITY.includes(n) ? n : 6
  })

  useEffect(() => { kv.setItem(DENSITY_KEY, String(columns)) }, [columns])

  // Deep links: /library?q=…&item=… prefill the search / open the viewer.
  const search = useSearch({ strict: false })
  const qParam = 'q' in search && typeof search.q === 'string' ? search.q : undefined
  const itemParam = 'item' in search && typeof search.item === 'string' ? search.item : undefined
  useEffect(() => { if (qParam !== undefined) setQuery(qParam) }, [qParam])
  useEffect(() => { if (itemParam) setViewId(itemParam) }, [itemParam])

  const closeViewer = () => {
    setViewId(null)
    // Drop `item` from the URL so the same link can open it again later.
    if (itemParam) void navigate({ to: '/library', search: qParam ? { q: qParam } : {}, replace: true })
  }

  const sources = useMemo(() => ['all', ...new Set(all.map((i) => i.source))], [all])
  const tagCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of all) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  }, [all])

  // Forget filter tags that no longer exist (removed from every item).
  useEffect(() => {
    setTagFilter((prev) => {
      const next = prev.filter((t) => tagCounts.has(t))
      return next.length === prev.length ? prev : next
    })
  }, [tagCounts])

  const items = useMemo(() => {
    let out = all
    if (kind !== 'all') out = out.filter((i) => i.kind === kind)
    if (source !== 'all') out = out.filter((i) => i.source === source)
    if (favoritesOnly) out = out.filter((i) => i.favorite)
    if (untagged) out = out.filter((i) => !i.tags.length)
    else if (tagFilter.length) out = out.filter((i) => tagFilter.every((t) => i.tags.includes(t)))
    const q = query.trim().toLowerCase()
    if (q) {
      out = out.filter((i) => [i.prompt, i.negativePrompt, i.name, i.model, i.source, ...i.tags]
        .some((f) => (f ?? '').toLowerCase().includes(q)))
    }
    out = [...out]
    if (sort === 'new') out.sort((a, b) => b.createdAt - a.createdAt)
    if (sort === 'old') out.sort((a, b) => a.createdAt - b.createdAt)
    if (sort === 'size') out.sort((a, b) => b.size - a.size)
    return out
  }, [all, kind, source, favoritesOnly, untagged, tagFilter, query, sort])

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
  const totalBytes = items.reduce((n, i) => n + i.size, 0)
  const selectedTags = useMemo(() => {
    const m = new Map<string, number>()
    for (const i of selectedItems) for (const t of i.tags) m.set(t, (m.get(t) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  }, [selectedItems])

  /** Click toggles one; Shift-click applies the anchor's new state to the whole range. */
  const toggleSelect = (item: MediaItem, e?: MouseEvent) => {
    const next = new Set(selected)
    const from = anchor.current ? items.findIndex((i) => i.id === anchor.current) : -1
    const to = items.findIndex((i) => i.id === item.id)
    if (e?.shiftKey && from >= 0 && to >= 0 && from !== to) {
      const on = selected.has(items[from].id)
      for (let k = Math.min(from, to); k <= Math.max(from, to); k++) {
        if (on) next.add(items[k].id); else next.delete(items[k].id)
      }
    } else if (next.has(item.id)) next.delete(item.id)
    else next.add(item.id)
    anchor.current = item.id
    setSelected(next)
  }

  /** Run a bulk operation with a busy label and error toast. */
  const bulk = async (label: string, op: () => Promise<unknown>) => {
    setBusy(label)
    try { await op() } catch (e) { toast.error(`${label} failed`, errorMessage(e)) } finally { setBusy(null) }
  }

  const setFavorite = (favorite: boolean) => bulk(favorite ? 'Favourite' : 'Unfavourite', () =>
    Promise.all(selectedItems.filter((i) => i.favorite !== favorite).map((i) => library.update(i.id, { favorite }))))

  const addTag = (tag: string) => bulk('Add tag', () =>
    Promise.all(selectedItems.filter((i) => !i.tags.includes(tag)).map((i) => library.update(i.id, { tags: [...i.tags, tag] }))))

  const removeTag = (tag: string) => bulk('Remove tag', () =>
    Promise.all(selectedItems.filter((i) => i.tags.includes(tag)).map((i) => library.update(i.id, { tags: i.tags.filter((t) => t !== tag) }))))

  const deleteSelected = async () => {
    if (!selectedItems.length) return
    if (confirmDeletes && !confirm(`Delete ${selectedItems.length} item(s)?`)) return
    await bulk('Delete', async () => {
      await library.removeMany(selectedItems.map((i) => i.id))
      setSelected(new Set())
    })
  }

  const zipSelected = () => bulk('ZIP export', async () => {
    const list = selectedItems
    const blobs: Blob[] = new Array(list.length)
    let fetched = 0
    let cursor = 0
    setBusy(`Fetching 0/${list.length}`)
    await Promise.all(Array.from({ length: Math.min(ZIP_FETCH_CONCURRENCY, list.length) }, async () => {
      while (cursor < list.length) {
        const k = cursor++
        blobs[k] = await itemBlob(list[k])
        setBusy(`Fetching ${++fetched}/${list.length}`)
      }
    }))
    const zip = await createZip(
      list.map((i, k) => ({ name: itemFilename(i), blob: blobs[k], date: new Date(i.createdAt) })),
      (done, total) => setBusy(`Zipping ${Math.round((done / total) * 100)}%`),
    )
    downloadBlob(zip, `silly-media-${list.length}-items.zip`)
  })

  const toggleTagFilter = (t: string) => {
    setUntagged(false)
    setTagFilter((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  const viewing = viewId ? all.find((i) => i.id === viewId) ?? null : null
  const filtered = kind !== 'all' || source !== 'all' || favoritesOnly || untagged || tagFilter.length > 0 || query.trim() !== ''

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line bg-panel/50 px-5 py-3">
        <Segmented value={kind} onChange={setKind} options={KIND_TABS} />
        <div className="relative w-64">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts, names, models, tags…" className="pl-9" />
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
          <span className="tabular-nums">
            {filtered ? `${items.length} of ${all.length}` : items.length} item{items.length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
          </span>
        </div>
      </div>

      {tags.length > 0 && (
        <div className="flex items-center gap-1.5 overflow-x-auto border-b border-line px-5 py-2">
          <Tags size={13} className="shrink-0 text-ink-faint" />
          <Chip active={untagged} onClick={() => { setUntagged((v) => !v); setTagFilter([]) }} title="Items without any tag">Untagged</Chip>
          {tags.map((t) => (
            <Chip key={t} active={tagFilter.includes(t)} onClick={() => toggleTagFilter(t)} title={tagFilter.length ? 'Items must have every selected tag' : undefined}>
              {t} <span className="text-ink-faint">{tagCounts.get(t)}</span>
            </Chip>
          ))}
          {(untagged || tagFilter.length > 0) && (
            <button className="ml-1 shrink-0 text-[11.5px] text-ink-faint hover:text-ink" onClick={() => { setUntagged(false); setTagFilter([]) }}>Clear</button>
          )}
        </div>
      )}

      {selectedItems.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent/5 px-5 py-2">
          <span className="text-[12.5px] text-ink">{selectedItems.length} selected</span>
          <Button variant="ghost" size="sm" icon={<Heart size={14} />} disabled={!!busy} onClick={() => void setFavorite(true)}>Favourite</Button>
          <Button variant="ghost" size="sm" icon={<HeartOff size={14} />} disabled={!!busy} onClick={() => void setFavorite(false)}>Unfavourite</Button>
          <BulkMenu label="Add tag" icon={<Tag size={14} />} disabled={!!busy}>
            {(close) => (
              <TagInput
                autoFocus
                placeholder="Tag to add…"
                exclude={selectedTags.filter(([, n]) => n === selectedItems.length).map(([t]) => t)}
                onAdd={(t) => { close(); void addTag(t) }}
                className="w-56"
              />
            )}
          </BulkMenu>
          <BulkMenu label="Remove tag" icon={<X size={14} />} disabled={!!busy || !selectedTags.length}>
            {(close) => (
              <div className="flex w-56 flex-col py-1">
                {selectedTags.map(([t, n]) => (
                  <button
                    key={t}
                    onClick={() => { close(); void removeTag(t) }}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left text-[12px] text-ink-dim hover:bg-panel-3 hover:text-ink"
                  >
                    <span className="truncate">{t}</span>
                    <span className="shrink-0 text-[11px] text-ink-faint">{n}/{selectedItems.length}</span>
                  </button>
                ))}
              </div>
            )}
          </BulkMenu>
          <Button variant="ghost" size="sm" icon={<FileArchive size={14} />} loading={busy != null && /^(Fetching|Zipping)/.test(busy)} disabled={!!busy} onClick={() => void zipSelected()}>
            {busy && /^(Fetching|Zipping)/.test(busy) ? busy : 'Download ZIP'}
          </Button>
          <Button variant="ghost" size="sm" icon={<Download size={14} />} disabled={!!busy} onClick={() => selectedItems.forEach((i) => downloadItem(i))}>
            Download files
          </Button>
          <Button variant="danger" size="sm" icon={<Trash2 size={14} />} disabled={!!busy} onClick={() => void deleteSelected()}>Delete</Button>
          {busy && !/^(Fetching|Zipping)/.test(busy) && <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-faint"><Spinner /> {busy}…</span>}
          <IconButton className="ml-auto" onClick={() => setSelected(new Set())} title="Clear selection"><X size={14} /></IconButton>
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
            <div className="mb-3 flex items-center gap-3">
              <button
                className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-dim hover:text-ink"
                onClick={() => setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))}
              >
                {allSelected ? <CheckSquare size={13} /> : <Square size={13} />} Select all
              </button>
              <span className="text-[11px] text-ink-faint">Shift-click to select a range · drag images onto any image input</span>
            </div>
            <ArtifactGrid
              items={items}
              columns={columns}
              selected={selected}
              onToggleSelect={toggleSelect}
              onOpen={(i) => setViewId(i.id)}
            />
          </>
        )}
      </div>

      <ArtifactModal item={viewing} items={items} onSelect={(i) => setViewId(i.id)} onClose={closeViewer} />
    </div>
  )
}

/** Toolbar button with a small popover (closes on outside click / Escape). */
function BulkMenu({ label, icon, disabled, children }: {
  label: string
  icon: ReactNode
  disabled?: boolean
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <Button variant="ghost" size="sm" icon={icon} disabled={disabled} onClick={() => setOpen((v) => !v)}>{label}</Button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 rounded-lg border border-line bg-panel-2 p-1.5 shadow-2xl">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
