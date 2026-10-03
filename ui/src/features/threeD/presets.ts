/**
 * 3D presets as two independent choices:
 *   - use case  (what you're making)  → reference framing, texture, face-budget scale
 *   - quality   (target platform)     → triangle budget, voxel detail, sampling, reference style
 * The final knobs are derived from both, so every combination (and every tier
 * "in between" low-poly and AAA) gets sensible settings.
 *
 * Backend facts these values rely on (src/silly_media/model3d/hunyuan3d.py):
 *  - shape diffusion is cheap (~9s for 50 steps on a 4090); `octree_resolution`
 *    is the main time/VRAM cost — the voxel grid grows cubically (384 ≈ 3.4×,
 *    512 = 8× the voxels of 256);
 *  - the mesh is then decimated to `target_faces` (FaceReducer).
 *
 * Legacy ui-3d.html goal presets map onto this grid:
 *   Blocky/voxel → Character·Retro, Low-poly character → Character·Low-poly,
 *   Prop/item → Prop·Mobile, Building → Building·Indie,
 *   Realistic figure → Character·AAA, Sculpt (no texture) → Sculpt/3D print.
 */
import type { Model3DRequest } from '../../lib/types'

export type Subject = NonNullable<Model3DRequest['subject']>
export type Speed = 'fast' | 'medium' | 'slow' | 'very slow'

export interface QualityTier {
  id: string
  label: string
  /** Short tick label under the slider. */
  short: string
  desc: string
  faces: number
  octree: number
  steps: number
  guidance: number
  /** Reference-image model for Text → 3D (falls back if not installed). */
  imageModel: string
  /** Appended to the Text → 3D prompt so the reference matches the target look. */
  style: string
  speed: Speed
}

export const QUALITY_TIERS: QualityTier[] = [
  {
    id: 'retro', label: 'Retro / voxel', short: 'Retro',
    desc: 'PS1 / Minecraft-like. Chunky silhouette, tiny file.',
    faces: 1200, octree: 128, steps: 20, guidance: 5.0, imageModel: 'z-image-turbo',
    style: 'blocky voxel style, chunky simple shapes, flat colors', speed: 'fast',
  },
  {
    id: 'lowpoly', label: 'Low-poly stylized', short: 'Low-poly',
    desc: 'RuneScape / indie low-poly look. Clear silhouette, few faces.',
    faces: 4000, octree: 192, steps: 25, guidance: 5.5, imageModel: 'z-image-turbo',
    style: 'stylized low-poly game art, simple clean shapes, flat shading', speed: 'fast',
  },
  {
    id: 'mobile', label: 'Mobile game', short: 'Mobile',
    desc: 'Phone-friendly budget, still smooth enough up close.',
    faces: 10000, octree: 256, steps: 30, guidance: 5.5, imageModel: 'z-image-turbo',
    style: 'stylized mobile game asset, clean readable shapes', speed: 'medium',
  },
  {
    id: 'indie', label: 'Indie / stylized PC', short: 'Indie',
    desc: 'Stylized PC game asset. Good default for most projects.',
    faces: 25000, octree: 256, steps: 35, guidance: 5.5, imageModel: 'z-image-turbo',
    style: 'stylized 3D game asset, hand-painted look, clean forms', speed: 'medium',
  },
  {
    id: 'console', label: 'Console / mid-range', short: 'Console',
    desc: 'Detailed in-game asset for a modern PC/console title.',
    faces: 60000, octree: 320, steps: 40, guidance: 6.0, imageModel: 'z-image',
    style: 'detailed 3D game asset, clean well-defined forms', speed: 'slow',
  },
  {
    id: 'aaa', label: 'AAA game asset', short: 'AAA',
    desc: 'Realistic, high-detail asset with a AAA in-game budget.',
    faces: 120000, octree: 384, steps: 50, guidance: 6.0, imageModel: 'z-image',
    style: 'highly detailed realistic AAA game asset, physically based materials', speed: 'slow',
  },
  {
    id: 'hero', label: 'Hero / cinematic', short: 'Hero',
    desc: 'Maximum detail for close-ups and renders. Octree 512 is ~8× the voxels of 256: slow and VRAM-hungry.',
    faces: 250000, octree: 512, steps: 50, guidance: 6.5, imageModel: 'z-image',
    style: 'ultra detailed realistic hero asset, intricate details, cinematic quality', speed: 'very slow',
  },
]

