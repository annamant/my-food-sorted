/**
 * Food log service for the generalist journal.
 * Photo + text parsing into a nutrition estimate. No protein-target framing,
 * no GLP-1/appetite language — nutrition is shown as information, not a goal.
 */

export type FoodLogItem = {
  name: string;
  protein_g: number;
  calories: number | null;
  carbs_g: number | null;
  fat_g: number | null;
};

export type ParsedFoodLog = {
  items: FoodLogItem[];
  estimated_protein_g: number;
  estimated_calories: number | null;
  estimated_carbs_g: number | null;
  estimated_fat_g: number | null;
  coach_note: string;
  description?: string;
};

const FOOD_LOG_JSON_SHAPE = `{
  "description": "short plain summary of the meal, e.g. scrambled eggs with toast",
  "items": [{ "name": "short food label", "protein_g": number, "calories": number, "carbs_g": number, "fat_g": number }],
  "estimated_protein_g": number,
  "estimated_calories": number,
  "estimated_carbs_g": number,
  "estimated_fat_g": number,
  "coach_note": "1 to 2 sentences, warm, practical. One small idea about the meal — balance, variety, or a simple tweak. No medical advice. No bullet lists."
}`;

export const FOOD_LOG_PHOTO_PROMPT = `You analyze a photo of food for someone keeping a light food journal.

Identify what is on the plate or in the container. Estimate protein, calories, carbs, and fat for what is visible. If portion size is unclear, estimate conservatively.

Return ONLY valid JSON:
${FOOD_LOG_JSON_SHAPE}

Rules:
- Round every nutrition number to a whole number.
- estimated_calories is kcal for the visible portion.
- Sanity check: estimated_calories should be close to (protein_g × 4) + (carbs_g × 4) + (fat_g × 9). If far off, fix the macros to match the food.
- description is what you see, not advice.
- If the image is not food or is too unclear, set description to "Could not read this photo clearly", items to [], all nutrition fields to 0, and coach_note asking for a clearer photo or a text description.
- Never mention being an AI.
- No bullet lists in coach_note.`;

export const FOOD_LOG_PARSE_PROMPT = `You parse what someone ate or cooked into a nutrition estimate journal entry.

The user describes a meal or snack in plain language. Estimate protein, calories, carbs, and fat honestly (ranges are fine internally; output one best estimate per item and for the meal total).

Return ONLY valid JSON with this shape:
${FOOD_LOG_JSON_SHAPE}

Rules:
- Round every nutrition number to a whole number.
- estimated_calories is kcal for what they actually ate.
- Sanity check: estimated_calories should be close to (protein_g × 4) + (carbs_g × 4) + (fat_g × 9). If far off, fix the macros to match the food.
- If portion was partial, estimate what they actually ate.
- If description is vague, estimate conservatively and say so lightly in coach_note.
- Never mention being an AI.
- No bullet lists in coach_note.`;

function optionalWhole(value: unknown, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(Math.min(max, n));
}

function caloriesFromMacros(
  protein: number | null,
  carbs: number | null,
  fat: number | null
): number | null {
  if (carbs == null && fat == null) return null;
  return Math.round((protein ?? 0) * 4 + (carbs ?? 0) * 4 + (fat ?? 0) * 9);
}

export function parseFoodLogResponse(text: string): ParsedFoodLog {
  const trimmed = text.trim();
  let candidate = trimmed;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();

  const start = candidate.indexOf('{');
  if (start < 0) throw new Error('No JSON in food log response');

  let parsed: Record<string, unknown> | null = null;
  for (let i = candidate.lastIndexOf('}'); i >= start; i--) {
    if (candidate[i] !== '}') continue;
    try {
      parsed = JSON.parse(candidate.slice(start, i + 1)) as Record<string, unknown>;
      break;
    } catch {
      /* try shorter slice */
    }
  }

  if (!parsed) throw new Error('Invalid JSON in food log response');

  const itemsRaw = Array.isArray(parsed.items) ? parsed.items : [];
  const items = itemsRaw
    .map((row): FoodLogItem | null => {
      if (!row || typeof row !== 'object') return null;
      const r = row as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name.trim().slice(0, 200) : '';
      const protein = Number(r.protein_g);
      if (!name || !Number.isFinite(protein)) return null;
      return {
        name,
        protein_g: Math.max(0, Math.round(protein)),
        calories: optionalWhole(r.calories, 2000),
        carbs_g: optionalWhole(r.carbs_g, 250),
        fat_g: optionalWhole(r.fat_g, 150),
      };
    })
    .filter((row): row is FoodLogItem => row != null);

  let estimated = Number(parsed.estimated_protein_g);
  if (!Number.isFinite(estimated) || estimated < 0) {
    estimated = items.reduce((sum, item) => sum + item.protein_g, 0);
  }
  estimated = Math.round(estimated);

  let estimatedCarbs = optionalWhole(parsed.estimated_carbs_g, 400);
  if (estimatedCarbs == null) {
    const itemCarbs = items
      .map((item) => item.carbs_g)
      .filter((n): n is number => n != null);
    if (itemCarbs.length) estimatedCarbs = itemCarbs.reduce((sum, n) => sum + n, 0);
  }

  let estimatedFat = optionalWhole(parsed.estimated_fat_g, 200);
  if (estimatedFat == null) {
    const itemFat = items
      .map((item) => item.fat_g)
      .filter((n): n is number => n != null);
    if (itemFat.length) estimatedFat = itemFat.reduce((sum, n) => sum + n, 0);
  }

  let estimatedCalories = optionalWhole(parsed.estimated_calories, 3000);
  if (estimatedCalories == null) {
    const itemCalories = items
      .map((item) => item.calories)
      .filter((n): n is number => n != null);
    if (itemCalories.length) {
      estimatedCalories = itemCalories.reduce((sum, n) => sum + n, 0);
    } else {
      estimatedCalories = caloriesFromMacros(estimated, estimatedCarbs, estimatedFat);
    }
  }

  const coachNote =
    typeof parsed.coach_note === 'string' && parsed.coach_note.trim()
      ? parsed.coach_note.trim().slice(0, 2000)
      : 'Logged. Keep noting what you cook and eat.';

  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim().slice(0, 500)
      : undefined;

  return {
    items,
    estimated_protein_g: estimated,
    estimated_calories: estimatedCalories,
    estimated_carbs_g: estimatedCarbs,
    estimated_fat_g: estimatedFat,
    coach_note: coachNote,
    description,
  };
}

const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Max base64 payload (~4 MB decoded). */
const MAX_PHOTO_BASE64_CHARS = 5_500_000;

export function validateFoodLogPhotoInput(
  imageBase64: unknown,
  mimeType: unknown
): { base64: string; mime: string } {
  if (typeof imageBase64 !== 'string' || !imageBase64.trim()) {
    throw new Error('image_base64 is required');
  }
  const base64 = imageBase64.trim().replace(/^data:[^;]+;base64,/, '');
  if (base64.length > MAX_PHOTO_BASE64_CHARS) {
    throw new Error('Image is too large');
  }
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) {
    throw new Error('Invalid image data');
  }
  const mime = typeof mimeType === 'string' ? mimeType.trim().toLowerCase() : '';
  if (!PHOTO_MIME_TYPES.has(mime)) {
    throw new Error('mime_type must be image/jpeg, image/png, or image/webp');
  }
  return { base64, mime };
}
