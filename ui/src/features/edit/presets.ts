/** Edit preset chips, ported from ui-img2img.html (prompt text used verbatim). */

export interface EditOption { id: string; label: string; prompt: string }
/** Free-text entry for a category: the typed text is turned into a prompt with `prefix` (unless it already starts with it). */
export interface EditCustom { placeholder: string; prefix: string }
export interface EditCategory { id: string; label: string; options: EditOption[]; custom: EditCustom }

export const EDIT_EMOTIONS: EditOption[] = [
  { id: 'smiling', label: 'Smiling', prompt: 'Make the person smiling warmly, gentle smile' },
  { id: 'happy', label: 'Happy', prompt: 'Make the person look happy and joyful' },
  { id: 'sad', label: 'Sad', prompt: 'Make the person look sad and melancholic' },
  { id: 'angry', label: 'Angry', prompt: 'Make the person look angry and intense' },
  { id: 'serious', label: 'Serious', prompt: 'Make the person look serious and focused' },
  { id: 'surprised', label: 'Surprised', prompt: 'Make the person look surprised and shocked' },
  { id: 'scared', label: 'Scared', prompt: 'Make the person look scared and fearful' },
  { id: 'disgusted', label: 'Disgusted', prompt: 'Make the person look disgusted' },
  { id: 'confused', label: 'Confused', prompt: 'Make the person look confused and puzzled' },
  { id: 'confident', label: 'Confident', prompt: 'Make the person look confident and proud' },
  { id: 'shy', label: 'Shy', prompt: 'Make the person look shy and embarrassed' },
  { id: 'tired', label: 'Tired', prompt: 'Make the person look tired and sleepy' },
  { id: 'seductive', label: 'Seductive', prompt: 'Make the person look seductive and alluring' },
  { id: 'flirty', label: 'Flirty', prompt: 'Make the person look flirty, biting lip, bedroom eyes' },
  { id: 'winking', label: 'Winking', prompt: 'Make the person winking playfully' },
  { id: 'laughing', label: 'Laughing', prompt: 'Make the person laughing joyfully' },
  { id: 'crying', label: 'Crying', prompt: 'Make the person crying emotionally' },
  { id: 'bored', label: 'Bored', prompt: 'Make the person look bored and unimpressed' },
  { id: 'playful', label: 'Playful', prompt: 'Make the person look playful and mischievous' },
  { id: 'curious', label: 'Curious', prompt: 'Make the person look curious and inquisitive' },
  { id: 'dreamy', label: 'Dreamy', prompt: 'Make the person look dreamy and lost in thought, soft gaze' },
  { id: 'fierce', label: 'Fierce', prompt: 'Make the person look fierce and powerful, intense stare' },
  { id: 'relaxed', label: 'Relaxed', prompt: 'Make the person look relaxed and calm' },
  { id: 'desperate', label: 'Desperate', prompt: 'Make the person look desperate and anxious' },
]

export const EDIT_GAZES: EditOption[] = [
  { id: 'camera', label: 'At Camera', prompt: 'Looking directly at the camera, making eye contact with the viewer' },
  { id: 'over-shoulder', label: 'Over Shoulder', prompt: 'Looking back over her shoulder at the camera' },
  { id: 'look-back', label: 'Looking Back', prompt: 'Turning her head to look back behind her' },
  { id: 'away', label: 'Looking Away', prompt: 'Looking away from the camera to the side' },
  { id: 'side-glance', label: 'Side Glance', prompt: 'Glancing sideways at the camera from the corner of her eyes' },
  { id: 'up-at-camera', label: 'Up at Camera', prompt: 'Looking up at the camera with raised eyes, head slightly lowered' },
  { id: 'down-at-camera', label: 'Down at Camera', prompt: 'Looking down at the camera from above' },
  { id: 'up', label: 'Looking Up', prompt: 'Looking upward toward the sky, eyes raised' },
  { id: 'down', label: 'Looking Down', prompt: 'Looking down at the ground, eyes lowered' },
  { id: 'own-body', label: 'At Own Body', prompt: 'Looking down at her own body' },
  { id: 'distance', label: 'Into Distance', prompt: 'Gazing into the distance with a dreamy faraway look' },
  { id: 'eyes-closed', label: 'Eyes Closed', prompt: 'Eyes closed, face relaxed' },
]

