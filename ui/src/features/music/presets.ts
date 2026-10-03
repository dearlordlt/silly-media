/**
 * Music page presets: genre templates (caption + lyrics) and settings profiles,
 * ported from the legacy ui-music.html. User profiles persist per profile via `kv`.
 */
import { kv } from '../../lib/kv'

export type SongModel = 'ace-step' | 'ace-step-quality'
export type AudioFormat = 'wav' | 'flac' | 'mp3'

export interface MusicSettings {
  model: SongModel
  caption: string
  lyrics: string
  instrumental: boolean
  bpm: string
  keyscale: string
  timesignature: string
  duration: number
  inferenceSteps: string
  guidanceScale: number
  seed: number
  audioFormat: AudioFormat
  batchSize: number
}

export const MUSIC_DEFAULTS: MusicSettings = {
  model: 'ace-step',
  caption: '',
  lyrics: '',
  instrumental: false,
  bpm: '',
  keyscale: '',
  timesignature: '4',
  duration: 30,
  inferenceSteps: '',
  guidanceScale: 7,
  seed: -1,
  audioFormat: 'wav',
  batchSize: 1,
}

export interface GenreTemplate { caption: string; lyrics: string; instrumental?: boolean }

export const GENRE_TEMPLATES: Record<string, GenreTemplate> = {
  'Rock': {
    caption: 'rock, electric guitar, drums, bass, 130 bpm, energetic, rebellious, gritty, male vocals, raw vocals',
    lyrics: '[Verse]\nRiding down the highway, wind against my face\nNothing gonna stop me, I\'m leaving this place\nThe engine\'s roaring louder as I press the gas\nLooking in the rearview, leaving behind the past\n\n[Chorus]\nWe\'re breaking free tonight\nUnder the neon lights\nWith the volume up so high\nWe\'re gonna touch the sky\n\n[Verse]\nThe city lights are fading in the dust behind\nA brand new world is waiting, one of a kind\nWith every mile I travel, I feel more alive\nThis is what it means to finally thrive\n\n[Chorus]\nWe\'re breaking free tonight\nUnder the neon lights\nWith the volume up so high\nWe\'re gonna touch the sky',
  },
  'Metal': {
    caption: 'metal, electric guitar, double kick drum, bass, 160 bpm, aggressive, intense, heavy, male vocals, screamed vocals',
    lyrics: '[Intro]\n[Instrumental]\n\n[Verse]\nFrom the ashes of a broken world we rise\nThrough the fire and the darkness, no compromise\nSteel and thunder in our veins tonight\nWe stand united, ready for the fight\n\n[Chorus]\nUnbreakable, we are the storm\nUnshakeable, we will transform\nThrough the chaos we will reign\nNothing left but blood and flame\n\n[Bridge]\n[Instrumental]\n\n[Verse]\nEvery scar upon our skin tells a tale\nOf battles fought through fire, wind, and hail\nWe are the ones who never bend or break\nThis is war, and everything\'s at stake\n\n[Chorus]\nUnbreakable, we are the storm\nUnshakeable, we will transform\nThrough the chaos we will reign\nNothing left but blood and flame',
  },
  'Pop': {
    caption: 'pop, synth, drums, guitar, 120 bpm, upbeat, catchy, vibrant, female vocals, polished vocals',
    lyrics: '[Verse]\nWoke up this morning with a smile on my face\nSunshine through the window, what a beautiful day\nGot my favorite song playing on repeat\nDancing in the kitchen, moving to the beat\n\n[Pre-Chorus]\nCan you feel it? The magic in the air\nEverything is golden everywhere\n\n[Chorus]\nLiving for the moment, living for today\nNothing\'s gonna take this feeling away\nTurn the music up and let your body sway\nWe\'re gonna make it, make it all okay\n\n[Verse]\nCall up all my friends, it\'s time to celebrate\nLife is way too short to sit around and wait\nEvery second counts, let\'s make it matter now\nWe\'ll figure out the rest somehow\n\n[Chorus]\nLiving for the moment, living for today\nNothing\'s gonna take this feeling away\nTurn the music up and let your body sway\nWe\'re gonna make it, make it all okay',
  },
  'Jazz': {
    caption: 'jazz, saxophone, piano, double bass, 110 bpm, smooth, improvisational, soulful, male vocals, crooning vocals',
    lyrics: '[Instrumental]',
    instrumental: true,
  },
  'Electronic': {
    caption: 'edm, synth, bass, kick drum, 128 bpm, euphoric, pulsating, energetic',
    lyrics: '[Intro]\n[Instrumental]\n\n[Verse]\nLost in the sound, the bass is underground\nLasers painting colors all around\nHeartbeat syncing to the kick drum pound\nIn this moment, we are finally found\n\n[Chorus]\nFeel the rhythm take control\nLet the music fill your soul\nHands up high, don\'t let go\nLet the energy overflow\n\n[Break]\n[Instrumental]\n\n[Chorus]\nFeel the rhythm take control\nLet the music fill your soul\nHands up high, don\'t let go\nLet the energy overflow',
  },
  'Classical': {
    caption: 'classical, orchestral, strings, piano, 60 bpm, elegant, emotive, timeless, instrumental',
    lyrics: '[Instrumental]',
    instrumental: true,
  },
  'Hip-Hop': {
    caption: 'hip hop, 808 bass, hi-hats, synth, 90 bpm, bold, urban, intense, male vocals, rhythmic vocals',
    lyrics: '[Verse]\nStarting from the bottom, now I\'m climbing to the top\nEvery single day I grind, I never gonna stop\nHaters throwing shade but I just let the music drop\nBeat so hard it make the whole damn building rock\n\n[Chorus]\nRise up, we don\'t stop\nFrom the basement to the rooftop\nStack it up, non-stop\nTill we sitting at the tippy top\n\n[Verse]\nCame up from nothing, built it all from scratch\nEvery single move I make, I\'m playing my own match\nNo shortcuts taken, every win I catch\nLight it up and watch the fire attach\n\n[Chorus]\nRise up, we don\'t stop\nFrom the basement to the rooftop\nStack it up, non-stop\nTill we sitting at the tippy top',
  },
  'Country': {
    caption: 'country, acoustic guitar, steel guitar, fiddle, 100 bpm, heartfelt, rustic, warm, male vocals, twangy vocals',
    lyrics: '[Verse]\nDust road stretching out for miles ahead\nOld truck rattling, holding on by a thread\nSunset painting gold across the land\nCold beer waiting in my weathered hand\n\n[Chorus]\nOut here where the stars shine bright\nWhere the crickets sing through the summer night\nAin\'t much but it\'s mine, it feels just right\nSmall town heart, big open sky tonight\n\n[Verse]\nFront porch memories of younger days\nMama\'s cooking, daddy\'s worn-out ways\nRiver running where we used to swim\nLife was simple back there on a whim\n\n[Chorus]\nOut here where the stars shine bright\nWhere the crickets sing through the summer night\nAin\'t much but it\'s mine, it feels just right\nSmall town heart, big open sky tonight',
  },
  'R&B': {
    caption: 'r&b, synth, bass, drums, 85 bpm, sultry, groovy, romantic, female vocals, silky vocals',
    lyrics: '[Verse]\nMoonlight spilling through the windowpane\nYour perfume lingering like sweet champagne\nEvery word you whisper pulls me closer still\nThis magnetic feeling, I can\'t get my fill\n\n[Chorus]\nStay with me tonight\nLet the world fade out of sight\nIn your arms everything\'s right\nStay with me tonight\n\n[Verse]\nSilk and shadows dancing on the wall\nYour laughter echoing down the hall\nTime stands still when I\'m here next to you\nEverything I need is in this room for two\n\n[Chorus]\nStay with me tonight\nLet the world fade out of sight\nIn your arms everything\'s right\nStay with me tonight',
  },
  'Ambient': {
    caption: 'ambient, atmospheric pads, synth, reverb, 70 bpm, spacious, dreamy, ethereal, instrumental',
    lyrics: '[Instrumental]',
    instrumental: true,
  },
  'Folk': {
    caption: 'folk, acoustic guitar, harmonica, fiddle, 95 bpm, warm, storytelling, organic, male vocals, gentle vocals',
    lyrics: '[Verse]\nDown by the river where the willows grow\nThere\'s a story that the old folks know\nAbout a traveler from a distant shore\nWho came seeking what he\'d lost before\n\n[Chorus]\nSing me a song of days gone by\nOf open roads beneath the sky\nWhere every stranger was a friend\nAnd every journey had no end\n\n[Verse]\nHe carried nothing but a worn guitar\nAnd a map of every wishing star\nFrom town to town he\'d play his tune\nUnder the pale and silver moon\n\n[Chorus]\nSing me a song of days gone by\nOf open roads beneath the sky\nWhere every stranger was a friend\nAnd every journey had no end',
  },
  'Reggae': {
    caption: 'reggae, guitar, bass, drums, 80 bpm, chill, soulful, positive, male vocals, smooth vocals',
    lyrics: '[Verse]\nSun is rising over the bay\nGolden morning, brand new day\nFeel the rhythm in the breeze\nSwaying gently through the trees\n\n[Chorus]\nOne love, one heart\nLet\'s come together from the start\nNo matter where you are\nThe music brings us close, near and far\n\n[Verse]\nChildren playing in the sand\nMusic flowing through the land\nEvery soul deserves to be free\nJust like the waves upon the sea\n\n[Chorus]\nOne love, one heart\nLet\'s come together from the start\nNo matter where you are\nThe music brings us close, near and far',
  },
}

