/**
 * Meal feedback serializers for the generalist matching engine.
 * Generalist vocabulary — no appetite/medication terms.
 */

export const FEEDBACK_VALUES = new Set(['liked', 'disliked', 'too_spicy', 'too_bland']);
export const REPEAT_VALUES = new Set(['would_repeat', 'no_repeat']);

export function parseFeedback(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const feedback = value.trim();
  return FEEDBACK_VALUES.has(feedback) ? feedback : null;
}

export function parseRepeat(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const repeat = value.trim();
  return REPEAT_VALUES.has(repeat) ? repeat : null;
}

export type MealFeedbackRow = {
  feedback_key: string;
  feedback: string | null;
  repeat: string | null;
  plan_id: number | null;
  recipe_title: string | null;
  day_label: string | null;
  meal_slot: string | null;
  calories: number | string | null;
  recorded_at: Date | string;
};

export function serializeMealFeedbackEntry(row: MealFeedbackRow) {
  const recorded =
    row.recorded_at instanceof Date
      ? row.recorded_at.getTime()
      : new Date(row.recorded_at).getTime();

  return {
    key: row.feedback_key,
    feedback: row.feedback,
    repeat: row.repeat,
    planId: row.plan_id,
    recipeTitle: row.recipe_title,
    day: row.day_label,
    slot: row.meal_slot,
    calories: row.calories != null ? Number(row.calories) : null,
    recordedAt: Number.isFinite(recorded) ? recorded : Date.now(),
    synced: true,
  };
}