export const EDIT_POSES: EditOption[] = [
  { id: 'standing', label: 'Standing', prompt: 'Change pose to standing straight' },
  { id: 'sitting', label: 'Sitting', prompt: 'Change pose to sitting down' },
  { id: 'kneeling', label: 'Kneeling', prompt: 'Change pose to kneeling' },
  { id: 'lying', label: 'Lying', prompt: 'Change pose to lying down' },
  { id: 'leaning', label: 'Leaning', prompt: 'Change pose to leaning against something' },
  { id: 'crouching', label: 'Crouching', prompt: 'Change pose to crouching' },
  { id: 'walking', label: 'Walking', prompt: 'Change pose to walking' },
  { id: 'bending', label: 'Bending', prompt: 'Change pose to bending over' },
  { id: 'armsup', label: 'Arms Up', prompt: 'Change pose to arms raised above head' },
  { id: 'crossedarms', label: 'Crossed Arms', prompt: 'Change pose to arms crossed' },
  { id: 'handsonhips', label: 'Hands on Hips', prompt: 'Change pose to hands on hips' },
  { id: 'handsbehindback', label: 'Hands Behind Back', prompt: 'Change pose to hands behind back' },
  { id: 'spreadlegs', label: 'Spread Legs', prompt: 'Change pose to legs spread apart' },
  { id: 'lying-open', label: 'Lying Down Legs Open', prompt: 'Change pose to lying down with legs open' },
  { id: 'doggystyle', label: 'Doggy Style Pose', prompt: 'Change pose to crawling on hands and feets' },
  { id: 'dancing', label: 'Dancing', prompt: 'Change pose to dancing' },
]

export const EDIT_COMPOSITIONS: EditOption[] = [
  { id: 'keep-framing', label: 'Keep Framing', prompt: 'Maintain the same framing, composition, and camera distance' },
  { id: 'zoom-in', label: 'Zoom In', prompt: 'Zoom in closer on the subject, tighter framing, close-up shot' },
  { id: 'zoom-out', label: 'Zoom Out', prompt: 'Zoom out to show more of the surroundings, wider shot, full body visible' },
  { id: 'close-up-face', label: 'Close-Up Face', prompt: 'Close-up portrait shot of the face, head and shoulders only' },
  { id: 'full-body', label: 'Full Body', prompt: 'Show the full body from head to toe, full-length shot' },
  { id: 'from-above', label: 'From Above', prompt: "Change camera angle to looking down from above, bird's eye view" },
  { id: 'from-below', label: 'From Below', prompt: 'Change camera angle to looking up from below, low angle shot' },
  { id: 'side-view', label: 'Side View', prompt: 'Change to a side profile view' },
  { id: 'from-behind', label: 'From Behind', prompt: 'Change to a rear view, seen from behind' },
  { id: 'golden-hour', label: 'Golden Hour', prompt: 'Change lighting to warm golden hour sunset lighting' },
  { id: 'night', label: 'Night', prompt: 'Change lighting to nighttime, dark ambient mood lighting' },
]