export const BUILTIN_PROFILES: Record<string, Partial<MusicSettings>> = {
  'Quick Draft': { model: 'ace-step', duration: 30, inferenceSteps: '8', guidanceScale: 7, batchSize: 1, audioFormat: 'wav', instrumental: false },
  'High Quality': { model: 'ace-step-quality', duration: 60, inferenceSteps: '50', guidanceScale: 7, batchSize: 1, audioFormat: 'flac', instrumental: false },
  'Long Track': { model: 'ace-step', duration: 180, inferenceSteps: '8', guidanceScale: 7, batchSize: 1, audioFormat: 'wav', instrumental: false },
  'Instrumental Ambient': {
    model: 'ace-step-quality',
    duration: 60,
    inferenceSteps: '50',
    guidanceScale: 7,
    batchSize: 1,
    audioFormat: 'flac',
    instrumental: true,
    caption: 'ambient, atmospheric pads, ethereal textures, reverb, spacious, dreamy, instrumental',
    lyrics: '[Instrumental]',
  },
  'Vocal Pop': { model: 'ace-step', duration: 30, inferenceSteps: '8', guidanceScale: 7, batchSize: 2, audioFormat: 'wav', instrumental: false },
}

/** Lyric structure tags offered as quick-insert chips. */
export const SECTION_TAGS = ['[Intro]', '[Verse]', '[Pre-Chorus]', '[Chorus]', '[Bridge]', '[Hook]', '[Outro]', '[Instrumental]', '[Break]']