export interface UseCase {
  id: string
  label: string
  icon: string
  desc: string
  subject: Subject
  /** Multiplier on the tier's triangle budget (a prop needs far fewer than a hero character). */
  faceScale: number
  texture: boolean
  /** Raise detail floor regardless of tier (e.g. prints need a dense, clean surface). */
  minOctree?: number
}

export const USE_CASES: UseCase[] = [
  { id: 'character', label: 'Character', icon: '🧍', subject: 'character', faceScale: 1.0, texture: true,
    desc: 'Person or humanoid, full body, A-pose.' },
  { id: 'creature', label: 'Creature', icon: '🐉', subject: 'character', faceScale: 1.1, texture: true,
    desc: 'Monster, animal or beast.' },
  { id: 'prop', label: 'Prop / item', icon: '🧰', subject: 'object', faceScale: 0.35, texture: true,
    desc: 'Small pickup or decor: potion, chest, lamp.' },
  { id: 'weapon', label: 'Weapon', icon: '⚔️', subject: 'object', faceScale: 0.45, texture: true,
    desc: 'Sword, gun, axe, tool — isolated.' },
  { id: 'vehicle', label: 'Vehicle', icon: '🚗', subject: 'object', faceScale: 1.0, texture: true,
    desc: 'Car, ship, mech, spacecraft.' },
  { id: 'building', label: 'Building', icon: '🏛️', subject: 'building', faceScale: 1.4, texture: true,
    desc: 'House, tower, ruin — flat architectural detail.' },
  { id: 'furniture', label: 'Furniture', icon: '🪑', subject: 'object', faceScale: 0.5, texture: true,
    desc: 'Chair, table, shelf, interior piece.' },
  { id: 'nature', label: 'Nature', icon: '🌲', subject: 'auto', faceScale: 0.6, texture: true,
    desc: 'Tree, rock, plant, terrain chunk.' },
  { id: 'print', label: '3D print', icon: '🗿', subject: 'auto', faceScale: 2.5, texture: false, minOctree: 384,
    desc: 'Sculpt / 3D print: untextured dense shape for printing or re-texturing.' },
]

export const DEFAULT_USE_CASE = 'character'
export const DEFAULT_TIER = 1 // Low-poly — matches the legacy default

const FACE_MIN = 500
const FACE_MAX = 300000

/** Round a triangle budget to a readable number within the API's range. */
function niceFaces(n: number): number {
  const step = n < 10000 ? 500 : n < 100000 ? 1000 : 5000
  return Math.min(FACE_MAX, Math.max(FACE_MIN, Math.round(n / step) * step))
}

export interface ResolvedPreset {
  faces: number
  octree: number
  steps: number
  guidance: number
  texture: boolean
  subject: Subject
  imageModel: string
  style: string
  speed: Speed
}

export function resolvePreset(useCaseId: string, tierIndex: number, availableImageModels: string[]): ResolvedPreset {
  const uc = USE_CASES.find((u) => u.id === useCaseId) ?? USE_CASES[0]
  const tier = QUALITY_TIERS[Math.min(QUALITY_TIERS.length - 1, Math.max(0, tierIndex))]
  const octree = Math.max(tier.octree, uc.minOctree ?? 0)
  const imageModel = availableImageModels.length === 0 || availableImageModels.includes(tier.imageModel)
    ? tier.imageModel
    : availableImageModels.includes('z-image-turbo') ? 'z-image-turbo' : availableImageModels[0]
  return {
    faces: niceFaces(tier.faces * uc.faceScale),
    octree,
    steps: tier.steps,
    guidance: tier.guidance,
    texture: uc.texture,
    subject: uc.subject,
    imageModel,
    // Prints are re-shaded anyway; asking for a clean sculpt reads better than a game style.
    style: uc.id === 'print' ? 'clean sculpted form, smooth surfaces, neutral material' : tier.style,
    speed: octree >= 512 ? 'very slow' : octree > tier.octree ? 'slow' : tier.speed,
  }
}

/** Text → 3D prompt with the tier style appended, within the API's 600-char limit. */
export function styledPrompt(prompt: string, style: string, limit = 600): string {
  const p = prompt.trim()
  if (!style) return p.slice(0, limit)
  const suffix = `, ${style}`
  return `${p.slice(0, Math.max(0, limit - suffix.length))}${suffix}`
}