export const EDIT_LOCATIONS: EditOption[] = [
  { id: 'beach', label: 'Beach', prompt: 'Change location to a tropical beach with sand and ocean' },
  { id: 'bedroom', label: 'Bedroom', prompt: 'Change location to a cozy bedroom interior' },
  { id: 'bathroom', label: 'Bathroom', prompt: 'Change location to a luxurious bathroom with bathtub' },
  { id: 'shower', label: 'Shower', prompt: 'Change location to a steamy shower, wet skin, water droplets' },
  { id: 'pool', label: 'Pool', prompt: 'Change location to a swimming pool area' },
  { id: 'hot-tub', label: 'Hot Tub', prompt: 'Change location to a hot tub, steamy water, relaxing' },
  { id: 'forest', label: 'Forest', prompt: 'Change location to a lush green forest' },
  { id: 'garden', label: 'Garden', prompt: 'Change location to a beautiful garden with flowers' },
  { id: 'city-street', label: 'City Street', prompt: 'Change location to a busy city street' },
  { id: 'rooftop', label: 'Rooftop', prompt: 'Change location to a city rooftop with skyline view' },
  { id: 'cafe', label: 'Cafe', prompt: 'Change location to a cozy cafe interior' },
  { id: 'bar', label: 'Bar', prompt: 'Change location to a dimly lit bar, moody atmosphere' },
  { id: 'office', label: 'Office', prompt: 'Change location to a modern office interior' },
  { id: 'library', label: 'Library', prompt: 'Change location to a library with bookshelves' },
  { id: 'studio', label: 'Photo Studio', prompt: 'Change location to a photo studio with professional lighting' },
  { id: 'gym', label: 'Gym', prompt: 'Change location to a gym, workout equipment' },
  { id: 'kitchen', label: 'Kitchen', prompt: 'Change location to a modern kitchen interior' },
  { id: 'living-room', label: 'Living Room', prompt: 'Change location to a stylish living room with couch' },
  { id: 'balcony', label: 'Balcony', prompt: 'Change location to a balcony with scenic view' },
  { id: 'yacht', label: 'Yacht', prompt: 'Change location to a luxury yacht on the ocean' },
  { id: 'hotel-room', label: 'Hotel Room', prompt: 'Change location to a luxury hotel room with large bed' },
  { id: 'park', label: 'Park', prompt: 'Change location to a public park with trees and grass' },
  { id: 'mountain', label: 'Mountain', prompt: 'Change location to a mountain landscape with scenic views' },
  { id: 'snow', label: 'Snow', prompt: 'Change location to a snowy winter landscape' },
  { id: 'desert', label: 'Desert', prompt: 'Change location to a sandy desert with dunes' },
  { id: 'castle', label: 'Castle', prompt: 'Change location to an elegant castle interior' },
]

export const EDIT_BODY: EditOption[] = [
  { id: 'naked', label: 'Naked', prompt: 'Completely naked, nude, no clothes, exposed breasts with visible nipples, anatomically correct vulva, visible pussy, realistic female genitalia, full frontal nudity' },
  { id: 'topless', label: 'Topless', prompt: 'Topless, no top, bare breasts with visible nipples, areolas visible' },
  { id: 'bottomless', label: 'Bottomless', prompt: 'Bottomless, no pants, no skirt, no underwear, exposed lower body, visible pussy' },
  { id: 'see-through', label: 'See-Through', prompt: 'Wearing see-through transparent clothing, nipples visible through fabric' },
  { id: 'panties', label: 'Panties', prompt: 'Topless, wearing only white lace panties, nothing else, bare breasts' },
  { id: 'thong', label: 'Thong', prompt: 'Topless, wearing only a black lace thong, nothing else, bare breasts' },
  { id: 'string-thong', label: 'String Thong', prompt: 'Topless, wearing only a tiny black string thong with thin side strings, nothing else, bare breasts' },
  { id: 'g-string', label: 'G-String', prompt: 'Topless, wearing only a minimal red G-string with a tiny front triangle, nothing else, bare breasts' },
  { id: 'micro-thong', label: 'Micro Thong', prompt: 'Topless, wearing only an extremely small black micro thong, nothing else, bare breasts' },
  { id: 'bikini-bottom', label: 'Bikini Bottom', prompt: 'Topless, wearing only a black string bikini bottom tied at the hips, nothing else, bare breasts' },
  { id: 'cheeky', label: 'Cheeky Panties', prompt: 'Topless, wearing only black cheeky lace panties that show half of the buttocks, nothing else, bare breasts' },
  { id: 'high-cut', label: 'High-Cut Panties', prompt: 'Topless, wearing only white high-cut panties with the sides pulled high over the hips, nothing else, bare breasts' },
  { id: 'sheer-panties', label: 'Sheer Panties', prompt: 'Topless, wearing only sheer black see-through mesh panties, nothing else, bare breasts' },
  { id: 'crotchless', label: 'Crotchless Panties', prompt: 'Topless, wearing only open black crotchless lace panties, nothing else, bare breasts' },
  { id: 'satin-panties', label: 'Satin Panties', prompt: 'Topless, wearing only shiny red satin panties, nothing else, bare breasts' },
  { id: 'boyshorts', label: 'Lace Boyshorts', prompt: 'Topless, wearing only white lace boyshort panties, nothing else, bare breasts' },
]

