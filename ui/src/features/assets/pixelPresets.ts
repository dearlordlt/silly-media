/** Preset data for the game-asset generators (pixel art + sprite/cutout). */
import type { AspectRatio } from '../../lib/types'

/** Default anti-realism negative prompt for pixel art (mirrors the backend default). */
export const DEFAULT_PIXEL_NEGATIVE = 'blurry, realistic, photorealistic, 3d render, smooth gradients'

/** Quick-pick output sizes shown as chips next to the free slider. */
export const PIXEL_SIZE_CHIPS = [8, 16, 32, 64, 128]

/** Aspect ratios offered for sprites (subset that yields clean non-square cutouts). */
export const SPRITE_ASPECTS: AspectRatio[] = ['9:16', '3:4', '1:1', '4:3', '16:9']

/**
 * Curated asset prompts. `seamless` presets are top-down tiles — selecting one
 * also flips background removal off (a tile must keep its opaque surface).
 */
export interface AssetPreset {
  label: string
  prompt: string
  seamless?: boolean
}

export const ASSET_PRESETS: AssetPreset[] = [
  { label: 'Sword', prompt: 'a simple fantasy sword, game item icon' },
  { label: 'Shield', prompt: 'a round wooden shield with metal rim, game item icon' },
  { label: 'Potion', prompt: 'a red health potion bottle with cork, game item icon' },
  { label: 'Coin', prompt: 'a small gold coin, game currency icon' },
  { label: 'Chest', prompt: 'a wooden treasure chest with iron bands, game item icon' },
  { label: 'Tree', prompt: 'a single stylized pine tree, game asset' },
  { label: 'Rock', prompt: 'a small grey boulder, game asset' },
  { label: 'Character idle', prompt: 'a knight in idle stance, full body, side view, game character' },
  { label: 'Tile floor', prompt: 'top-down seamless stone cobblestone floor tile', seamless: true },
  { label: 'Tile wall', prompt: 'top-down seamless brick wall tile', seamless: true },
]
