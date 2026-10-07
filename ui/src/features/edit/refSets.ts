/**
 * Reference sets: named collections of reference images (outfits, locations,
 * hairstyles…) for qwen-image-2.1 edits. Running a set queues one edit per
 * selected image, with that image as "image 2" and the set's instruction.
 *
 * Set metadata (name, instruction, image order, selection) lives in the
 * profile's kv store; the images themselves are library items (source
 * `edit-reference` when uploaded here, or any existing library image).
 */
import { useSyncExternalStore } from 'react'
import { kv } from '../../lib/kv'
import { library } from '../../lib/library'
import { EDIT_BODY, joinPromptParts } from './presets'

export const REF_SOURCE = 'edit-reference'
const KEY = 'silly-edit-ref-sets'
const ACTIVE_KEY = 'silly-edit-ref-set-active'

export type RefKind = 'outfit' | 'location' | 'hair' | 'pose' | 'item' | 'style' | 'custom'

/**
 * Default instructions. The model tends to blend image 1 and image 2 (mixing
 * the old outfit into the new one, copying the reference person's face), so
 * each template says what to take from image 2, what to discard from image 1,
 * and what in image 2 to ignore.
 */
export const REF_KINDS: { id: RefKind; label: string; template: string; negative?: string }[] = [
  {
    id: 'outfit', label: 'Outfits',
    template: 'Dress the person in image 1 only in the outfit from image 2. If the person in image 1 wears any clothing, remove all of it first. Reproduce the image 2 outfit exactly: same garments, cut, length, coverage, colors, fabric, patterns and details. Every body part the outfit does not cover stays naked and anatomically realistic, exactly as it is in image 1 when already bare: natural breasts with clearly visible nipples and areolas, natural skin texture; never smooth over, blur or censor them. Do not add a bra, underwear or any garment that is not in image 2, and do not keep, layer or blend any piece of the original clothing. Use image 2 only as the outfit reference and ignore its model, face, body, pose and background. Keep the face, hairstyle, skin tone, body shape, pose, background and lighting of image 1 unchanged. The outfit fits the body naturally with realistic folds and shadows.',
    negative: 'mixed outfits, blended clothing, original clothes visible, layered garments, two outfits, added bra, added underwear, extra clothing, covered breasts, smooth featureless chest, missing nipples, mannequin, doll-like body, censored, different face, face from image 2',
  },
  {
    id: 'location', label: 'Locations',
    template: 'Replace the entire background of image 1 with the location from image 2, so nothing of the original background remains. Ignore any people in image 2. Keep the person from image 1 exactly as they are: same face, body, pose, clothing and hair. Match the lighting, perspective, scale and shadows of image 2 so the person looks naturally photographed there.',
  },
  {
    id: 'hair', label: 'Hairstyles',
    template: 'Replace the hair of the person in image 1 completely with the hairstyle and hair color from image 2. Do not mix in any of the original hair. Use image 2 only as the hair reference and ignore its face, outfit and background. Keep the face, skin tone, body, outfit, pose and background of image 1 unchanged.',
    negative: 'mixed hairstyles, original hair visible, different face, face from image 2',
  },
  {
    id: 'pose', label: 'Poses',
    template: 'Change the pose of the person in image 1 to match the body pose from image 2 exactly. Use image 2 only as the pose reference and ignore its face, body type, outfit and background. Keep the face, hairstyle, outfit, body shape and background of image 1 unchanged.',
    negative: 'different face, face from image 2, outfit from image 2',
  },
  {
    id: 'item', label: 'Accessories',
    template: 'Make the person in image 1 wear or hold the item from image 2, reproduced exactly in shape, color and material. Use image 2 only as the item reference and ignore everything else in it. Keep the face, body, outfit, pose and background of image 1 unchanged.',
  },
  {
    id: 'style', label: 'Art styles',
    template: 'Restyle image 1 completely in the art style of image 2: its medium, line work, shading and color palette. Do not copy the subjects or composition of image 2. Keep the composition, subject, pose and facial features of image 1.',
  },
  { id: 'custom', label: 'Custom', template: 'Using image 2 as the reference, ' },
]

export interface RefSetImage {
  itemId: string
  /** Shown on the tile and used in result names, e.g. "Red dress". */
  label: string
}

export interface RefSet {
  id: string
  name: string
  kind: RefKind
  /** Instruction for every edit of the set; image 1 = the person, image 2 = the set image. */
  template: string
  images: RefSetImage[]
  /** Item ids included in the next run. */
  selected: string[]
  createdAt: number
  /** Outfit sets: first make one naked base of the person, then dress that base in each set image. */
  undressFirst?: boolean
}

/** Whether a run of this set starts with the naked base step (default on for outfit sets). */
export function undressesFirst(set: RefSet): boolean {
  return set.kind === 'outfit' && (set.undressFirst ?? true)
}

