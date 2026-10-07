/**
 * Edit (img2img) — natural-language image editing, ported from ui-img2img.html
 * (plus the edit modal of ui.html): a sidebar of saved originals with their
 * edits, the preset-chip composer (compose mode = one prompt, otherwise one
 * edit per chip), qwen-image-2.1 references / presets / output size, per-model
 * sampling defaults, and a result viewer with A/B compare, regenerate, reuse
 * and "edit again". Every edit runs on the app-wide GPU queue (editJobs.ts);
 * the page renders its jobs as batch progress + placeholder tiles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clsx } from 'clsx'
import { CheckSquare, Download, FolderOpen, ImagePlus, Images, Plus, RotateCcw, Search, Trash2, Wand2, X } from 'lucide-react'
import type { MediaItem } from '../../lib/library'
import { useClient, toast, errorMessage } from '../../lib/hooks'
import { useModelLoras, useModels } from '../../lib/query'
import type { LoraSpec } from '../../lib/types'
import { LoraPicker, activeLorasFor } from '../../components/LoraPicker'
import { itemBlob, itemExtension, library, useLibrary } from '../../lib/library'
import { kv } from '../../lib/kv'
import { jobs, throwIfCancelled, useJobCounts, usePageJobs } from '../../lib/jobs'
import type { Job } from '../../lib/jobs'
import { MOD_KEY, useCommands, usePrimaryAction } from '../../lib/commands'
import { useApp } from '../../lib/store'
import { blobToDataUrl, downloadBlob } from '../../lib/media'
import { ImageDrop, useClipboardImage } from '../../components/ImageDrop'
import { EnhancePrompt } from '../../components/EnhancePrompt'
import { Button, Chip, EmptyState, IconButton, Input, Label, Panel, Section, Select, Slider, Switch, Textarea } from '../../components/ui/primitives'
import { createZip } from '../../lib/zip'
import { useHandoffImage } from '../../lib/handoff'
import { BatchProgress } from './BatchProgress'
import { CHECKERBOARD, EditViewer, PendingEditTile, editLabel, metaFlag, metaLoras, metaNumber, metaString, safeFilename } from './EditResults'
import type { CompareMode } from './EditResults'
import { editJobData, enqueueEdit, isActive } from './editJobs'
import type { EditPrompt, RunSettings, UpscaleModel } from './editJobs'
import { ArtifactGrid } from '../../components/Artifact'
import { RefSetsPanel } from './RefSetsPanel'
import { NAKED_BASE_PROMPT, REF_KINDS, undressesFirst, useActiveRefSet } from './refSets'
import {
  CLOTHES_NEGATIVE, DEFAULT_NEGATIVE, EDIT_CATEGORIES, MAX_STEPS, MODEL_LABELS, NAKED_VARIANT_SUFFIX, NUDE_BODY_IDS,
  QWEN21_EDIT_PRESETS, QWEN21_MAX_REFS, QWEN21_MODEL, QWEN21_SETTINGS_PRESETS, QWEN21_TEXTURE_NEGATIVE, SIZE_MODES,
  computeOutputSize, customLabel, customPrompt, joinPromptParts, modelDefaults,
} from './presets'
import type { EditOption, SizeMode } from './presets'

const MODEL_KEY = 'silly-edit-model'
const QWEN21_GROUP = 'qwen21'
/** Custom chip texts per category, newest first (persisted per profile). */
const CUSTOM_CHIPS_KEY = 'silly-edit-custom-chips'
const CUSTOM_CHIPS_MAX = 12
const customId = (text: string) => `custom:${text.toLowerCase()}`

type SeedMode = 'random' | 'fixed' | 'custom'

/** One edit request of a batch. */
interface EditEntry extends EditPrompt {
  transparent: boolean
  needsRef: boolean
  /** Eligible for the clothed-variants pair (qwen-image-2.1 preset edits are not). */
  variants: boolean
}

/** Finished batches the user dismissed (kept across page visits, like the jobs themselves). */
const dismissedBatches = new Set<string>()

function loadSavedModel(): string {
  return kv.getItem(MODEL_KEY) ?? QWEN21_MODEL
}

function dataUrlSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve({ width: 0, height: 0 })
    img.src = url
  })
}

