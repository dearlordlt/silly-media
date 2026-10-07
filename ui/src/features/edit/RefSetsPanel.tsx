/** Edit page panel for reference sets (see refSets.ts). */
import { useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { clsx } from 'clsx'
import { Check, Layers, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { useLibrary } from '../../lib/library'
import { droppedItem, isItemDrag } from '../../lib/drag'
import { toast, errorMessage } from '../../lib/hooks'
import { useApp } from '../../lib/store'
import { useClipboardImage } from '../../components/ImageDrop'
import { Button, Chip, IconButton, Input, Section, Switch } from '../../components/ui/primitives'
import { REF_KINDS, labelFromFilename, refSets, undressesFirst, useActiveRefSet, useRefSets } from './refSets'
import type { RefSet } from './refSets'

export function RefSetsPanel({ enabled, onUseQwen21, manualRefs }: {
  /** Reference images only work on qwen-image-2.1. */
  enabled: boolean
  onUseQwen21: () => void
  /** Manual reference images, which follow the set image as image 3, 4, … */
  manualRefs: number
}) {
  const sets = useRefSets()
  const active = useActiveRefSet()
  const [menu, setMenu] = useState(false)

  return (
    <Section
      title={<span className="inline-flex items-center gap-1.5"><Layers size={14} className="text-accent-2" /> Reference sets</span>}
      action={
        <div className="relative">
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setMenu((m) => !m)}>New set</Button>
          {menu && (
            <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-xl border border-line bg-panel-2 p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              {REF_KINDS.map((k) => (
                <button
                  key={k.id}
                  className="block w-full rounded-lg px-2.5 py-1.5 text-left text-[12.5px] text-ink-dim hover:bg-panel-3 hover:text-ink"
                  onClick={() => { refSets.create(k.id); setMenu(false) }}
                >{k.label}</button>
              ))}
            </div>
          )}
        </div>
      }
    >
      {!enabled ? (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-panel-2 px-3 py-2 text-[11.5px] text-ink-dim">
          <span>Reference sets need Qwen Image 2.1 (it reads image 2).</span>
          <Button size="sm" onClick={onUseQwen21}>Switch</Button>
        </div>
      ) : !sets.length ? (
        <p className="text-[11.5px] leading-relaxed text-ink-faint">
          Save a collection of references (e.g. 10 outfits), then run it on one person: one edit per selected image, each using it as image 2.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            <Chip active={!active} onClick={() => refSets.setActive(null)}>Off</Chip>
            {sets.map((s) => (
              <Chip key={s.id} tone="cyan" active={active?.id === s.id} onClick={() => refSets.setActive(active?.id === s.id ? null : s.id)}>
                {s.name} <span className="opacity-60">{s.images.length}</span>
              </Chip>
            ))}
          </div>
          {active && <SetEditor key={active.id} set={active} manualRefs={manualRefs} />}
        </>
      )}
    </Section>
  )
}

function SetEditor({ set, manualRefs }: { set: RefSet; manualRefs: number }) {
  const confirmDeletes = useApp((s) => s.confirmDeletes)
  const items = useLibrary('image')
  const byId = new Map(items.map((i) => [i.id, i]))
  const images = set.images.filter((i) => byId.has(i.itemId))
  const selected = images.filter((i) => set.selected.includes(i.itemId))
  const [hover, setHover] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const kindTemplate = REF_KINDS.find((k) => k.id === set.kind)?.template ?? ''

  const addFiles = async (files: File[]) => {
    if (!files.length) return
    setBusy(true)
    try {
      const n = await refSets.addFiles(set.id, files)
      if (n) toast.success(`Added ${n} image(s) to ${set.name}`)
    } catch (e) {
      toast.error('Could not add images', errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  useClipboardImage((file) => void addFiles([file]), { enabled: hover && !busy })

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const item = droppedItem(e)
    if (item) {
      if (item.kind !== 'image') { toast.info('Only images can be references'); return }
      refSets.addImages(set.id, [{ itemId: item.id, label: item.name ? labelFromFilename(item.name) : 'Image' }])
      return
    }
    void addFiles([...e.dataTransfer.files])
  }

  const deleteSet = () => {
    if (confirmDeletes && !confirm(`Delete the set "${set.name}"? Images uploaded into it are deleted too; library images you added stay.`)) return
    void refSets.remove(set.id)
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-accent-2/25 bg-accent-2/5 p-3">
      <div className="flex items-center gap-2">
        <Input className="flex-1" defaultValue={set.name} onBlur={(e) => refSets.rename(set.id, e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} title="Set name (used in result names)" />
        <IconButton onClick={deleteSet} title="Delete this set"><Trash2 size={14} /></IconButton>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[11px] text-ink-faint">
          <span>Instruction for every image (image 1 = person, image 2 = set image)</span>
          {set.template !== kindTemplate && (
            <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => refSets.setTemplate(set.id, kindTemplate)} title="Restore the default instruction">
              <RotateCcw size={11} /> Default
            </button>
          )}
        </div>
        <textarea rows={3} className="field resize-y text-[12px] leading-relaxed" value={set.template} onChange={(e) => refSets.setTemplate(set.id, e.target.value)} />
      </div>

      {set.kind === 'outfit' && (
        <div className="flex flex-col gap-1">
          <Switch checked={undressesFirst(set)} onChange={(on) => refSets.setUndressFirst(set.id, on)} label="Undress first (recommended)" />
          <span className="text-[10.5px] leading-snug text-ink-faint">
            Makes one naked base of the person first, then dresses that base in each outfit, so skin the outfit leaves uncovered keeps its real anatomy instead of being smoothed over. Costs one extra edit per run.
          </span>
        </div>
      )}

      <div
        className={clsx('grid grid-cols-5 gap-1.5 rounded-lg p-0.5', dragOver && 'outline outline-2 outline-accent-2/60')}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onDragOver={(e) => { if (isItemDrag(e) || e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true) } }}
        onDragLeave={(e) => { const to = e.relatedTarget; if (!(to instanceof Node) || !e.currentTarget.contains(to)) setDragOver(false) }}
        onDrop={onDrop}
      >
        {images.map((img) => {
          const item = byId.get(img.itemId)
          const on = set.selected.includes(img.itemId)
          return (
            <div key={img.itemId} className="group relative" title={img.label}>
              <button
                type="button"
                onClick={() => refSets.toggle(set.id, img.itemId)}
                onDoubleClick={() => { const next = prompt('Label for this image', img.label); if (next != null) refSets.relabel(set.id, img.itemId, next) }}
                className={clsx(
                  'block aspect-square w-full overflow-hidden rounded-lg border bg-bg transition',
                  on ? 'border-accent-2 ring-1 ring-accent-2/60' : 'border-line opacity-45 hover:opacity-80',
                )}
              >
                <img src={item?.thumbUrl ?? item?.url} alt={img.label} draggable={false} className="h-full w-full object-cover" />
              </button>
              {on && <span className="pointer-events-none absolute left-1 top-1 grid h-4 w-4 place-items-center rounded bg-accent-2 text-bg"><Check size={11} strokeWidth={3} /></span>}
              <button
                type="button"
                className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-white opacity-0 group-hover:opacity-100"
                onClick={() => void refSets.removeImage(set.id, img.itemId)}
                title="Remove from set"
              ><X size={10} /></button>
              <div className="mt-0.5 truncate text-center text-[10px] text-ink-faint">{img.label}</div>
            </div>
          )
        })}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="grid aspect-square w-full place-items-center rounded-lg border border-dashed border-line text-ink-faint hover:border-line-strong hover:text-ink"
          title="Add images: upload, paste while hovering, or drag files / library images here"
        >
          <Plus size={18} className={clsx(busy && 'animate-pulse')} />
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
      </div>

      <div className="flex items-center justify-between text-[11px] text-ink-faint">
        <span>
          {selected.length} of {images.length} selected → {selected.length + (undressesFirst(set) && selected.length ? 1 : 0)} edit(s)
          {undressesFirst(set) && selected.length > 0 && ' incl. the naked base'}
          {manualRefs > 0 && ` · your ${manualRefs} reference(s) follow as image 3+`}
        </span>
        <span className="flex gap-2">
          <button className="hover:text-ink" onClick={() => refSets.selectAll(set.id, true)}>All</button>
          <button className="hover:text-ink" onClick={() => refSets.selectAll(set.id, false)}>None</button>
        </span>
      </div>
      <p className="text-[10.5px] text-ink-faint">Click to include/exclude, double-click to rename. Tip: a fixed seed keeps the person more consistent across the set.</p>
    </div>
  )
}