export const EDIT_OUTFITS: EditOption[] = [
  { id: 'bikini', label: 'Bikini', prompt: 'Wearing a skimpy bikini swimsuit' },
  { id: 'lingerie', label: 'Lingerie', prompt: 'Wearing sexy lingerie with lace bra and panties' },
  { id: 'stockings', label: 'Stockings & Garter', prompt: 'Wearing thigh-high stockings with garter belt' },
  { id: 'schoolgirl', label: 'Schoolgirl', prompt: 'Wearing a schoolgirl uniform with plaid skirt, white blouse, knee-high socks' },
  { id: 'maid', label: 'Maid', prompt: 'Wearing a French maid uniform with frilly apron and headband' },
  { id: 'skimpy-maid', label: 'Skimpy Maid', prompt: 'Wearing a skimpy French maid outfit with very short skirt, stockings, exposed cleavage' },
  { id: 'nurse', label: 'Nurse', prompt: 'Wearing a sexy nurse costume with short white dress and stockings' },
  { id: 'secretary', label: 'Secretary', prompt: 'Wearing a tight pencil skirt, blouse unbuttoned, glasses, office attire' },
  { id: 'cocktail-dress', label: 'Cocktail Dress', prompt: 'Wearing an elegant short cocktail dress with heels' },
  { id: 'evening-gown', label: 'Evening Gown', prompt: 'Wearing a long elegant evening gown with deep neckline' },
  { id: 'gym', label: 'Gym Outfit', prompt: 'Wearing tight sports bra and yoga pants, athletic wear' },
  { id: 'sundress', label: 'Sundress', prompt: 'Wearing a light flowy sundress' },
  { id: 'leather', label: 'Leather', prompt: 'Wearing tight leather outfit, leather pants and corset' },
  { id: 'latex', label: 'Latex', prompt: 'Wearing shiny latex bodysuit, form-fitting' },
  { id: 'towel', label: 'Towel', prompt: 'Wrapped in a towel, just out of the shower' },
  { id: 'oversized-shirt', label: 'Oversized Shirt', prompt: 'Wearing only an oversized shirt, no pants, bare legs' },
]

export const EDIT_SHOES: EditOption[] = [
  { id: 'stilettos', label: 'Stiletto Heels', prompt: 'Wearing glossy black stiletto high heels with very thin tall heels' },
  { id: 'red-pumps', label: 'Red Pumps', prompt: 'Wearing shiny red patent leather pointed-toe pumps with high stiletto heels' },
  { id: 'red-sole', label: 'Red-Sole Pumps', prompt: 'Wearing black patent leather high heel pumps with glossy red soles' },
  { id: 'platform-heels', label: 'Platform Heels', prompt: 'Wearing high platform heels with a thick front platform and tall stiletto heels' },
  { id: 'platform-sandals', label: 'Platform Sandals', prompt: 'Wearing very high strappy platform sandals with thin straps across the toes and around the ankles' },
  { id: 'pleasers', label: 'Pole Dancer Heels', prompt: 'Wearing extreme clear perspex platform stripper heels with 8-inch stiletto heels' },
  { id: 'strappy-sandals', label: 'Strappy Sandals', prompt: 'Wearing delicate strappy high heel sandals with thin straps, bare painted toes visible' },
  { id: 'ankle-strap', label: 'Ankle-Strap Heels', prompt: 'Wearing open-toe high heels with a thin buckled ankle strap' },
  { id: 'gladiator', label: 'Lace-Up Gladiator Heels', prompt: 'Wearing lace-up gladiator high heel sandals with straps wrapping up the calves' },
  { id: 'peep-toe', label: 'Peep-Toe Heels', prompt: 'Wearing peep-toe high heels with a small open toe' },
  { id: 'mules', label: 'Heeled Mules', prompt: 'Wearing backless high heel mules with pointed toes' },
  { id: 'clear-heels', label: 'Clear Heels', prompt: 'Wearing transparent clear vinyl high heel sandals with clear stiletto heels' },
  { id: 'mary-janes', label: 'Mary Jane Heels', prompt: 'Wearing glossy Mary Jane high heels with a strap across the instep' },
  { id: 'wedges', label: 'Wedge Sandals', prompt: 'Wearing high wedge sandals with ankle ties' },
  { id: 'ankle-boots', label: 'Stiletto Ankle Boots', prompt: 'Wearing sleek black leather stiletto ankle boots' },
  { id: 'knee-boots', label: 'Knee-High Boots', prompt: 'Wearing tight knee-high leather boots with high stiletto heels' },
  { id: 'otk-boots', label: 'Over-the-Knee Boots', prompt: 'Wearing over-the-knee suede boots with high stiletto heels' },
  { id: 'thigh-boots', label: 'Thigh-High Boots', prompt: 'Wearing glossy thigh-high patent leather boots with high stiletto heels' },
  { id: 'latex-boots', label: 'Latex Platform Boots', prompt: 'Wearing shiny black latex thigh-high platform boots with very high heels' },
  { id: 'ballet-heels', label: 'Ballet Heels', prompt: 'Wearing extreme black ballet boot heels that force the feet into a pointed tiptoe position' },
  { id: 'kitten-heels', label: 'Kitten Heels', prompt: 'Wearing elegant pointed kitten heels with short slim heels' },
  { id: 'barefoot', label: 'Barefoot', prompt: 'Barefoot, no shoes, bare feet with painted toenails' },
]