export function EditPage() {
  const client = useClient()
  const confirmDeletes = useApp((s) => s.confirmDeletes)
  const { data: models } = useModels()
  const img2imgModels = useMemo(() => models?.img2img.available ?? [], [models])

  /* ---------------------------------------------------------------- model */
  const [model, setModel] = useState(loadSavedModel)
  const defaults = modelDefaults(model)
  const [useLora, setUseLora] = useState(false)
  const [steps, setSteps] = useState(() => modelDefaults(loadSavedModel()).off.steps)
  const [cfg, setCfg] = useState(() => modelDefaults(loadSavedModel()).off.cfg)
  const isQ21 = model === QWEN21_MODEL

  /** Model switch: LoRA off and that model's base steps/cfg (legacy applyModelSettings). */
  const changeModel = useCallback((next: string) => {
    setModel(next)
    kv.setItem(MODEL_KEY, next)
    const d = modelDefaults(next).off
    setUseLora(false)
    setSteps(d.steps)
    setCfg(d.cfg)
  }, [])

  // Fall back to the first available model when the saved one is gone.
  useEffect(() => {
    if (img2imgModels.length && !img2imgModels.includes(model)) changeModel(img2imgModels[0])
  }, [img2imgModels, model, changeModel])

  /** LoRA toggle sets the steps/cfg defaults for that mode (legacy toggleLoraOption). */
  const toggleLora = (on: boolean) => {
    const d = on ? defaults.on : defaults.off
    setUseLora(on)
    setSteps(d.steps)
    setCfg(d.cfg)
  }
  const stepsMin = (useLora ? defaults.on : defaults.off).minSteps
  const cfgLocked = useLora && defaults.loraLocksCfg

  /* -------------------------------------------------------------- source */
  const [source, setSource] = useState<string | null>(null)
  const [srcDims, setSrcDims] = useState<{ width: number; height: number } | null>(null)
  const [currentOriginalId, setCurrentOriginalId] = useState<string | null>(null)
  const [originalName, setOriginalName] = useState('')

  useEffect(() => {
    if (!source) { setSrcDims(null); return }
    let alive = true
    void dataUrlSize(source).then((d) => { if (alive) setSrcDims(d.width ? d : null) })
    return () => { alive = false }
  }, [source])

  /** A new (unsaved) source image: it becomes an original on the first Proceed. */
  const loadNewSource = (dataUrl: string | null, name = '') => {
    setSource(dataUrl)
    setCurrentOriginalId(null)
    setOriginalName(dataUrl ? name : '')
  }

  // Hand-off from other pages (e.g. Studio / Library "Edit"): load once.
  useHandoffImage('edit', (dataUrl) => loadNewSource(dataUrl))

  /* ------------------------------------------------------------ library */
  const images = useLibrary('image')
  const originals = useMemo(
    () => images.filter((i) => i.source === 'edit-original').sort((a, b) => b.createdAt - a.createdAt),
    [images],
  )
  const edits = useMemo(
    () => images.filter((i) => i.source === 'edit').sort((a, b) => b.createdAt - a.createdAt),
    [images],
  )
  const originalsById = useMemo(() => new Map(originals.map((o) => [o.id, o])), [originals])
  const editCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const e of edits) {
      const id = metaString(e, 'originalId')
      if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    return counts
  }, [edits])

  /** null = "All Images". */
  const [view, setView] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const viewItems = useMemo(() => {
    const q = query.trim().toLowerCase()
    return edits.filter((e) => {
      const origId = metaString(e, 'originalId')
      if (view && origId !== view) return false
      if (!q) return true
      const origName = origId ? originalsById.get(origId)?.name ?? '' : ''
      return [e.prompt ?? '', editLabel(e), origName].some((s) => s.toLowerCase().includes(q))
    })
  }, [edits, view, query, originalsById])
  const viewOriginal = view ? originalsById.get(view) ?? null : null

  const selectOriginal = async (orig: MediaItem) => {
    setView(orig.id)
    setSelection(new Set())
    setCurrentOriginalId(orig.id)
    setOriginalName(orig.name === 'Untitled' ? '' : orig.name)
    try {
      setSource(await blobToDataUrl(await itemBlob(orig)))
    } catch (e) {
      toast.error('Could not load the original', errorMessage(e))
    }
  }

  const renameOriginal = () => {
    if (!currentOriginalId) return
    const orig = originalsById.get(currentOriginalId)
    const name = originalName.trim() || 'Untitled'
    if (orig && orig.name !== name) void library.update(orig.id, { name })
  }

  const deleteOriginal = async (orig: MediaItem) => {
    const count = editCounts.get(orig.id) ?? 0
    if (!confirm(`Delete "${orig.name}" and its ${count} edit(s)?`)) return
    await library.removeMany([...edits.filter((e) => metaString(e, 'originalId') === orig.id).map((e) => e.id), orig.id])
    if (view === orig.id) setView(null)
    if (currentOriginalId === orig.id) setCurrentOriginalId(null)
  }

  const clearAll = async () => {
    if (!confirm('Delete ALL originals and their edits? This cannot be undone.')) return
    await library.removeMany([...edits, ...originals].map((i) => i.id))
    setView(null)
    setSelection(new Set())
    loadNewSource(null)
    toast.success('All images deleted')
  }

  /* --------------------------------------------------------- references */
  const [references, setReferences] = useState<string[]>([])
  const addReferences = (files: FileList | File[] | null) => {
    if (!files) return
    const list = [...files].filter((f) => f.type.startsWith('image/'))
    const room = Math.max(0, QWEN21_MAX_REFS - references.length)
    if (list.length > room) toast.info(`Max ${QWEN21_MAX_REFS} reference images; ${list.length - room} skipped`)
    void Promise.all(list.slice(0, room).map(blobToDataUrl)).then((urls) => setReferences((prev) => [...prev, ...urls].slice(0, QWEN21_MAX_REFS)))
  }
  // Pasting while the pointer is over the reference strip appends a reference;
  // otherwise the source drop zone handles the paste.
  const [refsHover, setRefsHover] = useState(false)
  useClipboardImage((file) => addReferences([file]), { enabled: isQ21 && refsHover && references.length < QWEN21_MAX_REFS })

  /* --------------------------------------------------------------- chips */
  const [composeMode, setComposeModeState] = useState(true)
  const [custom, setCustom] = useState('')
  const customRef = useRef<HTMLTextAreaElement>(null)
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})
  const [customChips, setCustomChips] = useState<Record<string, string[]>>(() => kv.getJson<Record<string, string[]>>(CUSTOM_CHIPS_KEY, {}))
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [transparent, setTransparent] = useState(false)

  useEffect(() => { kv.setJson(CUSTOM_CHIPS_KEY, customChips) }, [customChips])

  const categories = useMemo(() => EDIT_CATEGORIES.map((c) => ({
    ...c,
    customIds: new Set((customChips[c.id] ?? []).map(customId)),
    options: [
      ...(customChips[c.id] ?? []).map((text) => ({ id: customId(text), label: customLabel(c.custom, text), prompt: customPrompt(c.custom, text) })),
      ...c.options,
    ],
  })), [customChips])

  /** Compose mode: single-select per category; otherwise multi-select (one edit per chip). */
  const toggleChip = (group: string, id: string) => {
    setSelected((prev) => {
      const set = new Set(prev[group] ?? [])
      if (set.has(id)) set.delete(id)
      else {
        if (composeMode) set.clear()
        set.add(id)
      }
      return { ...prev, [group]: set }
    })
  }

  const toggleAll = (group: string, options: EditOption[]) => {
    setSelected((prev) => ({
      ...prev,
      [group]: prev[group]?.size === options.length ? new Set() : new Set(options.map((o) => o.id)),
    }))
  }

  /** Entering compose mode trims every category to its first selection. */
  const setComposeMode = (on: boolean) => {
    setComposeModeState(on)
    if (!on) return
    setSelected((prev) => {
      const next: Record<string, Set<string>> = {}
      for (const [k, set] of Object.entries(prev)) {
        const first = set.values().next()
        next[k] = first.done ? new Set() : new Set([first.value])
      }
      return next
    })
  }

  /** Add the category's typed text as a chip (or reuse an equal one) and select it. */
  const applyCustom = (group: string) => {
    const text = (drafts[group] ?? '').trim()
    if (!text) return
    const id = customId(text)
    setCustomChips((prev) => {
      const rest = (prev[group] ?? []).filter((t) => customId(t) !== id)
      return { ...prev, [group]: [text, ...rest].slice(0, CUSTOM_CHIPS_MAX) }
    })
    setSelected((prev) => {
      const set = composeMode ? new Set<string>() : new Set(prev[group] ?? [])
      set.add(id)
      return { ...prev, [group]: set }
    })
    setDrafts((prev) => ({ ...prev, [group]: '' }))
  }

  const removeCustom = (group: string, id: string) => {
    setCustomChips((prev) => ({ ...prev, [group]: (prev[group] ?? []).filter((t) => customId(t) !== id) }))
    setSelected((prev) => {
      if (!prev[group]?.has(id)) return prev
      const set = new Set(prev[group])
      set.delete(id)
      return { ...prev, [group]: set }
    })
  }

  /** Dashed "fill" presets replace the instruction and select their [PLACEHOLDER]. */
  const insertFillPrompt = (prompt: string) => {
    setCustom(prompt)
    requestAnimationFrame(() => {
      const ta = customRef.current
      if (!ta) return
      ta.focus()
      const start = prompt.indexOf('[')
      const end = prompt.indexOf(']', start)
      if (start >= 0 && end > start) ta.setSelectionRange(start, end + 1)
    })
  }

  const clickQwen21 = (id: string) => {
    const preset = QWEN21_EDIT_PRESETS.find((p) => p.id === id)
    if (!preset) return
    if (preset.fill) { insertFillPrompt(preset.prompt); return }
    const willSelect = !selected[QWEN21_GROUP]?.has(id)
    toggleChip(QWEN21_GROUP, id)
    // Extract Subject in compose mode also ticks Transparent (batch mode applies it per edit).
    if (composeMode && willSelect && preset.transparent) setTransparent(true)
  }

  const resetSelections = () => { setSelected({}); setCustom('') }

  /* ------------------------------------------------------------ options */
  const [negativeOn, setNegativeOn] = useState(false)
  const [negative, setNegative] = useState('')
  const [clothesOn, setClothesOn] = useState(false)
  const [clothesPrompt, setClothesPrompt] = useState('')
  const [seedMode, setSeedMode] = useState<SeedMode>('random')
  const [seedValue, setSeedValue] = useState('')
  const [sizeMode, setSizeMode] = useState<SizeMode>('match')
  const [upscale, setUpscale] = useState(false)
  const [upscaleFactor, setUpscaleFactor] = useState(2)
  const [upscaleModel, setUpscaleModel] = useState<UpscaleModel>('clean')
  // User LoRAs; kept across model switches, only the selected model's family is sent
  const [loras, setLoras] = useState<LoraSpec[]>([])
  const { data: modelLoras } = useModelLoras(model)
  const sendLoras = activeLorasFor(loras, modelLoras?.model === model ? modelLoras : undefined)

  const addTextureNegative = () => {
    setNegative((n) => (n.includes(QWEN21_TEXTURE_NEGATIVE) ? n : `${n.trim() || DEFAULT_NEGATIVE}, ${QWEN21_TEXTURE_NEGATIVE}`))
    setNegativeOn(true)
  }

  const applySettingsPreset = (p: (typeof QWEN21_SETTINGS_PRESETS)[number]) => {
    setUseLora(p.lora)
    setSteps(p.steps)
    setCfg(p.cfg)
    if (p.textureNegative) addTextureNegative()
  }

  const outputSize = isQ21 && srcDims ? computeOutputSize(sizeMode, srcDims.width, srcDims.height) : null
  const sizeHint = !srcDims ? '' : outputSize
    ? `Output: ${outputSize.width}×${outputSize.height}`
    : `Input ${srcDims.width}×${srcDims.height} → ~1MP, same aspect`

  /* ------------------------------------------------------ prompt building */
  const activeQwen21 = useMemo(
    () => (isQ21 ? QWEN21_EDIT_PRESETS.filter((p) => selected[QWEN21_GROUP]?.has(p.id)) : []),
    [isQ21, selected],
  )
  const needsRefWarning = activeQwen21.some((p) => p.needsRef) && references.length === 0

  const entries = useMemo((): EditEntry[] => {
    const baseNeg = negativeOn && negative.trim() ? negative.trim() : DEFAULT_NEGATIVE
    const withClothes = `${baseNeg}, ${CLOTHES_NEGATIVE}`
    const text = custom.trim()
    const chips: { label: string; prompt: string; nude: boolean; transparent: boolean; needsRef: boolean; q21: boolean }[] = []
    for (const p of activeQwen21) chips.push({ label: p.label, prompt: p.prompt, nude: false, transparent: !!p.transparent, needsRef: !!p.needsRef, q21: true })
    for (const c of categories) {
      for (const o of c.options) {
        if (selected[c.id]?.has(o.id)) chips.push({ label: o.label, prompt: o.prompt, nude: c.id === 'body' && !!NUDE_BODY_IDS[o.id], transparent: false, needsRef: false, q21: false })
      }
    }

    let out: EditEntry[] = []
    if (composeMode) {
      const parts = [...(text ? [text] : []), ...chips.map((c) => c.prompt)]
      if (parts.length) {
        out.push({
          label: [...(text ? ['Custom'] : []), ...chips.map((c) => c.label)].join(' + '),
          prompt: joinPromptParts(parts),
          negative: chips.some((c) => c.nude) ? withClothes : baseNeg,
          transparent: chips.some((c) => c.transparent),
          needsRef: chips.some((c) => c.needsRef),
          variants: true,
        })
      }
    } else {
      if (text) out.push({ label: 'Custom', prompt: text, negative: baseNeg, transparent: false, needsRef: false, variants: true })
      for (const c of chips) {
        out.push({ label: c.label, prompt: c.prompt, negative: c.nude ? withClothes : baseNeg, transparent: c.transparent, needsRef: c.needsRef, variants: !c.q21 })
      }
    }

    // ui.html "Generate clothed variants (2x images)": a Naked + a Dressed edit per prompt.
    const clothes = clothesPrompt.trim()
    if (clothesOn && clothes) {
      out = out.flatMap((e) => (e.variants ? [
        { ...e, label: `${e.label} (Naked)`, prompt: joinPromptParts([e.prompt, NAKED_VARIANT_SUFFIX]), negative: withClothes, basePrompt: e.prompt },
        { ...e, label: `${e.label} (Dressed)`, prompt: joinPromptParts([e.prompt, `Wearing ${clothes}`]), negative: baseNeg, basePrompt: e.prompt, clothedPrompt: clothes },
      ] : [e]))
    }
    return out
  }, [activeQwen21, categories, selected, custom, composeMode, negativeOn, negative, clothesOn, clothesPrompt])

  /* ------------------------------------------------------ reference sets */
  const activeSet = useActiveRefSet()
  const libraryImages = useLibrary('image')
  const setImages = useMemo(() => {
    if (!isQ21 || !activeSet) return []
    const alive = new Set(libraryImages.map((i) => i.id))
    return activeSet.images.filter((i) => activeSet.selected.includes(i.itemId) && alive.has(i.itemId))
  }, [isQ21, activeSet, libraryImages])

  /** What Proceed queues: the entries, or (with a set active) entries × selected set images. */
  const runEntries = useMemo((): EditEntry[] => {
    if (!isQ21 || !activeSet) return entries
    const base: EditEntry[] = entries.length ? entries : [{
      label: '', prompt: '', negative: negativeOn && negative.trim() ? negative.trim() : DEFAULT_NEGATIVE,
      transparent: false, needsRef: false, variants: true,
    }]
    // Anti-blending terms for the set's kind (only used when CFG > 1 enables the negative prompt).
    const kindNegative = REF_KINDS.find((k) => k.id === activeSet.kind)?.negative
    return setImages.flatMap((img) => base.map((e) => ({
      ...e,
      label: [`${activeSet.name}: ${img.label}`, ...(e.label ? [e.label] : [])].join(' + '),
      prompt: joinPromptParts([activeSet.template, ...(e.prompt ? [e.prompt] : [])]),
      negative: kindNegative ? `${e.negative}, ${kindNegative}` : e.negative,
      needsRef: false,
      refSet: { setId: activeSet.id, setName: activeSet.name, itemId: img.itemId, label: img.label },
    })))
  }, [isQ21, activeSet, setImages, entries, negativeOn, negative])
  /** Undress-first outfit sets add one naked base edit in front of the batch. */
  const withBaseStep = isQ21 && !!activeSet && undressesFirst(activeSet) && runEntries.some((e) => e.refSet)

  // Outfit runs (an Outfits reference set, or the "Wear Image 2 Outfit" chip): suggest an
  // installed LoRA tagged "outfit-swap" while it's off.
  const outfitSwapNames = new Set((modelLoras?.loras ?? []).filter((l) => l.tags?.includes('outfit-swap')).map((l) => l.name))
  const isOutfitRun = isQ21 && (activeSet?.kind === 'outfit' || !!selected[QWEN21_GROUP]?.has('q21-outfit-ref'))
  const outfitSwapLora = isOutfitRun && modelLoras?.model === model
    ? modelLoras.loras.find((l) => l.tags?.includes('outfit-swap') && !sendLoras.some((x) => x.name === l.name))
    : undefined
  const runCount = runEntries.length + (withBaseStep ? 1 : 0)

  /* ---------------------------------------------------------- generation */
  const pageJobs = usePageJobs('edit')
  // Enhance-prompt jobs share the page; edit jobs are the ones carrying EditJobData.
  const editJobs = useMemo(() => pageJobs.filter((j) => editJobData(j) != null), [pageJobs])
  const counts = useJobCounts()
  const ahead = counts.running + counts.queued
  /** Uploading a new original before its batch is queued (guards double-submits). */
  const [preparing, setPreparing] = useState(false)

  const runEdit = async () => {
    if (preparing) return
    if (!runEntries.length) {
      toast.error(isQ21 && activeSet ? 'Select at least one image of the reference set' : 'Select at least one prompt or enter a custom prompt')
      return
    }
    if (!source) { toast.error('No source image loaded'); return }
    if (isQ21 && !references.length && runEntries.some((e) => e.needsRef)) {
      toast.error('That preset needs a reference image (image 2) - add one first')
      return
    }

    // Snapshot settings for the whole batch.
    const settings: RunSettings = {
      model, steps, cfg, useLora, upscale, upscaleFactor, upscaleModel,
      transparent, sizeMode,
      outWidth: outputSize?.width, outHeight: outputSize?.height,
      references: isQ21 ? references.slice() : [],
      loras: sendLoras,
    }
    const image = source
    const batchEntries = runEntries

    // Reference-set images become image 2 of their edit: snapshot them now.
    const refUrls = new Map<string, string>()
    const refIds = [...new Set(batchEntries.flatMap((e) => (e.refSet ? [e.refSet.itemId] : [])))]
    if (refIds.length) {
      setPreparing(true)
      try {
        for (const id of refIds) {
          const it = library.get(id)
          if (!it) throw new Error('A reference image was deleted')
          refUrls.set(id, await blobToDataUrl(await itemBlob(it)))
        }
      } catch (e) {
        toast.error('Could not load the reference images', errorMessage(e))
        return
      } finally {
        setPreparing(false)
      }
    }

    // Save the original on the first run.
    let originalId = currentOriginalId
    if (!originalId) {
      setPreparing(true)
      try {
        const blob = await (await fetch(image)).blob()
        const name = originalName.trim() || 'Untitled'
        const orig = await library.add({ kind: 'image', source: 'edit-original', blob, name, width: srcDims?.width, height: srcDims?.height })
        originalId = orig.id
        setCurrentOriginalId(orig.id)
      } catch (e) {
        toast.error('Could not save the original', errorMessage(e))
        return
      } finally {
        setPreparing(false)
      }
    }
    setView(originalId)
    setSelection(new Set())

    const batchSeed = Math.floor(Math.random() * 2147483647)
    const customSeed = Number.parseInt(seedValue, 10)
    const seed = seedMode === 'fixed' ? batchSeed : seedMode === 'custom' && !Number.isNaN(customSeed) ? customSeed : undefined
    const orig = library.get(originalId)
    const preview = orig?.thumbUrl ?? orig?.url ?? image
    const group = `edit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    // Undress-first outfit sets: one naked base edit, then every outfit edit runs on that base
    // (the GPU queue is FIFO, so the base always runs first).
    let stepImage: string | ((signal: AbortSignal) => Promise<{ image: string; sourceItemId: string }>) = image
    if (withBaseStep) {
      let baseItemId: string | null = null
      const label = `${activeSet?.name ?? 'Set'}: naked base`
      const baseJob = enqueueEdit({
        client, image, seed, group,
        entry: { label, prompt: NAKED_BASE_PROMPT, negative: `${negativeOn && negative.trim() ? negative.trim() : DEFAULT_NEGATIVE}, ${CLOTHES_NEGATIVE}` },
        // No image 2 in the base step: an outfit-swap LoRA has nothing to swap there
        settings: { ...settings, references: [], loras: settings.loras.filter((l) => !outfitSwapNames.has(l.name)) },
        data: { originalId, label, preview },
        onSaved: (item) => { baseItemId = item.id },
      })
      stepImage = async (signal) => {
        while (!baseItemId) {
          const state = jobs.get(baseJob)?.state
          if (!state || state === 'failed' || state === 'cancelled') throw new Error('The naked base step did not finish')
          throwIfCancelled(signal)
          await new Promise((r) => setTimeout(r, 400))
        }
        const base = library.get(baseItemId)
        if (!base) throw new Error('The naked base image was deleted')
        return { image: await blobToDataUrl(await itemBlob(base)), sourceItemId: base.id }
      }
    }

    for (const entry of batchEntries) {
      enqueueEdit({
        client, image: entry.refSet ? stepImage : image, entry, seed, group,
        settings: {
          ...settings,
          transparent: settings.transparent || entry.transparent,
          references: entry.refSet ? [refUrls.get(entry.refSet.itemId) ?? '', ...settings.references].slice(0, QWEN21_MAX_REFS) : settings.references,
        },
        data: { originalId, label: entry.label, preview },
      })
    }
    if (ahead > 0) toast.info(`Queued ${runCount} edit(s)`, `${ahead} job(s) ahead`)
  }

  /** Batch panels: every batch with queued/running edits, plus the newest batch until dismissed. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set(dismissedBatches))
  const batches = useMemo(() => {
    const byGroup = new Map<string, Job[]>()
    for (const j of editJobs) {
      if (!j.group) continue
      const list = byGroup.get(j.group)
      if (list) list.push(j); else byGroup.set(j.group, [j])
    }
    // editJobs is newest first, so the first group is the newest batch.
    return [...byGroup].filter(([g, list], i) => !dismissed.has(g) && (i === 0 || list.some(isActive)))
  }, [editJobs, dismissed])
  const dismissBatch = (group: string) => {
    dismissedBatches.add(group)
    setDismissed(new Set(dismissedBatches))
  }

  /** Placeholder tiles (queue order) for the current view: queued, running and failed edits. */
  const pendingJobs = useMemo(
    () => editJobs
      .filter((j) => (isActive(j) || j.state === 'failed') && (!view || editJobData(j)?.originalId === view))
      .reverse(),
    [editJobs, view],
  )
  const queuedCount = editJobs.filter((j) => j.state === 'queued').length

  /* ---------------------------------------------------------- selection */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const toggleSelect = (id: string) => setSelection((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  const allSelected = viewItems.length > 0 && viewItems.every((i) => selection.has(i.id))
  const toggleSelectAll = () => setSelection(allSelected ? new Set() : new Set(viewItems.map((i) => i.id)))

  const deleteEdit = async (item: MediaItem) => {
    if (confirmDeletes && !confirm('Delete this image?')) return
    await library.remove(item.id)
    setSelection((prev) => { const n = new Set(prev); n.delete(item.id); return n })
  }

  const deleteSelected = async () => {
    if (!selection.size) return
    if (!confirm(`Delete ${selection.size} selected image(s)?`)) return
    await library.removeMany([...selection])
    setSelection(new Set())
  }

  const [zipping, setZipping] = useState(false)
  const downloadZip = async (items: MediaItem[], prefix: string, original: MediaItem | null) => {
    const files = [
      ...(original ? [{ label: 'Original', item: original }] : []),
      ...items.map((i) => ({ label: editLabel(i), item: i })),
    ]
    if (!files.length) { toast.info('No images to download'); return }
    setZipping(true)
    try {
      const entries = await Promise.all(files.map(async (f, i) => ({ name: safeFilename(f.label, itemExtension(f.item), i), blob: await itemBlob(f.item) })))
      const zip = await createZip(entries)
      downloadBlob(zip, `${prefix}-${Date.now()}.zip`)
      toast.success(`Downloaded ${files.length} images as ZIP`)
    } catch (e) {
      toast.error('Failed to create ZIP', errorMessage(e))
    } finally {
      setZipping(false)
    }
  }

  /* -------------------------------------------------------------- viewer */
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [compareMode, setCompareMode] = useState<CompareMode>('edit')

  /** The queued / running regenerate job of an edit, if any. */
  const regenJob = useCallback(
    (item: MediaItem) => editJobs.find((j) => isActive(j) && editJobData(j)?.replaces === item.id),
    [editJobs],
  )

  // Original an edit was made from, for the viewer's compare toggle (pre-originals edits stored a data URL).
  const originalUrl = useCallback((item: MediaItem): string | null => {
    const id = metaString(item, 'originalId')
    const orig = id ? originalsById.get(id) : undefined
    return orig ? orig.url : metaString(item, 'sourceImage') ?? null
  }, [originalsById])

  const regenerate = async (item: MediaItem) => {
    if (!item.prompt) { toast.error('Cannot regenerate: missing prompt'); return }
    if (regenJob(item)) { toast.info('This edit is already queued for regeneration'); return }
    const origId = metaString(item, 'originalId')
    const orig = origId ? originalsById.get(origId) : undefined
    const legacySource = metaString(item, 'sourceImage')
    if (!orig && !legacySource) { toast.error('Original image not found'); return }
    const itemModel = item.model ?? 'qwen-image-edit'
    const refCount = metaNumber(item, 'referenceCount') ?? 0
    // Reference-set edits: the set image (image 2) is reloaded from the library.
    const refItemId = metaString(item, 'refItemId')
    const setRefs: string[] = []
    if (itemModel === QWEN21_MODEL && refItemId) {
      const ref = library.get(refItemId)
      if (!ref) { toast.error('The reference-set image of this edit was deleted'); return }
      try {
        setRefs.push(await blobToDataUrl(await itemBlob(ref)))
      } catch (e) {
        toast.error('Could not load the reference image', errorMessage(e))
        return
      }
    }
    const manualCount = refCount - setRefs.length
    if (itemModel === QWEN21_MODEL && manualCount > 0 && references.length !== manualCount) {
      toast.error(`This edit used ${manualCount} reference image(s) - load the same ${manualCount} again to regenerate`)
      return
    }
    const d = modelDefaults(itemModel).off
    const sm = metaString(item, 'sizeMode')
    const um = metaString(item, 'upscaleModel')
    const s: RunSettings = {
      model: itemModel,
      steps: metaNumber(item, 'steps') ?? d.steps,
      cfg: metaNumber(item, 'cfg') ?? d.cfg,
      useLora: metaFlag(item, 'useLora'),
      upscale: metaFlag(item, 'upscale'),
      upscaleFactor: metaNumber(item, 'upscaleFactor') ?? 2,
      upscaleModel: um === 'sharp' ? 'sharp' : 'clean',
      transparent: metaFlag(item, 'transparent'),
      sizeMode: SIZE_MODES.find((m) => m.value === sm)?.value ?? 'match',
      outWidth: metaNumber(item, 'outWidth'),
      outHeight: metaNumber(item, 'outHeight'),
      references: [...setRefs, ...(manualCount > 0 ? references : [])],
      loras: metaLoras(item),
    }
    let image: string
    try {
      // Steps of an undress-first run were made from the naked base, not the original.
      const stepId = metaString(item, 'sourceItemId')
      const step = stepId ? library.get(stepId) : undefined
      if (stepId && !step) toast.info('The naked base of this edit was deleted', 'Regenerating from the original instead.')
      image = step ? await blobToDataUrl(await itemBlob(step)) : orig ? await blobToDataUrl(await itemBlob(orig)) : legacySource ?? ''
    } catch (e) {
      toast.error('Could not load the original', errorMessage(e))
      return
    }
    const label = editLabel(item)
    // Replace in place on success: same id + timestamp keeps its grid / viewer position.
    enqueueEdit({
      client, image, seed: item.seed, settings: s,
      entry: {
        label, prompt: item.prompt, negative: item.negativePrompt ?? '',
        basePrompt: metaString(item, 'basePrompt'), clothedPrompt: metaString(item, 'clothedPrompt'),
        refSet: refItemId ? {
          setId: metaString(item, 'refSetId') ?? '', setName: metaString(item, 'refSetName') ?? '',
          itemId: refItemId, label: metaString(item, 'refLabel') ?? '',
        } : undefined,
        sourceItemId: (() => { const id = metaString(item, 'sourceItemId'); return id && library.get(id) ? id : undefined })(),
      },
      data: { originalId: origId ?? '', label, preview: orig ? orig.thumbUrl ?? orig.url : image, replaces: item.id },
      keep: { id: item.id, createdAt: item.createdAt },
    })
  }

  /** Load an edit's prompt and its sampling settings back into the editor. */
  const reusePrompt = (item: MediaItem) => {
    if (!item.prompt) return
    const itemModel = item.model ?? model
    if (itemModel !== model && (!img2imgModels.length || img2imgModels.includes(itemModel))) changeModel(itemModel)
    setSelected({})
    setClothesOn(false)
    setCustom(item.prompt)
    setUseLora(metaFlag(item, 'useLora'))
    const st = metaNumber(item, 'steps')
    const c = metaNumber(item, 'cfg')
    if (st != null) setSteps(st)
    if (c != null) setCfg(c)
    const neg = item.negativePrompt ?? ''
    setNegativeOn(!!neg && neg !== DEFAULT_NEGATIVE)
    setNegative(neg && neg !== DEFAULT_NEGATIVE ? neg : '')
    if (item.seed != null) { setSeedMode('custom'); setSeedValue(String(item.seed)) } else setSeedMode('random')
    setUpscale(metaFlag(item, 'upscale'))
    setUpscaleFactor(metaNumber(item, 'upscaleFactor') ?? 2)
    setUpscaleModel(metaString(item, 'upscaleModel') === 'sharp' ? 'sharp' : 'clean')
    setLoras(metaLoras(item))
    setTransparent(metaFlag(item, 'transparent'))
    const sm = SIZE_MODES.find((m) => m.value === metaString(item, 'sizeMode'))
    setSizeMode(sm?.value ?? 'match')
    setViewerIndex(null)
    toast.info('Prompt and settings loaded')
  }

  const editAgain = async (item: MediaItem) => {
    try {
      loadNewSource(await blobToDataUrl(await itemBlob(item)), `${editLabel(item)} (edit)`)
    } catch (e) {
      toast.error('Could not load the image', errorMessage(e))
      return
    }
    setViewerIndex(null)
    toast.info('Result loaded as a new source image')
  }

  const deleteFromViewer = async (item: MediaItem) => {
    if (confirmDeletes && !confirm('Delete this image?')) return
    await library.remove(item.id)
    setViewerIndex((idx) => (idx == null || viewItems.length <= 1 ? null : Math.min(idx, viewItems.length - 2)))
    toast.info('Image deleted')
  }

  /** Clear the results area: delete the edits shown and drop failed placeholders. */
  const clearResults = async () => {
    const failed = pendingJobs.filter((j) => j.state === 'failed')
    if (!viewItems.length && !failed.length) return
    if (viewItems.length && !confirm(`Delete the ${viewItems.length} edit(s) shown in the results?`)) return
    for (const j of failed) jobs.remove(j.id)
    await library.removeMany(viewItems.map((i) => i.id))
    setSelection(new Set())
    setViewerIndex(null)
  }

  /** Pick a file as a new (unsaved) source image. */
  const pickNewSource = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void blobToDataUrl(file).then((url) => loadNewSource(url, file.name.replace(/\.[^.]+$/, '')))
    }
    input.click()
  }

  /* ----------------------------------------------------- shortcuts / palette */
  const busy = ahead > 0
  const canRun = !!source && runEntries.length > 0 && !preparing
  usePrimaryAction({ label: busy ? 'Queue edit' : 'Edit', run: () => void runEdit(), disabled: !canRun })
  useCommands([
    {
      id: 'edit.compare',
      label: viewerIndex != null && compareMode !== 'edit' ? 'Exit compare' : 'Compare edit with original',
      group: 'Edit',
      shortcut: 'C',
      keywords: 'a/b split slider side by side before after original',
      disabled: !viewItems.length,
      run: () => {
        if (viewerIndex == null) { setViewerIndex(0); setCompareMode('split'); return }
        setCompareMode((m) => (m === 'edit' ? 'split' : 'edit'))
      },
    },
    {
      id: 'edit.clearResults',
      label: 'Clear results (delete shown edits)',
      group: 'Edit',
      keywords: 'delete remove results edits',
      disabled: !viewItems.length && !pendingJobs.some((j) => j.state === 'failed'),
      run: () => void clearResults(),
    },
    { id: 'edit.newSource', label: 'New source image…', group: 'Edit', keywords: 'open upload load image source', run: pickNewSource },
    {
      id: 'edit.cancelQueued',
      label: `Cancel queued edits${queuedCount ? ` (${queuedCount})` : ''}`,
      group: 'Edit',
      disabled: !queuedCount,
      run: () => jobs.cancelQueued({ page: 'edit' }),
    },
  ])

  /* ---------------------------------------------------------------- render */
  const selectedCount = Object.values(selected).reduce((n, s) => n + s.size, 0)
  const modelOptions = img2imgModels.length ? img2imgModels : [model]
  const hint = !isQ21 ? null : useLora
    ? 'Turbo: steps 5-7 = turbo only, 8+ = 9-step hybrid (7 turbo + 2 base, more detail). CFG is forced to 1.'
    : 'CFG 1 = off. CFG above 1 enables true CFG (uses the negative prompt, about 2x slower).'

  return (
    <div className="flex h-full">
      {/* ------------------------------------------------ controls column */}
      <div className="scroll-area w-[400px] shrink-0 border-r border-line p-5">
        <Section title="Source image">
          <ImageDrop value={source} onChange={(v) => loadNewSource(v)} />
          {source && (
            <div className="flex items-center gap-2">
              <Label>Name</Label>
              <Input
                className="flex-1"
                value={originalName}
                onChange={(e) => setOriginalName(e.target.value)}
                onBlur={renameOriginal}
                onKeyDown={(e) => { if (e.key === 'Enter') renameOriginal() }}
                placeholder="Optional name for this image"
              />
            </div>
          )}
          {source && !currentOriginalId && <p className="text-[11px] text-ink-faint">New image — saved as an original on the first edit.</p>}
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section
          title="Instruction"
          action={
            <div className="flex items-center gap-1">
              <EnhancePrompt kind="edit" value={custom} onChange={setCustom} />
              <IconButton onClick={resetSelections} title="Clear prompt and selections"><RotateCcw size={14} /></IconButton>
            </div>
          }
        >
          <div className="flex items-center gap-3">
            <Switch checked={composeMode} onChange={setComposeMode} label="Compose mode" />
            <span className="text-[11px] text-ink-faint">{composeMode ? 'Combine selections into one prompt' : 'Each selection = separate image'}</span>
          </div>
          {/* Plain textarea (same `field` styling as <Textarea>) so fill presets can focus/select their placeholder. */}
          <textarea ref={customRef} rows={3} className="field resize-y leading-relaxed" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Enter custom edit instruction…" />
          {composeMode || (isQ21 && activeSet) ? (
            runEntries[0] && (
              <Panel className="p-2.5 text-[11.5px] leading-relaxed text-ink-dim">
                <span className="font-semibold text-ink-faint">Preview{runEntries.length > 1 ? ` (1 of ${runEntries.length})` : ''}{withBaseStep ? ', run on the naked base' : ''}: </span>{runEntries[0].prompt}
              </Panel>
            )
          ) : (
            <span className="text-[11px] text-ink-faint">{selectedCount} chip(s) selected → {entries.length} image(s)</span>
          )}
        </Section>

        <div className="my-4 h-px bg-line" />
        <RefSetsPanel enabled={isQ21} onUseQwen21={() => changeModel(QWEN21_MODEL)} manualRefs={references.length} />

        {isQ21 && (
          <>
            <div className="my-4 h-px bg-line" />
            <Section
              title="Reference images"
              action={
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-ink-faint">{references.length}/{QWEN21_MAX_REFS}</span>
                  {references.length > 0 && <Button size="sm" variant="ghost" onClick={() => setReferences([])}>Clear</Button>}
                </div>
              }
            >
              <div className="flex flex-wrap gap-2" onMouseEnter={() => setRefsHover(true)} onMouseLeave={() => setRefsHover(false)}>
                {references.map((r, i) => (
                  <div key={i} className="group relative">
                    <img src={r} alt={`image ${i + 2}`} className="h-16 w-16 rounded-lg border border-line bg-bg object-contain" />
                    <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-black/60 text-center text-[9.5px] text-white">image {i + 2}</span>
                    <button
                      className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-white opacity-0 group-hover:opacity-100"
                      onClick={() => setReferences((prev) => prev.filter((_, j) => j !== i))}
                      title="Remove"
                    ><X size={11} /></button>
                  </div>
                ))}
                {references.length < QWEN21_MAX_REFS && (
                  <button
                    className="grid h-16 w-16 place-items-center rounded-lg border border-dashed border-line text-ink-faint hover:border-line-strong hover:text-ink"
                    title="Add reference images (or paste while hovering here)"
                    onClick={() => {
                      const input = document.createElement('input')
                      input.type = 'file'; input.multiple = true; input.accept = 'image/*'
                      input.onchange = () => addReferences(input.files)
                      input.click()
                    }}
                  ><Plus size={18} /></button>
                )}
              </div>
              <p className="text-[11px] text-ink-faint">The main image is “image 1”; references are “image 2”, “image 3”, … in the prompt (max {QWEN21_MAX_REFS}).</p>
            </Section>

            <div className="my-4 h-px bg-line" />
            <Section title="Qwen 2.1 edits">
              <div className="flex flex-wrap gap-1.5">
                {QWEN21_EDIT_PRESETS.map((p) => p.fill ? (
                  <button
                    key={p.id}
                    type="button"
                    title="Inserts into the instruction - edit the [placeholder]"
                    onClick={() => clickQwen21(p.id)}
                    className="rounded-full border border-dashed border-accent-2/50 px-2.5 py-1 text-[12px] text-accent-2 hover:bg-accent-2/10"
                  >{p.label}</button>
                ) : (
                  <Chip
                    key={p.id}
                    tone="cyan"
                    active={!!selected[QWEN21_GROUP]?.has(p.id)}
                    title={p.needsRef ? 'Needs a reference image (image 2)' : p.prompt}
                    onClick={() => clickQwen21(p.id)}
                  >{p.label}</Chip>
                ))}
              </div>
              {needsRefWarning && (
                <p className="text-[11.5px] text-warn">This preset needs a reference image: add one above (it becomes image 2).</p>
              )}
              <p className="text-[11px] text-ink-faint">Dashed chips insert an editable prompt into the instruction.</p>
            </Section>
          </>
        )}

        <div className="my-4 h-px bg-line" />

        {categories.map((g) => (
          <Section
            key={g.id}
            title={g.label}
            className="mb-4"
            action={g.id === 'body' ? undefined : (
              <Button size="sm" variant="ghost" onClick={() => toggleAll(g.id, g.options)}>
                {selected[g.id]?.size === g.options.length ? 'None' : 'All'}
              </Button>
            )}
          >
            <div className="flex flex-wrap gap-1.5">
              {g.options.map((o) => g.customIds.has(o.id) ? (
                <CustomChip
                  key={o.id}
                  label={o.label}
                  title={o.prompt}
                  active={!!selected[g.id]?.has(o.id)}
                  onClick={() => toggleChip(g.id, o.id)}
                  onRemove={() => removeCustom(g.id, o.id)}
                />
              ) : (
                <Chip key={o.id} active={!!selected[g.id]?.has(o.id)} title={o.prompt} onClick={() => toggleChip(g.id, o.id)}>{o.label}</Chip>
              ))}
            </div>
            <div className="flex gap-2">
              <Input
                className="flex-1"
                value={drafts[g.id] ?? ''}
                onChange={(e) => { const v = e.target.value; setDrafts((prev) => ({ ...prev, [g.id]: v })) }}
                onKeyDown={(e) => { if (e.key === 'Enter') applyCustom(g.id) }}
                placeholder={g.custom.placeholder}
                title={g.custom.prefix ? `Becomes: "${g.custom.prefix} …"` : 'Used as written'}
              />
              <Button size="sm" onClick={() => applyCustom(g.id)} disabled={!(drafts[g.id] ?? '').trim()}>Use</Button>
            </div>
          </Section>
        ))}

        <div className="my-4 h-px bg-line" />

        <Section title="Options">
          <Switch checked={negativeOn} onChange={setNegativeOn} label="Custom negative" />
          {negativeOn && (
            <>
              <Textarea rows={2} value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="Things to avoid…" />
              <p className="text-[11px] text-ink-faint">Empty = default: {DEFAULT_NEGATIVE}</p>
            </>
          )}
          <p className="text-[11px] text-ink-faint">Nude body chips automatically add a “no clothes” negative.</p>
          <Switch checked={clothesOn} onChange={setClothesOn} label="Generate clothed variants (2x images)" />
          {clothesOn && (
            <Textarea rows={2} value={clothesPrompt} onChange={(e) => setClothesPrompt(e.target.value)} placeholder="e.g. Business suit, stockings, heels" />
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Switch checked={upscale} onChange={setUpscale} label="Upscale result" />
            {upscale && (
              <>
                <Select className="w-20" value={upscaleFactor} onChange={(e) => setUpscaleFactor(Number(e.target.value))} title="Upscale factor">
                  {[1.5, 2, 3, 4].map((f) => <option key={f} value={f}>{f}×</option>)}
                </Select>
                <Select
                  className="flex-1"
                  value={upscaleModel}
                  onChange={(e) => setUpscaleModel(e.target.value === 'sharp' ? 'sharp' : 'clean')}
                  title="Clean removes grain/halftone texture; Sharp keeps fine detail"
                >
                  <option value="clean">Clean (removes grain)</option>
                  <option value="sharp">Sharp (keeps detail)</option>
                </Select>
              </>
            )}
          </div>
        </Section>

        <div className="my-4 h-px bg-line" />

        <Section title="Model & sampling">
          <Select value={model} onChange={(e) => changeModel(e.target.value)}>
            {modelOptions.map((m) => <option key={m} value={m}>{MODEL_LABELS[m] ?? m}</option>)}
          </Select>
          <Switch checked={useLora} onChange={toggleLora} label={defaults.loraLabel} />
          {isQ21 && (
            <div>
              <Label>Settings presets</Label>
              <div className="flex flex-wrap gap-1.5">
                {QWEN21_SETTINGS_PRESETS.map((p) => (
                  <Chip
                    key={p.id}
                    active={useLora === p.lora && steps === p.steps && cfg === p.cfg}
                    title={p.title}
                    onClick={() => applySettingsPreset(p)}
                  >{p.label}</Chip>
                ))}
              </div>
            </div>
          )}
          <Slider label="Steps" value={steps} min={stepsMin} max={MAX_STEPS} onValueChange={setSteps} />
          {cfgLocked ? (
            <div><Label hint="1.0">CFG</Label><p className="text-[11px] text-ink-faint">Locked to 1 while the turbo LoRA is on.</p></div>
          ) : (
            <Slider label="CFG" value={cfg} min={1} max={10} step={0.5} onValueChange={setCfg} format={(v) => v.toFixed(1)} />
          )}
          {hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
          {isQ21 && cfg > 1 && !negative.includes(QWEN21_TEXTURE_NEGATIVE) && (
            <Button size="sm" variant="ghost" onClick={addTextureNegative} title={QWEN21_TEXTURE_NEGATIVE}>Add anti-texture negative</Button>
          )}
          {isQ21 && (
            <div className="flex items-end gap-3">
              <div className="flex-1">
                <Label hint={sizeHint}>Output size</Label>
                <Select value={sizeMode} onChange={(e) => setSizeMode(SIZE_MODES.find((m) => m.value === e.target.value)?.value ?? 'match')}>
                  {SIZE_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
              </div>
              <div className="pb-2"><Switch checked={transparent} onChange={setTransparent} label="Transparent BG" /></div>
            </div>
          )}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Label>Seed</Label>
              <Select value={seedMode} onChange={(e) => setSeedMode(e.target.value === 'fixed' ? 'fixed' : e.target.value === 'custom' ? 'custom' : 'random')}>
                <option value="random">Random</option>
                <option value="fixed">Fixed (same for whole batch)</option>
                <option value="custom">Custom</option>
              </Select>
            </div>
            {seedMode === 'custom' && (
              <Input className="w-32" type="number" value={seedValue} onChange={(e) => setSeedValue(e.target.value)} placeholder="Seed" />
            )}
          </div>
        </Section>

        {modelLoras?.supported && modelLoras.model === model && (
          <>
            <div className="my-4 h-px bg-line" />
            {outfitSwapLora && (
              <div className="mb-3 flex items-start gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-2">
                <p className="flex-1 text-[11.5px] text-ink-dim">
                  Outfit swap: <span className="text-ink">{outfitSwapLora.display_name || outfitSwapLora.name}</span> keeps the face, pose and background in place while only the clothes change.
                </p>
                <Button
                  size="sm"
                  onClick={() => setLoras((cur) => [...cur.filter((x) => x.name !== outfitSwapLora.name), { name: outfitSwapLora.name, scale: outfitSwapLora.default_scale ?? 1 }])}
                >
                  Turn on
                </Button>
              </div>
            )}
            <LoraPicker model={model} value={loras} onChange={setLoras} mode="edit" />
          </>
        )}

        <div className="sticky bottom-0 -mx-5 mt-5 border-t border-line bg-panel/95 px-5 py-4 backdrop-blur">
          <Button
            variant="primary" size="lg" className="w-full" icon={<Wand2 size={16} />}
            onClick={() => void runEdit()} disabled={!canRun} loading={preparing}
            title={`${MOD_KEY}+Enter`}
          >
            {busy
              ? `Queue${runCount > 1 ? ` ${runCount} edits` : ''} (${ahead} ahead)`
              : `Proceed${runCount > 1 ? ` (${runCount} images)` : ''}`}
          </Button>
          {queuedCount > 0 && (
            <Button variant="ghost" size="sm" className="mt-2 w-full" icon={<X size={13} />} onClick={() => jobs.cancelQueued({ page: 'edit' })}>
              Cancel {queuedCount} queued edit(s)
            </Button>
          )}
        </div>
      </div>

      {/* ------------------------------------------------ originals sidebar */}
      <div className="scroll-area flex w-60 shrink-0 flex-col gap-1 border-r border-line p-3">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-ink">Originals</h3>
          <Button size="sm" variant="ghost" onClick={clearAll} disabled={!originals.length && !edits.length} title="Delete all originals and edits">Clear all</Button>
        </div>
        <button
          className={clsx('flex items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px]', view == null ? 'bg-accent/15 text-ink' : 'text-ink-dim hover:bg-panel-2')}
          onClick={() => { setView(null); setSelection(new Set()) }}
        >
          <Images size={15} /> All images <span className="ml-auto text-[11px] text-ink-faint">{edits.length}</span>
        </button>
        {originals.map((o) => (
          <div
            key={o.id}
            className={clsx('group flex cursor-pointer items-center gap-2 rounded-lg p-1.5', view === o.id ? 'bg-accent/15' : 'hover:bg-panel-2')}
            onClick={() => void selectOriginal(o)}
          >
            <img src={o.url} alt="" className="h-11 w-11 shrink-0 rounded-md border border-line bg-bg object-contain" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-ink">{o.name || 'Untitled'}</div>
              <div className="flex items-center gap-1.5 text-[10.5px] text-ink-faint">
                <span>{new Date(o.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                {(editCounts.get(o.id) ?? 0) > 0 && <span className="rounded-full bg-accent/25 px-1.5 text-ink">{editCounts.get(o.id)}</span>}
              </div>
            </div>
            <button
              className="rounded p-1 text-ink-faint opacity-0 hover:text-bad group-hover:opacity-100"
              onClick={(e) => { e.stopPropagation(); void deleteOriginal(o) }}
              title="Delete original and its edits"
            ><Trash2 size={13} /></button>
          </div>
        ))}
        {!originals.length && <p className="px-2 py-3 text-[11.5px] text-ink-faint">Originals appear here after your first edit.</p>}
      </div>

      {/* ------------------------------------------------------- results */}
      <div className="scroll-area flex-1 p-5">
        <div className="mx-auto flex max-w-6xl flex-col gap-4">
          {batches.map(([group, list]) => (
            <BatchProgress key={group} group={group} batch={list} onDismiss={() => dismissBatch(group)} />
          ))}

          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-ink">
              {viewOriginal ? viewOriginal.name || 'Untitled' : 'All edits'} <span className="font-normal text-ink-faint">({viewItems.length})</span>
            </h3>
            <div className="relative ml-auto w-64">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" />
              <Input className="w-full pl-8" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts, names…" />
            </div>
            <Button size="sm" variant="secondary" icon={<CheckSquare size={13} />} onClick={toggleSelectAll} disabled={!viewItems.length}>
              {allSelected ? 'Deselect all' : 'Select all'}
            </Button>
            <Button
              size="sm" variant="secondary" icon={<Download size={13} />} loading={zipping}
              disabled={!viewItems.length}
              onClick={() => void downloadZip(viewItems, 'img2img-results', viewOriginal)}
              title={viewOriginal ? 'ZIP of the original and its edits' : 'ZIP of all shown edits'}
            >Download ZIP</Button>
          </div>

          {selection.size > 0 && (
            <Panel className="flex items-center gap-2 border-accent/40 px-3 py-2 text-[12.5px]">
              <span className="text-ink">{selection.size} selected</span>
              <Button size="sm" variant="secondary" icon={<Download size={13} />} loading={zipping}
                onClick={() => void downloadZip(edits.filter((e) => selection.has(e.id)), 'img2img-selected', null)}>Download ZIP</Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={() => void deleteSelected()}>Delete</Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Set())}>Deselect</Button>
            </Panel>
          )}

          {viewOriginal && (
            <Panel className="flex items-center gap-4 p-3">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-line bg-bg" style={CHECKERBOARD}>
                <img src={viewOriginal.url} alt="" className="h-full w-full object-contain" />
              </div>
              <div className="min-w-0 text-[12px] text-ink-dim">
                <div className="flex items-center gap-1.5 font-medium text-ink"><FolderOpen size={13} /> Original</div>
                <div className="mt-1">{viewOriginal.width ? `${viewOriginal.width}×${viewOriginal.height} · ` : ''}{new Date(viewOriginal.createdAt).toLocaleString()}</div>
              </div>
              {currentOriginalId !== viewOriginal.id && (
                <Button className="ml-auto" size="sm" variant="ghost" icon={<ImagePlus size={13} />} onClick={() => void selectOriginal(viewOriginal)}>Use as source</Button>
              )}
            </Panel>
          )}

          {pendingJobs.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
              {pendingJobs.map((j) => <PendingEditTile key={j.id} job={j} />)}
            </div>
          )}

          {viewItems.length ? (
            <ArtifactGrid
              items={viewItems}
              columns={4}
              selected={selection}
              onToggleSelect={(item) => toggleSelect(item.id)}
              onOpen={(item) => setViewerIndex(viewItems.findIndex((i) => i.id === item.id))}
              onDelete={(item) => void deleteEdit(item)}
            />
          ) : !pendingJobs.length && (
            <EmptyState
              icon={<Images size={22} />}
              title={query ? 'No edits match your search' : originals.length || source ? 'No edits yet' : 'No images yet'}
              detail={query ? undefined : 'Paste or upload an image, pick an instruction and press Proceed.'}
            />
          )}
        </div>
      </div>

      <EditViewer
        items={viewItems}
        index={viewerIndex}
        onIndex={setViewerIndex}
        onClose={() => setViewerIndex(null)}
        originalUrl={originalUrl}
        mode={compareMode}
        onMode={setCompareMode}
        regenJob={regenJob}
        onRegenerate={(item) => void regenerate(item)}
        onReuse={reusePrompt}
        onEditAgain={(item) => void editAgain(item)}
        onDelete={(item) => void deleteFromViewer(item)}
      />
    </div>
  )
}

/** A user-added chip: same look as preset chips, dashed border, with a remove button. */
function CustomChip({ label, title, active, onClick, onRemove }: {
  label: string
  title: string
  active: boolean
  onClick: () => void
  onRemove: () => void
}) {
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border border-dashed text-[12px] transition-colors',
        active ? 'border-accent/60 bg-accent/20 text-ink' : 'border-line-strong bg-panel-2 text-ink-dim hover:text-ink',
      )}
    >
      <button type="button" title={title} onClick={onClick} className="py-1 pl-2.5 pr-1">{label}</button>
      <button type="button" title="Remove this custom chip" onClick={onRemove} className="grid h-5 w-5 place-items-center rounded-full pr-0.5 text-ink-faint hover:text-bad">
        <X size={11} />
      </button>
    </span>
  )
}