/** Step 1 of an undress-first run: the Body "Naked" chip, everything else unchanged. */
export const NAKED_BASE_PROMPT = joinPromptParts([
  EDIT_BODY.find((o) => o.id === 'naked')?.prompt ?? 'Completely naked, nude, no clothes',
  'Remove every piece of clothing and keep the face, hairstyle, skin tone, body shape, pose, background and lighting exactly unchanged',
])

let sets: RefSet[] = kv.getJson<RefSet[]>(KEY, [])
let activeId: string | null = kv.getItem(ACTIVE_KEY)
const listeners = new Set<() => void>()

function commit(next: RefSet[]) {
  sets = next
  kv.setJson(KEY, sets)
  for (const l of listeners) l()
}

function patchSet(id: string, fn: (s: RefSet) => RefSet) {
  commit(sets.map((s) => (s.id === id ? fn(s) : s)))
}

function subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } }

/** "summer_dress-02.png" → "Summer dress 02". */
export function labelFromFilename(name: string): string {
  const t = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Image'
}

export const refSets = {
  create(kind: RefKind, name?: string): RefSet {
    const k = REF_KINDS.find((x) => x.id === kind) ?? REF_KINDS[0]
    const set: RefSet = { id: crypto.randomUUID(), name: name?.trim() || k.label, kind, template: k.template, images: [], selected: [], createdAt: Date.now() }
    commit([...sets, set])
    refSets.setActive(set.id)
    return set
  },
  setUndressFirst(id: string, on: boolean) { patchSet(id, (s) => ({ ...s, undressFirst: on })) },
  rename(id: string, name: string) { patchSet(id, (s) => ({ ...s, name: name.trim() || s.name })) },
  setTemplate(id: string, template: string) { patchSet(id, (s) => ({ ...s, template })) },

  /** Upload files as reference items and append them (selected). */
  async addFiles(id: string, files: File[]): Promise<number> {
    const images: RefSetImage[] = []
    for (const f of files.filter((x) => x.type.startsWith('image/'))) {
      const label = labelFromFilename(f.name)
      const item = await library.add({ kind: 'image', source: REF_SOURCE, blob: f, name: label })
      images.push({ itemId: item.id, label })
    }
    refSets.addImages(id, images)
    return images.length
  },

  /** Append existing library images (duplicates ignored). */
  addImages(id: string, images: RefSetImage[]) {
    patchSet(id, (s) => {
      const have = new Set(s.images.map((i) => i.itemId))
      const fresh = images.filter((i) => !have.has(i.itemId))
      return { ...s, images: [...s.images, ...fresh], selected: [...s.selected, ...fresh.map((i) => i.itemId)] }
    })
  },

  relabel(id: string, itemId: string, label: string) {
    patchSet(id, (s) => ({ ...s, images: s.images.map((i) => (i.itemId === itemId ? { ...i, label: label.trim() || i.label } : i)) }))
  },

  /** Drop an image from the set; uploaded-here items no other set uses are deleted from the library. */
  async removeImage(id: string, itemId: string) {
    patchSet(id, (s) => ({ ...s, images: s.images.filter((i) => i.itemId !== itemId), selected: s.selected.filter((x) => x !== itemId) }))
    await deleteOrphans([itemId])
  },

  toggle(id: string, itemId: string) {
    patchSet(id, (s) => ({ ...s, selected: s.selected.includes(itemId) ? s.selected.filter((x) => x !== itemId) : [...s.selected, itemId] }))
  },
  selectAll(id: string, on: boolean) {
    patchSet(id, (s) => ({ ...s, selected: on ? s.images.map((i) => i.itemId) : [] }))
  },

  async remove(id: string) {
    const set = sets.find((s) => s.id === id)
    commit(sets.filter((s) => s.id !== id))
    if (activeId === id) refSets.setActive(null)
    if (set) await deleteOrphans(set.images.map((i) => i.itemId))
  },

  setActive(id: string | null) {
    activeId = id
    if (id) kv.setItem(ACTIVE_KEY, id)
    else kv.removeItem(ACTIVE_KEY)
    for (const l of listeners) l()
  },
}

async function deleteOrphans(itemIds: string[]) {
  const used = new Set(sets.flatMap((s) => s.images.map((i) => i.itemId)))
  const doomed = itemIds.filter((id) => !used.has(id) && library.get(id)?.source === REF_SOURCE)
  if (doomed.length) await library.removeMany(doomed)
}

export function useRefSets(): RefSet[] {
  return useSyncExternalStore(subscribe, () => sets, () => sets)
}

/** The active set, if it still exists. */
export function useActiveRefSet(): RefSet | null {
  const all = useRefSets()
  const id = useSyncExternalStore(subscribe, () => activeId, () => activeId)
  return all.find((s) => s.id === id) ?? null
}
