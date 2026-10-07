/** Shared API types — mirrored from the backend pydantic schemas in src/silly_media. */

export type ModelTypeKey =
  | 'image'
  | 'audio'
  | 'video'
  | 'vision'
  | 'img2img'
  | 'llm'
  | 'music'
  | 'model3d'

export interface HealthResponse {
  status: string
  models_loaded: string[]
  available_image_models: string[]
  available_audio_models: string[]
  available_video_models: string[]
  available_vision_models: string[]
  available_img2img_models: string[]
  available_llm_models: string[]
  available_music_models: string[]
  available_model3d_models: string[]
}

export type ModelsResponse = Record<ModelTypeKey, { available: string[]; loaded: string[] }>

export interface ProgressResponse {
  active: boolean
  step?: number
  total_steps?: number
  percent?: number
  elapsed?: number
}

export type AspectRatio =
  | '1:1' | '4:5' | '3:4' | '2:3' | '9:16'
  | '5:4' | '4:3' | '3:2' | '16:9' | '21:9'

export interface LoraSpec { name: string; scale: number }
/** An installed user LoRA (GET /loras); metadata fields come from its optional sidecar JSON. */
export interface LoraInfo {
  name: string
  size_mb: number
  display_name?: string
  description?: string
  default_scale?: number
  recommended?: string
  source?: string
  modes?: ('generate' | 'edit')[]
  trigger_words?: string[]
}
/** GET /loras (no model): the legacy Z-Image list plus every model family. */
export interface LoraListResponse {
  loras: LoraInfo[]
  compatible_models: string[]
  families?: Record<string, { models: string[]; loras: LoraInfo[] }>
}
/** GET /loras?model=<id>: that model's LoRA family, if it supports user LoRAs. */
export interface ModelLorasResponse {
  model: string
  family: string | null
  supported: boolean
  loras: LoraInfo[]
  compatible_models: string[]
}

export interface GenerateRequest {
  prompt: string
  negative_prompt?: string
  num_inference_steps?: number
  cfg_scale?: number
  seed?: number
  width?: number
  height?: number
  aspect_ratio?: AspectRatio
  base_size?: number
  use_lora?: boolean
  transparent?: boolean
  upscale?: boolean
  upscale_factor?: number
  upscale_model?: 'clean' | 'sharp'
  loras?: LoraSpec[]
}

export interface Img2ImgRequest extends Omit<GenerateRequest, 'aspect_ratio' | 'base_size' | 'cfg_scale'> {
  image?: string
  true_cfg_scale?: number
  reference_images?: string[]
}

export type TTSLanguage =
  | 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'pl' | 'tr' | 'ru' | 'nl'
  | 'cs' | 'ar' | 'zh-cn' | 'ja' | 'hu' | 'ko' | 'hi'

export interface TTSRequest {
  text: string
  actor: string
  language: TTSLanguage
  temperature: number
  speed: number
  split_sentences: boolean
}

export interface MayaTTSRequest {
  text: string
  voice_description: string
  temperature: number
  speed: number
}

export interface Actor {
  id: string
  name: string
  language: string
  description: string | null
  audio_count: number
  created_at: string
  updated_at: string
}

export interface ActorAudioFile {
  id: string
  filename: string
  original_name: string | null
  duration_seconds: number | null
  created_at: string
}

export interface MayaActor {
  id: string
  name: string
  voice_description: string
  created_at: string
  updated_at: string
}

export interface TTSHistoryEntry {
  id: string
  actor_name: string
  text: string
  language: string
  duration_seconds: number | null
  created_at: string
}

export interface TTSLanguageInfo { code: TTSLanguage; name: string }

export interface MusicGenerateRequest {
  caption: string
  lyrics?: string
  instrumental?: boolean
  bpm?: number | null
  keyscale?: string
  timesignature?: string
  duration?: number
  inference_steps?: number | null
  guidance_scale?: number
  seed?: number
  audio_format?: 'wav' | 'flac' | 'mp3'
  batch_size?: number
  model?: 'ace-step' | 'ace-step-quality'
}

export interface MusicAudioResult {
  index: number
  seed: number
  sample_rate: number
  download_url: string
}

export interface JobStatus<T = unknown> {
  job_id: string
  status: 'queued' | 'processing' | 'completed' | 'failed'
  progress?: number | null
  current_step?: number | null
  total_steps?: number | null
  elapsed_seconds?: number | null
  error?: string | null
  audios?: MusicAudioResult[] | null
  video_url?: string | null
  thumbnail_url?: string | null
  result?: T
}

export interface VideoGenerateRequest {
  prompt: string
  resolution?: '480p' | '720p'
  aspect_ratio?: '16:9' | '9:16' | '1:1'
  num_frames?: number
  num_inference_steps?: number
  guidance_scale?: number
  seed?: number
  fps?: number
  audio?: boolean
  image?: string
}

export interface VideoHistoryEntry {
  id: string
  prompt: string
  model: string
  resolution: string
  aspect_ratio: string
  num_frames: number
  duration_seconds: number
  created_at: string
  thumbnail_url: string | null
}

export interface Model3DRequest {
  text?: string
  image?: string
  octree_resolution?: number
  num_inference_steps?: number
  guidance_scale?: number
  texture?: boolean
  target_faces?: number
  seed?: number
  image_model?: string
  subject?: 'character' | 'object' | 'building' | 'auto'
}

export interface Model3DResult {
  id: string
  url: string
  ref_url?: string
  size_bytes: number
  created_at?: number
}

export interface VisionResponse { response: string; model: string }

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface LLMRequest {
  messages?: ChatMessage[]
  prompt?: string
  temperature?: number
  top_p?: number
  top_k?: number
  max_tokens?: number
  repetition_penalty?: number
  min_p?: number | null
  seed?: number | null
  system_prompt?: string | null
  enable_thinking?: boolean
}

export interface LLMResponse {
  text: string
  model: string
  input_tokens: number
  output_tokens: number
  generation_time_seconds: number
  seed?: number | null
}

export interface PixelArtRequest {
  prompt: string
  negative_prompt?: string
  num_inference_steps?: number
  seed?: number
  size?: number
  remove_background?: boolean
}

export interface SpriteRequest extends GenerateRequest {
  model: string
  output_size?: number
  remove_background?: boolean
}