const PROFILES_KEY = 'silly-music-profiles'

/**
 * Narrow an untyped object (stored JSON, library meta) to the settings it
 * actually carries; unknown or mistyped keys are dropped.
 */
export function readSettings(value: unknown): Partial<MusicSettings> {
  if (typeof value !== 'object' || value === null) return {}
  const out: Partial<MusicSettings> = {}
  const v: Record<string, unknown> = { ...value }
  if (v.model === 'ace-step' || v.model === 'ace-step-quality') out.model = v.model
  if (typeof v.caption === 'string') out.caption = v.caption
  if (typeof v.lyrics === 'string') out.lyrics = v.lyrics
  if (typeof v.instrumental === 'boolean') out.instrumental = v.instrumental
  if (typeof v.bpm === 'string') out.bpm = v.bpm
  if (typeof v.keyscale === 'string') out.keyscale = v.keyscale
  if (typeof v.timesignature === 'string') out.timesignature = v.timesignature
  if (typeof v.duration === 'number') out.duration = v.duration
  if (typeof v.inferenceSteps === 'string') out.inferenceSteps = v.inferenceSteps
  if (typeof v.guidanceScale === 'number') out.guidanceScale = v.guidanceScale
  if (typeof v.seed === 'number') out.seed = v.seed
  if (v.audioFormat === 'wav' || v.audioFormat === 'flac' || v.audioFormat === 'mp3') out.audioFormat = v.audioFormat
  if (typeof v.batchSize === 'number') out.batchSize = v.batchSize
  return out
}

export function loadUserProfiles(): Record<string, Partial<MusicSettings>> {
  const raw = kv.getJson<unknown>(PROFILES_KEY, {})
  if (typeof raw !== 'object' || raw === null) return {}
  return Object.fromEntries(Object.entries(raw).map(([name, s]) => [name, readSettings(s)]))
}

export function saveUserProfiles(profiles: Record<string, Partial<MusicSettings>>) {
  kv.setJson(PROFILES_KEY, profiles)
}