export const EDIT_CATEGORIES: EditCategory[] = [
  { id: 'emotions', label: 'Emotions', options: EDIT_EMOTIONS, custom: { placeholder: 'Custom emotion… (e.g. nervous, smirking)', prefix: 'Make the person look' } },
  { id: 'poses', label: 'Poses', options: EDIT_POSES, custom: { placeholder: 'Custom pose… (e.g. sitting on the edge of a bed)', prefix: 'Change pose to' } },
  { id: 'gazes', label: 'Gaze', options: EDIT_GAZES, custom: { placeholder: 'Custom gaze… (e.g. at the mirror)', prefix: 'Looking' } },
  { id: 'composition', label: 'Composition', options: EDIT_COMPOSITIONS, custom: { placeholder: 'Custom framing, camera or lighting…', prefix: '' } },
  { id: 'locations', label: 'Locations', options: EDIT_LOCATIONS, custom: { placeholder: 'Custom location…', prefix: 'Change location to' } },
  { id: 'body', label: 'Body', options: EDIT_BODY, custom: { placeholder: 'Custom body / undress description…', prefix: '' } },
  { id: 'outfits', label: 'Outfits', options: EDIT_OUTFITS, custom: { placeholder: 'Custom outfit… (e.g. a red leather jacket)', prefix: 'Wearing' } },
  { id: 'shoes', label: 'Shoes', options: EDIT_SHOES, custom: { placeholder: 'Custom shoes… (e.g. white sneakers)', prefix: 'Wearing' } },
]

/** Prompt for a custom chip: `prefix text`, without doubling a prefix the user already typed. */
export function customPrompt(custom: EditCustom, text: string): string {
  const t = text.trim()
  if (!custom.prefix || t.toLowerCase().startsWith(custom.prefix.toLowerCase())) return t.charAt(0).toUpperCase() + t.slice(1)
  return `${custom.prefix} ${t}`
}

