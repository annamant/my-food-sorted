import type { Pool, PoolClient } from 'pg';

export type CompanionPromptSuggestion = {
  text: string;
  meal_plan_id?: number | null;
  recipe_title?: string | null;
  plan_name?: string | null;
};

export type CompanionRecentMeal = {
  meal_plan_id: number;
  plan_name: string | null;
  recipe_title: string | null;
  created_at: Date;
  feedback: string | null;
  repeat: string | null;
  feedback_at: Date | null;
};

export type CompanionMealContext = {
  recent_meals: CompanionRecentMeal[];
  prompts: CompanionPromptSuggestion[];
};

const GENERIC_PROMPTS: CompanionPromptSuggestion[] = [
  { text: 'What should I cook tonight?' },
  { text: 'I\'m in a cooking rut' },
  { text: 'Help me use what\'s in my cupboard' },
  { text: 'Plan a week of dinners' },
  { text: 'I want to try a new cuisine' },
];

function daysSince(date: Date | null | undefined): number | null {
  if (!date) return null;
  const ms = Date.now() - new Date(date).getTime();
  if (Number.isNaN(ms)) return null;
  return ms / (1000 * 60 * 60 * 24);
}

function feedbackLabel(feedback: string | null | undefined): string | null {
  switch (feedback) {
    case 'liked':
      return 'you liked';
    case 'disliked':
      return 'wasn\'t for you';
    case 'too_spicy':
      return 'was too spicy';
    case 'too_bland':
      return 'was too bland';
    default:
      return null;
  }
}

function repeatLabel(repeat: string | null | undefined): string | null {
  switch (repeat) {
    case 'would_repeat':
      return 'you\'d cook again';
    case 'no_repeat':
      return 'you wouldn\'t repeat';
    default:
      return null;
  }
}

export async function loadCompanionMealContext(
  db: Pool | PoolClient,
  userId: number
): Promise<CompanionMealContext> {
  const mealsResult = await db.query<{
    meal_plan_id: number;
    plan_name: string | null;
    recipe_title: string | null;
    created_at: Date;
    feedback: string | null;
    repeat: string | null;
    feedback_at: Date | null;
  }>(
    `SELECT
       mp.id AS meal_plan_id,
       mp.plan_name,
       mp.created_at,
       (
         SELECT r.title FROM recipes r
         WHERE r.meal_plan_id = mp.id
         ORDER BY r.id ASC
         LIMIT 1
       ) AS recipe_title,
       mf.feedback,
       mf.repeat,
       mf.recorded_at AS feedback_at
     FROM meal_plans mp
     LEFT JOIN LATERAL (
       SELECT feedback, repeat, recorded_at
       FROM meal_feedback
       WHERE user_id = mp.user_id AND plan_id = mp.id
       ORDER BY recorded_at DESC
       LIMIT 1
     ) mf ON TRUE
     WHERE mp.user_id = $1
     ORDER BY mp.created_at DESC
     LIMIT 8`,
    [userId]
  );

  const recent_meals = mealsResult.rows.map((row) => ({
    meal_plan_id: row.meal_plan_id,
    plan_name: row.plan_name,
    recipe_title: row.recipe_title,
    created_at: row.created_at,
    feedback: row.feedback,
    repeat: row.repeat,
    feedback_at: row.feedback_at,
  }));

  const prompts: CompanionPromptSuggestion[] = [];
  const seen = new Set<string>();

  const pushPrompt = (item: CompanionPromptSuggestion) => {
    const key = item.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    prompts.push(item);
  };

  const latestFeedback = await db.query<{
    plan_id: number | null;
    recipe_title: string | null;
    feedback: string | null;
    repeat: string | null;
    recorded_at: Date;
  }>(
    `SELECT plan_id, recipe_title, feedback, repeat, recorded_at
     FROM meal_feedback
     WHERE user_id = $1
     ORDER BY recorded_at DESC
     LIMIT 1`,
    [userId]
  );

  const fb = latestFeedback.rows[0];
  if (fb?.recipe_title && daysSince(fb.recorded_at) != null && daysSince(fb.recorded_at)! <= 4) {
    const dish = fb.recipe_title;
    const repeat = repeatLabel(fb.repeat);
    const label = feedbackLabel(fb.feedback);
    if (repeat === 'you\'d cook again') {
      pushPrompt({
        text: `I\'d cook ${dish} again. What else is like it?`,
        meal_plan_id: fb.plan_id,
        recipe_title: dish,
      });
    } else if (repeat === 'you wouldn\'t repeat') {
      pushPrompt({
        text: `${dish} wasn\'t for me. Let\'s try something different.`,
        meal_plan_id: fb.plan_id,
        recipe_title: dish,
      });
    } else if (label === 'was too spicy') {
      pushPrompt({
        text: `${dish} was too spicy for me. Something milder next?`,
        meal_plan_id: fb.plan_id,
        recipe_title: dish,
      });
    } else if (label === 'was too bland') {
      pushPrompt({
        text: `${dish} was too bland. How do I get more flavour?`,
        meal_plan_id: fb.plan_id,
        recipe_title: dish,
      });
    } else if (label === 'you liked') {
      pushPrompt({
        text: `I liked ${dish}.`,
        meal_plan_id: fb.plan_id,
        recipe_title: dish,
      });
    }
  }

  for (const meal of recent_meals) {
    if (prompts.length >= 6) break;
    const title = meal.recipe_title || meal.plan_name;
    if (!title) continue;
    const age = daysSince(meal.created_at);
    if (meal.feedback) continue;
    if (age != null && age <= 7) {
      pushPrompt({
        text: `I saved ${title} but haven\'t cooked it yet. Help me think it through.`,
        meal_plan_id: meal.meal_plan_id,
        recipe_title: meal.recipe_title,
        plan_name: meal.plan_name,
      });
      break;
    }
  }

  for (const meal of recent_meals) {
    if (prompts.length >= 6) break;
    const title = meal.recipe_title || meal.plan_name;
    if (!title || !meal.feedback_at) continue;
    const age = daysSince(meal.feedback_at);
    if (age != null && age <= 2) {
      pushPrompt({
        text: `Reflecting on ${title} from the last couple of days.`,
        meal_plan_id: meal.meal_plan_id,
        recipe_title: meal.recipe_title,
        plan_name: meal.plan_name,
      });
    }
  }

  for (const generic of GENERIC_PROMPTS) {
    if (prompts.length >= 6) break;
    pushPrompt(generic);
  }

  return { recent_meals, prompts };
}

export function formatMealContextForPrompt(context: CompanionMealContext): string {
  if (!context.recent_meals.length) return '';

  const lines = context.recent_meals.slice(0, 5).map((meal) => {
    const title = meal.recipe_title || meal.plan_name || 'a saved meal';
    const fb = meal.feedback ? feedbackLabel(meal.feedback) : null;
    const repeat = meal.repeat ? repeatLabel(meal.repeat) : null;
    const notes = [fb, repeat].filter(Boolean).join(', ');
    return notes ? `${title} (${notes})` : title;
  });

  return `\n\nRecent saved meals (mention lightly if relevant, do not list back unless helpful):\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

export const COMPANION_SUMMARY_PROMPT = `You write a private journal summary for a home cook using My Food SORTED.

Read the chat transcript and write 3 to 5 sentences in first person ("I"), as if the user is capturing the thread for themselves.

Include what they cooked or wanted to cook, budget or cupboard concerns, cooking confidence, small wins, and any next steps if they came up. Warm and honest. No bullet lists. No mention of being an AI.`;