/** Chip label for a custom entry: the text without the category prefix, capitalised like preset chips. */
export function customLabel(custom: EditCustom, text: string): string {
  let t = text.trim()
  if (custom.prefix && t.toLowerCase().startsWith(custom.prefix.toLowerCase())) t = t.slice(custom.prefix.length).trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** A qwen-image-2.1 preset chip.
 *  transparent: request an RGBA cutout; needsRef: prompt mentions "image 2";
 *  fill: clicking inserts the prompt into the instruction so its [placeholder] can be edited. */
export interface Qwen21Preset { id: string; label: string; prompt: string; needsRef?: boolean; fill?: boolean; transparent?: boolean }

/** qwen-image-2.1 reference-aware edits (ui-img2img.html, plus the extra ones from ui.html's edit modal). */
export const QWEN21_EDIT_PRESETS: Qwen21Preset[] = [
  { id: 'q21-extract', label: 'Extract Subject', transparent: true, prompt: 'Remove the background and make it transparent, keep only the main subject exactly as it is.' },
  { id: 'q21-bg-beach', label: 'Background: Sunset Beach', prompt: 'Replace the background with a sunset beach: golden sand, gentle waves and a warm orange and pink sky near the horizon. Keep the subject unchanged: same face, pose, clothing and proportions. Match the subject lighting to the warm sunset light so it blends naturally.' },
  { id: 'q21-bg-studio', label: 'Background: Studio', prompt: 'Replace the background with a clean light-grey photo studio backdrop with soft shadows, keep the subject unchanged.' },
  { id: 'q21-insert-ref', label: 'Put Image 2 Subject into Scene', needsRef: true, prompt: 'Place the main subject from image 2 into the scene of image 1. Keep the scene of image 1 unchanged and keep the identity, appearance and clothing of the subject from image 2. Match the perspective, scale, lighting direction, color temperature and shadows of image 1 so the subject looks naturally photographed in that scene.' },
  { id: 'q21-combine-people', label: 'Combine People (1 + 2)', needsRef: true, prompt: 'Combine the person from image 1 and the person from image 2 into one natural photo of them standing side by side. Preserve both faces, hairstyles, body types and outfits exactly. Use consistent lighting, perspective and scale for both people, with a simple matching background, as if taken with one camera in a single shot.' },
  { id: 'q21-outfit-ref', label: 'Wear Image 2 Outfit', needsRef: true, prompt: 'Dress the person from image 1 in the outfit shown in image 2, keep the face, pose and background unchanged.' },
  { id: 'q21-oil', label: 'Oil Painting', prompt: 'Restyle the image as a classical oil painting on canvas: visible thick brushstrokes, rich layered colors, soft blended shadows and subtle canvas texture. Keep the same composition, subject, pose and facial features.' },
  { id: 'q21-anime', label: 'Anime Illustration', prompt: 'Restyle the image as a high-quality anime illustration: clean line art, cel shading, vibrant colors, expressive anime eyes and a softly painted background. Keep the same composition, pose, hairstyle and outfit.' },
  { id: 'q21-golden-hour', label: 'Relight: Golden Hour', prompt: 'Relight the scene with soft golden-hour sunlight coming from a low angle on one side: warm orange highlights, long soft shadows, gentle rim light on hair and shoulders. Keep the subject, pose, composition and background content unchanged.' },
  { id: 'q21-night', label: 'Relight: Night', prompt: 'Turn the scene into night with moonlight and warm practical lights, keep the subject unchanged.' },
  { id: 'q21-sign-text', label: 'Replace Sign Text', fill: true, prompt: 'Replace the text on the sign with "[NEW TEXT]". Match the original font style, size, color, perspective and lighting of the sign. Keep everything else unchanged.' },
  { id: 'q21-remove', label: 'Remove Object', fill: true, prompt: 'Remove the [OBJECT OR PERSON] from the image and fill the area with a natural continuation of the surrounding background. Keep everything else unchanged, with no visible traces, blur or artifacts.' },
  { id: 'q21-outfit', label: 'Change Outfit', fill: true, prompt: 'Change the outfit of the person to [NEW OUTFIT]. Keep the same face, hairstyle, body shape, pose, background and lighting. The new clothing should fit naturally with realistic folds and shadows.' },
]

export const DEFAULT_NEGATIVE = 'ugly, deformed, disfigured, low quality, blurry, bad anatomy, extra limbs, male, penis, masculine, man, boy'
/** Appended to the negative whenever a nude body chip (or a "naked" clothed-variant) is part of the prompt. */
export const CLOTHES_NEGATIVE = 'clothes, clothing, dressed, bra, underwear, panties, shirt, dress, bikini, swimsuit, lingerie'
/** Removes most of qwen-image-2.1's halftone / paper-print texture when CFG > 1. */
export const QWEN21_TEXTURE_NEGATIVE = 'halftone, dithering, noise, grain, printed texture, paper texture, jpeg artifacts, oversharpened'
/** Body chips that make the clothes negative apply. */
export const NUDE_BODY_IDS: Record<string, true> = { naked: true, topless: true, bottomless: true }
/** Suffix of the "Naked" half of a clothed-variants pair (ui.html edit modal). */
export const NAKED_VARIANT_SUFFIX = 'Completely naked, nude, no clothes, exposed breasts, anatomically correct vulva, realistic female genitalia, full frontal nudity'

export const QWEN21_MODEL = 'qwen-image-2.1'
/** Display names for the model select (values stay the API model ids). */
export const MODEL_LABELS: Record<string, string> = {
  'qwen-image-edit': 'Qwen Image Edit',
  [QWEN21_MODEL]: 'Qwen Image 2.1 Uncensored',
}
export const QWEN21_MAX_SIDE = 3072
export const QWEN21_MAX_REFS = 9

export type SizeMode = 'match' | '1.5k' | '2k' | 'original'
export const SIZE_MODES: { value: SizeMode; label: string }[] = [
  { value: 'match', label: 'Match input (~1MP)' },
  { value: '1.5k', label: '1.5K' },
  { value: '2k', label: '2K' },
  { value: 'original', label: 'Original size' },
]
const SIZE_TARGETS: Record<'1.5k' | '2k', number> = { '1.5k': 1536, '2k': 2048 }

/** Scale (w, h) down so the long side fits the model limit, then floor both to multiples of 32. */
function clampToModelSize(w: number, h: number) {
  const scale = Math.min(1, QWEN21_MAX_SIDE / Math.max(w, h))
  return {
    width: Math.max(32, Math.floor((w * scale) / 32) * 32),
    height: Math.max(32, Math.floor((h * scale) / 32) * 32),
  }
}

/** Output size to request, or null to let the server pick (~1MP at the input aspect). */
export function computeOutputSize(mode: SizeMode, srcW: number, srcH: number): { width: number; height: number } | null {
  if (!srcW || !srcH || mode === 'match') return null
  if (mode === 'original') return clampToModelSize(srcW, srcH)
  const target = SIZE_TARGETS[mode]
  const aspect = srcW / srcH
  const width = Math.max(32, Math.round(target * Math.sqrt(aspect) / 32) * 32)
  const height = Math.max(32, Math.round(target / Math.sqrt(aspect) / 32) * 32)
  if (Math.max(width, height) > QWEN21_MAX_SIDE) return clampToModelSize(width, height)
  return { width, height }
}

/** Speed-LoRA label and steps/cfg defaults per edit model (with / without the LoRA). */
export interface ModelDefaults {
  loraLabel: string
  on: { steps: number; cfg: number; minSteps: number }
  off: { steps: number; cfg: number; minSteps: number }
  /** The LoRA forces CFG to 1 (qwen-image-2.1 turbo). */
  loraLocksCfg: boolean
}
const QWEN_EDIT_DEFAULTS: ModelDefaults = {
  loraLabel: 'Lightning LoRA (fast)',
  on: { steps: 6, cfg: 1, minSteps: 4 },
  off: { steps: 20, cfg: 4, minSteps: 10 },
  loraLocksCfg: false,
}
const MODEL_DEFAULTS: Record<string, ModelDefaults> = {
  'qwen-image-edit': QWEN_EDIT_DEFAULTS,
  [QWEN21_MODEL]: {
    loraLabel: 'Turbo LoRA (6 steps)',
    on: { steps: 6, cfg: 1, minSteps: 5 },
    off: { steps: 40, cfg: 1, minSteps: 10 },
    loraLocksCfg: true,
  },
}
export function modelDefaults(model: string): ModelDefaults {
  return MODEL_DEFAULTS[model] ?? QWEN_EDIT_DEFAULTS
}
export const MAX_STEPS = 50

/** qwen-image-2.1 one-click sampling presets. */
export const QWEN21_SETTINGS_PRESETS: { id: string; label: string; title: string; lora: boolean; steps: number; cfg: number; textureNegative?: boolean }[] = [
  { id: 'turbo6', label: 'Turbo 6', title: 'Turbo LoRA, 6 steps', lora: true, steps: 6, cfg: 1 },
  { id: 'turbo9', label: 'Turbo 9 hybrid', title: '7 turbo + 2 base steps', lora: true, steps: 9, cfg: 1 },
  { id: 'base40', label: 'Base 40', title: 'Base model, 40 steps, no CFG', lora: false, steps: 40, cfg: 1 },
  { id: 'base40cfg3', label: 'Base 40 + CFG 3 (clean)', title: 'True CFG 3 + anti-texture negative: cleanest output (~1.7x slower)', lora: false, steps: 40, cfg: 3, textureNegative: true },
]

/** Join prompt fragments with ". " without doubling periods of fragments that already end in one. */
export function joinPromptParts(parts: string[]): string {
  return parts.map((p) => p.trim().replace(/\.+$/, '')).join('. ')
}
