import 'dotenv/config';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { authenticateToken, AuthenticatedRequest } from './middleware/auth';
import { Pool, PoolClient } from 'pg';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { config, RETAILERS, type Retailer } from './config';
import { attachRecipeImages, isAllowedImageUrl } from './recipeImages';

// Config is validated at import (config.ts); server exits if JWT_SECRET or OPENAI_API_KEY missing.

// ---------------------------------------------------------------------------
// Database Connection Pool
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err: Error) => {
  console.error('Unexpected database pool error:', err);
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(level: string, msg: string, meta?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${timestamp}] [${level}] ${msg}${metaStr}`);
}

// ---------------------------------------------------------------------------
// OpenAI API Integration
// ---------------------------------------------------------------------------

const MEAL_PLANNING_SYSTEM_PROMPT = `You are the My Food SORTED kitchen — a UK home-cooking coach for a personal recipe library (think Spotify for food: get classics, remix them, cook from what's in, save what you love).

STRUCTURED MEAL BRIEF (HARD CONSTRAINTS — NON-NEGOTIABLE):
- The app often sends a structured meal brief (people, days, meals, cuisines, cooking methods, proteins, pantry, avoid list, cook-time cap, budget, notes).
- When a brief is present, you MUST obey it completely. Do not invent conflicting choices.
- Proteins listed: use those proteins as the main protein(s). Do not switch to chicken/fish/veg if they asked for beef (etc.).
- Meal slots listed: only create those meal types. If only "dinner" is listed, do NOT add brunch/lunch/breakfast.
- Breakfast is its own meal — morning food, not a late brunch unless they ticked brunch.
- If the brief includes a special occasion / one-off: cook a celebratory standout dish (guests, a treat, a night that matters). Use dinner in JSON unless they also named another slot. Do not make it a plain weeknight plate.
- Avoid / dislikes: never include those ingredients (e.g. no garlic means zero garlic in ingredients or method).
- Extra notes: treat as required preferences (e.g. "lots of onions" means the dish should feature onions generously).
- Pantry items: prefer using them; do not ignore them when the user is cooking from the cupboard.
- Budget, cook-time, servings, days, cuisines, methods: respect them.
- Filters are collected in the app. NEVER interview, NEVER ask a questionnaire, NEVER ask follow-up questions before cooking.
- If something minor is missing, pick a sensible UK weeknight default and cook.

INTENT (from the app — honour it):
- search: they named a dish, cuisine, or mood. Cook that one recipe now. Do not invent extra constraints they did not state.
- create: they filled a complete brief. Cook exactly one recipe that obeys it. Do not ask questions.
- tweak: they already have a recipe. Change it as asked and return one new JSON plan. Do not re-ask the brief.
- suggest: do NOT write a recipe, method, or ingredients. Return exactly three distinct dish options as concise title-and-description choices using the schema below.
- finalize: they selected one suggested dish and supplied any final tweak. Now return exactly one complete recipe plan for that selected dish.

WHEN YOU SUGGEST OPTIONS:
- Give exactly three genuinely different options that all obey the meal brief.
- Keep each description to one sentence. Explain the style and appeal, not the full method.
- Return a short friendly lead-in followed by this fenced JSON:
\`\`\`json
{
  "options": [
    { "title": "string", "description": "one concise sentence", "reason": "short fit with their brief" }
  ]
}
\`\`\`
- Never include ingredients, instructions, nutrition, or a meal plan while suggesting.

CONVERSATION STYLE:
- Keep chat light: in 1–2 sentences, confirm what you cooked, then deliver the plan.
- Classics: if they ask for a known dish (e.g. carbonara), cook that dish (adapted only for avoid list / diet / servings).
- Remix requests: rewrite the dish and deliver a full new JSON plan.
- Pantry-first: if they list ingredients they have, prioritise those and minimise new buys.
- Do not mention internal intents, JSON, or the brief format to the user.

WHEN YOU DELIVER A PLAN:
- Short friendly summary (2–4 sentences), then a fenced JSON block the app can save:
\`\`\`json
{ ... }
\`\`\`
- You MUST include the real JSON object (not just a summary).
- JSON schema (required):
  {
    "plan_name": "string",
    "servings": number,
    "recipes": [
      {
        "day_of_week": "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday",
        "meal_slot": "breakfast" | "lunch" | "dinner" | "snack",
        "title": "string",
        "instructions": "string",
        "prep_time": number,
        "cook_time": number,
        "estimated_cost": number,
        "calories": number,
        "protein": number,
        "carbs": number,
        "fat": number,
        "image_query": "string",
        "ingredients": [
          {
            "ingredient_name": "string",
            "quantity": number,
            "unit": "string",
            "category": "string",
            "estimated_price": number
          }
        ]
      }
    ]
  }
- image_query: 2–5 word common dish name used only to find a photo (e.g. "spaghetti carbonara", "chicken tikka masala", "chilli con carne"). Not a poetic title.
- NEVER invent image, photo, or Unsplash/Pexels URLs. The app looks up photos itself. Any image URL you include will be ignored.
- Respect the brief strictly: cuisines, cooking methods, proteins, pantry, avoid list, max cook time, budget, meal slots, notes.
- Map "brunch" meal slot from the brief to "breakfast" in JSON if needed, but only include meals the brief asked for.
- Variety: do NOT serve two similar dishes the same day (e.g. chicken stir-fry + beef stir-fry). Vary method/cuisine across meals.
- If brunch + dinner: brunch should be lighter and stylistically different from dinner.
- Costs in realistic UK GBP. Consistent ingredient naming/units across the plan.
- Pure chit-chat with no food ask: brief and friendly, no JSON.`;

function formatMealBrief(brief: Record<string, unknown> | null | undefined): string {
  if (!brief || typeof brief !== 'object') return '';
  const lines: string[] = [];
  const num = (v: unknown) => (typeof v === 'number' && !Number.isNaN(v) ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

  const servings = num(brief.servings);
  const days = num(brief.days);
  const budget = num(brief.budget_per_day);
  const cook = num(brief.max_cook_minutes);
  const slots = list(brief.meal_slots);
  const cuisines = list(brief.cuisines);
  const methods = list(brief.cooking_methods);
  const proteins = list(brief.proteins);
  const pantry = list(brief.pantry);
  const avoid = str(brief.avoid);
  const notes = str(brief.notes);

  if (servings != null) lines.push(`- People / servings: ${servings}`);
  if (days != null) lines.push(`- Days to cover: ${days}`);
  if (slots.length) lines.push(`- Meals needed: ${slots.join(', ')}`);
  if (budget != null) lines.push(`- Budget per day (GBP): £${budget}`);
  if (cook != null) lines.push(`- Max cook time per meal: ${cook} minutes`);
  if (cuisines.length) lines.push(`- Preferred cuisines: ${cuisines.join(', ')}`);
  if (methods.length) lines.push(`- Preferred cooking methods: ${methods.join(', ')}`);
  if (proteins.length) lines.push(`- Proteins to use (REQUIRED — do not substitute): ${proteins.join(', ')}`);
  if (pantry.length) lines.push(`- Pantry / already have (prefer using): ${pantry.join(', ')}`);
  if (avoid) lines.push(`- Avoid / dislikes (FORBIDDEN ingredients — never include): ${avoid}`);
  if (notes) lines.push(`- Extra notes (REQUIRED preferences): ${notes}`);

  if (!lines.length) return '';
  return `STRUCTURED MEAL BRIEF — OBEY EVERY LINE:\n${lines.join('\n')}`;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null };
  }>;
}

async function callMealPlanningAPI(
  messages: ChatMessage[],
  systemPrompt: string = MEAL_PLANNING_SYSTEM_PROMPT
): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: config.OPENAI_MODEL,
      max_tokens: config.OPENAI_MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
      ],
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as OpenAIChatResponse;
  return data.choices?.[0]?.message?.content ?? '';
}

interface ParsedMealPlan {
  plan_name?: string;
  servings?: number;
  recipes?: Array<{
    day_of_week?: string;
    meal_slot?: string;
    title?: string;
    instructions?: string;
    prep_time?: number;
    cook_time?: number;
    estimated_cost?: number;
    calories?: number;
    protein?: number;
    carbs?: number;
    fat?: number;
    image_query?: string;
    image?: string;
    ingredients?: Array<{
      ingredient_name?: string;
      quantity?: number;
      unit?: string;
      category?: string;
      estimated_price?: number;
    }>;
  }>;
}

interface DishOption {
  title: string;
  description: string;
  reason?: string;
}

function parseDishOptions(text: string): DishOption[] | null {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as { options?: unknown };
          if (Array.isArray(parsed.options)) {
            const options = parsed.options
              .filter((option): option is Record<string, unknown> => Boolean(option) && typeof option === 'object')
              .map((option) => ({
                title: typeof option.title === 'string' ? option.title.trim() : '',
                description: typeof option.description === 'string' ? option.description.trim() : '',
                reason: typeof option.reason === 'string' ? option.reason.trim() : undefined,
              }))
              .filter((option) => option.title && option.description)
              .slice(0, 3);
            return options.length ? options : null;
          }
        } catch {
          // not valid suggestion JSON, keep scanning
        }
        start = -1;
      }
    }
  }
  return null;
}

function parseRecipeJSON(text: string): ParsedMealPlan | null {
  // Scan for every top-level {...} block and return the first one that contains
  // a "recipes" array, rather than greedily matching from first { to last }.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.recipes)) {
            return parsed as unknown as ParsedMealPlan;
          }
        } catch {
          // not valid JSON, keep scanning
        }
        start = -1;
      }
    }
  }
  return null;
}

function messageWithoutOptionsBlock(text: string): string {
  let out = text.replace(/```json\s*[\s\S]*?```/g, '');
  let depth = 0;
  let start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (out[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(out.slice(start, i + 1)) as { options?: unknown };
          if (Array.isArray(parsed.options)) {
            out = out.slice(0, start) + out.slice(i + 1);
            break;
          }
        } catch {
          // not valid JSON, keep scanning
        }
        start = -1;
      }
    }
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

/** Remove the meal-plan JSON block from assistant text so the chat shows only conversational content. */
function messageWithoutJsonBlock(text: string): string {
  // Remove entire ```json ... ``` code block first (non-greedy to closing ```)
  let out = text.replace(/```json\s*[\s\S]*?```/g, '');

  // Remove the first top-level {...} block that contains a "recipes" array,
  // matching the same candidate chosen by parseRecipeJSON.
  let depth = 0;
  let start = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (out[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const candidate = out.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.recipes)) {
            out = out.slice(0, start) + out.slice(i + 1);
            break;
          }
        } catch {
          // not valid JSON, keep scanning
        }
        start = -1;
      }
    }
  }

  return out.replace(/\n{3,}/g, '\n\n').trim() || text;
}

interface UserPrefs {
  dietary_preferences: string | null;
  allergies: string | null;
  household_size: number | null;
  default_budget: number | null;
  preferred_retailer: string | null;
}

function buildSystemPrompt(
  prefs: UserPrefs | null,
  mealBrief?: Record<string, unknown> | null,
  intent?: string | null,
): string {
  let prompt = MEAL_PLANNING_SYSTEM_PROMPT;

  const cleanIntent = typeof intent === 'string' ? intent.trim().toLowerCase() : '';
  if (['search', 'create', 'tweak', 'suggest', 'finalize'].includes(cleanIntent)) {
    prompt += cleanIntent === 'suggest'
      ? '\n\nACTIVE INTENT: suggest. Present exactly three concise options using the options JSON schema. Do not cook yet.'
      : `\n\nACTIVE INTENT: ${cleanIntent}. Honour the INTENT rules above. Cook now — do not ask questions.`;
  }

  const briefBlock = formatMealBrief(mealBrief);
  if (briefBlock) {
    prompt += `\n\n${briefBlock}`;
  }

  if (!prefs) return prompt;

  const lines: string[] = [];
  if (prefs.dietary_preferences?.trim()) {
    lines.push(`- Dietary preferences: ${prefs.dietary_preferences.trim()}`);
  }
  if (prefs.allergies?.trim()) {
    lines.push(`- Allergies (must avoid): ${prefs.allergies.trim()}`);
  }
  if (prefs.household_size != null && prefs.household_size > 0) {
    lines.push(`- Household size / servings: ${prefs.household_size}`);
  }
  if (prefs.default_budget != null && !Number.isNaN(Number(prefs.default_budget))) {
    lines.push(`- Default weekly budget (GBP): £${Number(prefs.default_budget).toFixed(2)}`);
  }
  if (prefs.preferred_retailer?.trim()) {
    lines.push(`- Preferred supermarket: ${prefs.preferred_retailer.trim()}`);
  }

  if (lines.length === 0) return prompt;

  return `${prompt}

Known account preferences (already saved — do not re-ask unless they want to change them):
${lines.join('\n')}`;
}

type ShoppingItemRow = {
  id: number;
  ingredient_name: string;
  quantity: string | number | null;
  unit: string | null;
  category: string | null;
  estimated_price: string | number | null;
  checked: boolean;
};

function mapShoppingItems(rows: ShoppingItemRow[]) {
  return rows.map((r) => ({
    id: r.id,
    ingredient_name: r.ingredient_name,
    quantity: r.quantity != null ? parseFloat(String(r.quantity)) : null,
    unit: r.unit,
    category: r.category,
    estimated_price: r.estimated_price != null ? parseFloat(String(r.estimated_price)) : null,
    checked: Boolean(r.checked),
  }));
}

async function generateShoppingListForPlan(
  client: PoolClient,
  planId: number
): Promise<{ shoppingListId: number; totalCost: number }> {
  const upsertResult = await client.query<{ id: number }>(
    `INSERT INTO shopping_lists (meal_plan_id, total_cost)
     VALUES ($1, 0)
     ON CONFLICT (meal_plan_id) DO UPDATE SET meal_plan_id = EXCLUDED.meal_plan_id
     RETURNING id`,
    [planId]
  );
  const shoppingListId = upsertResult.rows[0].id;

  // Preserve checked state across regenerate by ingredient+unit key
  const prevChecked = await client.query<{
    ingredient_name: string;
    unit: string | null;
    checked: boolean;
  }>(
    `SELECT ingredient_name, unit, checked FROM shopping_list_items WHERE shopping_list_id = $1`,
    [shoppingListId]
  );
  const checkedMap = new Map<string, boolean>();
  for (const row of prevChecked.rows) {
    const key = `${(row.ingredient_name || '').toLowerCase().trim()}|${(row.unit || '').toLowerCase().trim()}`;
    if (row.checked) checkedMap.set(key, true);
  }

  await client.query('DELETE FROM shopping_list_items WHERE shopping_list_id = $1', [shoppingListId]);

  const aggResult = await client.query(
    `SELECT
       MIN(i.ingredient_name) AS ingredient_name,
       COALESCE(MIN(i.unit), '') AS unit,
       i.category,
       SUM(i.quantity) AS quantity,
       SUM(i.estimated_price) AS estimated_price
     FROM ingredients i
     JOIN recipes r ON r.id = i.recipe_id
     WHERE r.meal_plan_id = $1
     GROUP BY LOWER(TRIM(i.ingredient_name)), COALESCE(LOWER(TRIM(i.unit)), ''), i.category`,
    [planId]
  );

  let totalCost = 0;
  for (const row of aggResult.rows) {
    const qty = row.quantity != null ? parseFloat(row.quantity) : null;
    const price = row.estimated_price != null ? parseFloat(row.estimated_price) : null;
    if (price != null) totalCost += price;
    const unit = row.unit === '' ? null : row.unit;
    const key = `${(row.ingredient_name || '').toLowerCase().trim()}|${(unit || '').toLowerCase().trim()}`;
    const checked = checkedMap.get(key) === true;

    await client.query(
      `INSERT INTO shopping_list_items (shopping_list_id, ingredient_name, quantity, unit, category, estimated_price, checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shoppingListId, row.ingredient_name, qty, unit, row.category, price, checked]
    );
  }

  await client.query('UPDATE shopping_lists SET total_cost = $1 WHERE id = $2', [totalCost, shoppingListId]);
  return { shoppingListId, totalCost };
}

function makeShareSlug(): string {
  return crypto.randomBytes(9).toString('base64url').slice(0, 12);
}

async function loadRecipesForPlan(client: PoolClient, planId: number) {
  const recipesResult = await client.query(
    `SELECT id, day_of_week, meal_slot, title, instructions, prep_time, cook_time,
            estimated_cost, calories, protein, carbs, fat, image_url
     FROM recipes WHERE meal_plan_id = $1
     ORDER BY id ASC`,
    [planId]
  );

  const recipes = [];
  for (const recipe of recipesResult.rows) {
    const ingredientsResult = await client.query(
      `SELECT ingredient_name, quantity, unit, category, estimated_price
       FROM ingredients WHERE recipe_id = $1 ORDER BY id ASC`,
      [recipe.id]
    );
    recipes.push({
      id: recipe.id,
      day_of_week: recipe.day_of_week,
      meal_slot: recipe.meal_slot,
      title: recipe.title,
      instructions: recipe.instructions,
      prep_time: recipe.prep_time,
      cook_time: recipe.cook_time,
      estimated_cost: recipe.estimated_cost != null ? parseFloat(recipe.estimated_cost) : null,
      calories: recipe.calories,
      protein: recipe.protein != null ? parseFloat(recipe.protein) : null,
      carbs: recipe.carbs != null ? parseFloat(recipe.carbs) : null,
      fat: recipe.fat != null ? parseFloat(recipe.fat) : null,
      image: isAllowedImageUrl(recipe.image_url) ? recipe.image_url : null,
      ingredients: ingredientsResult.rows.map((ing) => ({
        ingredient_name: ing.ingredient_name,
        quantity: ing.quantity != null ? parseFloat(ing.quantity) : null,
        unit: ing.unit,
        category: ing.category,
        estimated_price: ing.estimated_price != null ? parseFloat(ing.estimated_price) : null,
      })),
    });
  }
  return recipes;
}

async function ensureLikedPlaylist(client: PoolClient, userId: number): Promise<number> {
  const existing = await client.query<{ id: number }>(
    `SELECT id FROM playlists WHERE user_id = $1 AND kind = 'liked' LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) return existing.rows[0].id;
  const created = await client.query<{ id: number }>(
    `INSERT INTO playlists (user_id, title, blurb, kind)
     VALUES ($1, 'Liked', 'Dishes you kept.', 'liked')
     RETURNING id`,
    [userId]
  );
  return created.rows[0].id;
}

async function serializePlaylist(
  client: PoolClient,
  playlistId: number,
  userId?: number | null,
  opts?: { includeTracks?: boolean }
) {
  const ownerFilter = userId != null ? 'AND p.user_id = $2' : '';
  const params = userId != null ? [playlistId, userId] : [playlistId];
  const result = await client.query(
    `SELECT
       p.id, p.title, p.blurb, p.kind, p.is_public, p.share_slug, p.created_at,
       (SELECT COUNT(*)::int FROM playlist_items i WHERE i.playlist_id = p.id) AS tracks_count,
       (
         SELECT r.image_url
         FROM playlist_items i
         JOIN recipes r ON r.meal_plan_id = i.meal_plan_id
         WHERE i.playlist_id = p.id
         ORDER BY i.sort_order ASC, r.id ASC
         LIMIT 1
       ) AS cover_url
     FROM playlists p
     WHERE p.id = $1 ${ownerFilter}`,
    params
  );
  if (!result.rows[0]) return null;
  const row = result.rows[0];
  const playlist = {
    id: row.id,
    title: row.title,
    blurb: row.blurb,
    kind: row.kind,
    is_public: Boolean(row.is_public),
    share_slug: row.share_slug ?? null,
    created_at: row.created_at,
    tracks_count: row.tracks_count,
    cover_url: isAllowedImageUrl(row.cover_url) ? row.cover_url : null,
    tracks: [] as Array<Record<string, unknown>>,
  };
  if (opts?.includeTracks) {
    const tracks = await client.query(
      `SELECT
         i.meal_plan_id, i.sort_order, mp.plan_name, mp.servings, mp.total_estimated_cost,
         (
           SELECT r.image_url FROM recipes r
           WHERE r.meal_plan_id = mp.id
           ORDER BY r.id ASC LIMIT 1
         ) AS image_url
       FROM playlist_items i
       JOIN meal_plans mp ON mp.id = i.meal_plan_id
       WHERE i.playlist_id = $1
       ORDER BY i.sort_order ASC, i.added_at ASC`,
      [playlistId]
    );
    playlist.tracks = tracks.rows.map((t) => ({
      meal_plan_id: t.meal_plan_id,
      sort_order: t.sort_order,
      plan_name: t.plan_name,
      servings: t.servings,
      total_estimated_cost: t.total_estimated_cost != null ? parseFloat(t.total_estimated_cost) : null,
      image: isAllowedImageUrl(t.image_url) ? t.image_url : null,
    }));
  }
  return playlist;
}

async function generateShoppingListForPlaylist(
  client: PoolClient,
  playlistId: number
): Promise<{ shoppingListId: number; totalCost: number }> {
  const upsert = await client.query<{ id: number }>(
    `INSERT INTO playlist_shopping_lists (playlist_id, total_cost)
     VALUES ($1, 0)
     ON CONFLICT (playlist_id) DO UPDATE SET playlist_id = EXCLUDED.playlist_id
     RETURNING id`,
    [playlistId]
  );
  const shoppingListId = upsert.rows[0].id;

  const prevChecked = await client.query<{
    ingredient_name: string;
    unit: string | null;
    checked: boolean;
  }>(
    `SELECT ingredient_name, unit, checked FROM playlist_shopping_list_items WHERE shopping_list_id = $1`,
    [shoppingListId]
  );
  const checkedMap = new Map<string, boolean>();
  for (const row of prevChecked.rows) {
    const key = `${(row.ingredient_name || '').toLowerCase().trim()}|${(row.unit || '').toLowerCase().trim()}`;
    if (row.checked) checkedMap.set(key, true);
  }

  await client.query('DELETE FROM playlist_shopping_list_items WHERE shopping_list_id = $1', [shoppingListId]);

  const aggResult = await client.query(
    `SELECT
       MIN(i.ingredient_name) AS ingredient_name,
       COALESCE(MIN(i.unit), '') AS unit,
       i.category,
       SUM(i.quantity) AS quantity,
       SUM(i.estimated_price) AS estimated_price
     FROM ingredients i
     JOIN recipes r ON r.id = i.recipe_id
     JOIN playlist_items pi ON pi.meal_plan_id = r.meal_plan_id
     WHERE pi.playlist_id = $1
     GROUP BY LOWER(TRIM(i.ingredient_name)), COALESCE(LOWER(TRIM(i.unit)), ''), i.category`,
    [playlistId]
  );

  let totalCost = 0;
  for (const row of aggResult.rows) {
    const qty = row.quantity != null ? parseFloat(row.quantity) : null;
    const price = row.estimated_price != null ? parseFloat(row.estimated_price) : null;
    if (price != null) totalCost += price;
    const unit = row.unit === '' ? null : row.unit;
    const key = `${(row.ingredient_name || '').toLowerCase().trim()}|${(unit || '').toLowerCase().trim()}`;
    const checked = checkedMap.get(key) === true;
    await client.query(
      `INSERT INTO playlist_shopping_list_items (shopping_list_id, ingredient_name, quantity, unit, category, estimated_price, checked)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [shoppingListId, row.ingredient_name, qty, unit, row.category, price, checked]
    );
  }

  await client.query('UPDATE playlist_shopping_lists SET total_cost = $1 WHERE id = $2', [totalCost, shoppingListId]);
  return { shoppingListId, totalCost };
}

async function loadPlaylistShoppingList(client: PoolClient, playlistId: number) {
  const list = await client.query<{ id: number; total_cost: string | null }>(
    'SELECT id, total_cost FROM playlist_shopping_lists WHERE playlist_id = $1',
    [playlistId]
  );
  if (!list.rows[0]) return null;
  const items = await client.query<ShoppingItemRow>(
    `SELECT id, ingredient_name, quantity, unit, category, estimated_price, checked
     FROM playlist_shopping_list_items WHERE shopping_list_id = $1
     ORDER BY category NULLS LAST, ingredient_name`,
    [list.rows[0].id]
  );
  return {
    shopping_list_id: list.rows[0].id,
    playlist_id: playlistId,
    items: mapShoppingItems(items.rows),
    total_cost: list.rows[0].total_cost != null ? parseFloat(list.rows[0].total_cost) : 0,
  };
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet({
  // Allow the Railway frontend (and local Vite) to read API responses in Safari.
  // Helmet's default same-origin CORP blocks cross-origin fetch even when CORS allows it.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
const corsOrigins = config.CORS_ORIGINS === '' || config.CORS_ORIGINS === '*' ? undefined : config.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors(corsOrigins ? { origin: corsOrigins } : {}));
app.use(express.json({ limit: config.JSON_BODY_LIMIT }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use((req: Request, _res: Response, next: NextFunction) => {
  log('INFO', `${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ---------------------------------------------------------------------------
// Authentication Routes (rate-limited)
// ---------------------------------------------------------------------------

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

app.post('/register', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || !email.trim() || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    const client = await pool.connect();
    try {
      const hashedPassword = await bcrypt.hash(password, 10);
      const result = await client.query(
        'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
        [email.trim(), hashedPassword]
      );
      const user = result.rows[0];
      const token = jwt.sign({ userId: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: '7d' });
      res.status(201).json({
        message: 'User registered successfully',
        token,
        userId: user.id,
        email: user.email,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        return res.status(409).json({ error: 'Email already registered' });
      }
      log('ERROR', 'POST /register failed', { err: String(err) });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /register failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/login', authLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || !email.trim() || !EMAIL_REGEX.test(email.trim()) || typeof password !== 'string' || !password.trim()) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        'SELECT id, email, password_hash FROM users WHERE email = $1',
        [email.trim()]
      );
      const user = result.rows[0];

      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const token = jwt.sign({ userId: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: '7d' });
      res.json({
        message: 'Logged in successfully',
        token,
        userId: user.id,
        email: user.email,
      });
    } catch (err) {
      log('ERROR', 'POST /login failed', { err: String(err) });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /login failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// User preferences
// ---------------------------------------------------------------------------

app.get('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const result = await pool.query(
      `SELECT email, dietary_preferences, allergies, household_size, default_budget, preferred_retailer, message_count
       FROM users WHERE id = $1`,
      [user_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = result.rows[0];
    res.json({
      email: u.email,
      dietary_preferences: u.dietary_preferences ?? '',
      allergies: u.allergies ?? '',
      household_size: u.household_size ?? 1,
      default_budget: u.default_budget != null ? parseFloat(u.default_budget) : null,
      preferred_retailer: u.preferred_retailer ?? 'tesco',
      message_count: u.message_count ?? 0,
      message_quota: config.MESSAGE_QUOTA_PER_USER,
    });
  } catch (err) {
    log('ERROR', 'GET /me failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/me', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const {
      dietary_preferences,
      allergies,
      household_size,
      default_budget,
      preferred_retailer,
    } = req.body ?? {};

    if (household_size !== undefined) {
      if (typeof household_size !== 'number' || !Number.isInteger(household_size) || household_size < 1 || household_size > 20) {
        return res.status(400).json({ error: 'household_size must be an integer between 1 and 20' });
      }
    }
    if (default_budget !== undefined && default_budget !== null) {
      if (typeof default_budget !== 'number' || Number.isNaN(default_budget) || default_budget < 0) {
        return res.status(400).json({ error: 'default_budget must be a non-negative number or null' });
      }
    }
    if (preferred_retailer !== undefined) {
      if (typeof preferred_retailer !== 'string' || !RETAILERS.includes(preferred_retailer.toLowerCase() as Retailer)) {
        return res.status(400).json({ error: 'preferred_retailer must be "tesco" or "sainsburys"' });
      }
    }
    if (dietary_preferences !== undefined && typeof dietary_preferences !== 'string') {
      return res.status(400).json({ error: 'dietary_preferences must be a string' });
    }
    if (allergies !== undefined && typeof allergies !== 'string') {
      return res.status(400).json({ error: 'allergies must be a string' });
    }

    const result = await pool.query(
      `UPDATE users SET
         dietary_preferences = COALESCE($2, dietary_preferences),
         allergies = COALESCE($3, allergies),
         household_size = COALESCE($4, household_size),
         default_budget = CASE WHEN $5::boolean THEN $6 ELSE default_budget END,
         preferred_retailer = COALESCE($7, preferred_retailer)
       WHERE id = $1
       RETURNING email, dietary_preferences, allergies, household_size, default_budget, preferred_retailer, message_count`,
      [
        user_id,
        dietary_preferences !== undefined ? String(dietary_preferences).slice(0, 2000) : null,
        allergies !== undefined ? String(allergies).slice(0, 2000) : null,
        household_size !== undefined ? household_size : null,
        default_budget !== undefined,
        default_budget === null ? null : default_budget,
        preferred_retailer !== undefined ? preferred_retailer.toLowerCase() : null,
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = result.rows[0];
    res.json({
      email: u.email,
      dietary_preferences: u.dietary_preferences ?? '',
      allergies: u.allergies ?? '',
      household_size: u.household_size ?? 1,
      default_budget: u.default_budget != null ? parseFloat(u.default_budget) : null,
      preferred_retailer: u.preferred_retailer ?? 'tesco',
      message_count: u.message_count ?? 0,
      message_quota: config.MESSAGE_QUOTA_PER_USER,
    });
  } catch (err) {
    log('ERROR', 'PATCH /me failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/me/password', authLimiter, authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const { current_password, new_password } = req.body ?? {};
    if (typeof current_password !== 'string' || !current_password) {
      return res.status(400).json({ error: 'Current password is required.' });
    }
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters long.' });
    }
    if (current_password === new_password) {
      return res.status(400).json({ error: 'New password must be different from the current password.' });
    }

    const client = await pool.connect();
    try {
      const result = await client.query<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = $1',
        [user_id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const matches = await bcrypt.compare(current_password, result.rows[0].password_hash);
      if (!matches) {
        return res.status(401).json({ error: 'Current password is incorrect.' });
      }

      const hashed = await bcrypt.hash(new_password, 10);
      await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [user_id, hashed]);
      res.json({ message: 'Password updated successfully.' });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /me/password failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Protected Routes
// ---------------------------------------------------------------------------

app.post('/chat', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { user_message, conversation_id, meal_brief, intent } = req.body;
    const user_id = (req as AuthenticatedRequest).user?.userId;

    if (
      typeof user_message !== 'string' ||
      !user_message.trim() ||
      typeof conversation_id !== 'string' ||
      !conversation_id.trim() ||
      user_id == null
    ) {
      return res.status(400).json({
        error: 'Invalid request. Required: user_message (string), conversation_id (string). Auth token required.',
      });
    }
    const convId = conversation_id.trim();
    if (convId.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(convId)) {
      return res.status(400).json({
        error: 'conversation_id must be 1–100 characters, alphanumeric, hyphen, or underscore only.',
      });
    }

    const brief =
      meal_brief && typeof meal_brief === 'object' && !Array.isArray(meal_brief)
        ? (meal_brief as Record<string, unknown>)
        : null;

    const client = await pool.connect();

    try {
      const updateResult = await client.query<{ message_count: number }>(
        `UPDATE users SET message_count = message_count + 1
         WHERE id = $1 AND message_count < $2
         RETURNING message_count`,
        [user_id, config.MESSAGE_QUOTA_PER_USER]
      );
      if (updateResult.rows.length === 0) {
        return res.status(429).json({
          error: `You have reached your ${config.MESSAGE_QUOTA_PER_USER} messages limit`,
        });
      }

      await client.query('INSERT INTO chat_messages (user_id, sender, message_text, conversation_id) VALUES ($1, $2, $3, $4)', [
        user_id,
        'user',
        user_message.trim(),
        convId,
      ]);

      const prefsResult = await client.query<UserPrefs>(
        `SELECT dietary_preferences, allergies, household_size, default_budget, preferred_retailer
         FROM users WHERE id = $1`,
        [user_id]
      );
      const prefs = prefsResult.rows[0] ?? null;

      const historyResult = await client.query(
        `SELECT sender, message_text FROM chat_messages 
         WHERE conversation_id = $1 AND user_id = $2 
         ORDER BY timestamp ASC`,
        [convId, user_id]
      );

      const messages: ChatMessage[] = historyResult.rows.map((row: { sender: string; message_text: string }) => ({
        role: row.sender === 'user' ? 'user' : 'assistant',
        content: row.message_text,
      }));

      // Attach the live brief to the latest user turn so mode buttons ("tonight", etc.)
      // cannot override Step 1 constraints.
      const briefReminder = formatMealBrief(brief);
      if (briefReminder && messages.length > 0) {
        const lastIdx = messages.length - 1;
        if (messages[lastIdx].role === 'user') {
          messages[lastIdx] = {
            role: 'user',
            content: `${messages[lastIdx].content}\n\n${briefReminder}\n\nFollow the brief above exactly for proteins, meal slots, avoid list, and notes.`,
          };
        }
      }

      const assistantText = await callMealPlanningAPI(messages, buildSystemPrompt(prefs, brief, intent));

      await client.query(
        'INSERT INTO chat_messages (user_id, sender, message_text, conversation_id) VALUES ($1, $2, $3, $4)',
        [user_id, 'assistant', assistantText, convId]
      );

      const mealPlan = parseRecipeJSON(assistantText);
      const dishOptions = String(intent || '').toLowerCase() === 'suggest'
        ? parseDishOptions(assistantText)
        : null;
      const displayMessage = mealPlan
        ? messageWithoutJsonBlock(assistantText)
        : dishOptions
          ? messageWithoutOptionsBlock(assistantText)
          : assistantText;
      let planForClient = mealPlan;
      if (mealPlan) {
        try {
          planForClient = await attachRecipeImages(mealPlan, config.UNSPLASH_ACCESS_KEY);
        } catch (imgErr) {
          log('WARN', 'Recipe image lookup failed', { err: String(imgErr) });
          planForClient = {
            ...mealPlan,
            recipes: (mealPlan.recipes || []).map((recipe) => {
              const rest = { ...recipe };
              delete rest.image;
              delete rest.image_query;
              return rest;
            }),
          };
          delete (planForClient as { image?: string }).image;
        }
      }

      res.json({
        message: displayMessage,
        ...(dishOptions && { options: dishOptions }),
        ...(planForClient && { meal_plan: planForClient }),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log('ERROR', 'POST /chat failed', { err: errMsg });
    res.status(500).json({
      error: 'Internal server error',
      detail: process.env.NODE_ENV !== 'production' ? errMsg : undefined,
    });
  }
});

app.post('/meal-plan', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { plan_name, servings, recipes } = req.body;
    const user_id = (req as AuthenticatedRequest).user?.userId;

    if (
      user_id == null ||
      typeof plan_name !== 'string' ||
      !plan_name.trim() ||
      typeof servings !== 'number' ||
      !Number.isInteger(servings) ||
      servings < 1 ||
      !Array.isArray(recipes) ||
      recipes.length === 0
    ) {
      return res.status(400).json({
        error: 'Invalid request. Required: plan_name (string), servings (positive integer), recipes (non-empty array). Auth token required.',
      });
    }

    const VALID_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
    const VALID_MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let totalEstimatedCost = 0;

      const mealPlanResult = await client.query<{ id: number }>(
        `INSERT INTO meal_plans (user_id, plan_name, total_estimated_cost, servings, status)
         VALUES ($1, $2, 0, $3, 'draft') RETURNING id`,
        [user_id, plan_name.trim(), servings]
      );
      const mealPlanId = mealPlanResult.rows[0].id;

      for (const r of recipes) {
        const rawDay = (r.day_of_week || '').toString();
        const dayOfWeek = (VALID_DAYS as readonly string[]).includes(rawDay) ? rawDay : 'Monday';
        const rawSlot = (r.meal_slot || '').toString();
        const mealSlot = (VALID_MEAL_SLOTS as readonly string[]).includes(rawSlot) ? rawSlot : 'dinner';
        const title = (r.title || 'Untitled').toString().slice(0, 255);
        const instructions = (r.instructions || '').toString();
        const prepTime = typeof r.prep_time === 'number' ? r.prep_time : null;
        const cookTime = typeof r.cook_time === 'number' ? r.cook_time : null;
        const estimatedCost = typeof r.estimated_cost === 'number' ? r.estimated_cost : 0;
        const calories = typeof r.calories === 'number' ? r.calories : null;
        const protein = typeof r.protein === 'number' ? r.protein : null;
        const carbs = typeof r.carbs === 'number' ? r.carbs : null;
        const fat = typeof r.fat === 'number' ? r.fat : null;
        const imageUrl = isAllowedImageUrl(r.image) ? r.image : null;

        totalEstimatedCost += estimatedCost;

        const recipeResult = await client.query<{ id: number }>(
          `INSERT INTO recipes (meal_plan_id, day_of_week, meal_slot, title, instructions, prep_time, cook_time, estimated_cost, calories, protein, carbs, fat, image_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
          [mealPlanId, dayOfWeek, mealSlot, title, instructions, prepTime, cookTime, estimatedCost, calories, protein, carbs, fat, imageUrl]
        );
        const recipeId = recipeResult.rows[0].id;

        const ingredients = Array.isArray(r.ingredients) ? r.ingredients : [];
        for (const ing of ingredients) {
          const ingredientName = (ing.ingredient_name || 'Unknown').toString().slice(0, 255);
          const quantity = typeof ing.quantity === 'number' ? ing.quantity : null;
          const unit = ing.unit != null ? String(ing.unit).slice(0, 50) : null;
          const category = ing.category != null ? String(ing.category).slice(0, 100) : null;
          const estimatedPrice = typeof ing.estimated_price === 'number' ? ing.estimated_price : null;

          await client.query(
            `INSERT INTO ingredients (recipe_id, ingredient_name, quantity, unit, category, estimated_price)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [recipeId, ingredientName, quantity, unit, category, estimatedPrice]
          );
        }
      }

      await client.query(
        'UPDATE meal_plans SET total_estimated_cost = $1 WHERE id = $2',
        [totalEstimatedCost, mealPlanId]
      );

      await generateShoppingListForPlan(client, mealPlanId);
      const likedId = await ensureLikedPlaylist(client, Number(user_id));
      const maxOrder = await client.query<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order), -1)::int AS n FROM playlist_items WHERE playlist_id = $1',
        [likedId]
      );
      await client.query(
        `INSERT INTO playlist_items (playlist_id, meal_plan_id, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (playlist_id, meal_plan_id) DO NOTHING`,
        [likedId, mealPlanId, (maxOrder.rows[0]?.n ?? -1) + 1]
      );
      await generateShoppingListForPlaylist(client, likedId);
      await client.query('COMMIT');

      res.status(201).json({
        meal_plan_id: mealPlanId,
        id: mealPlanId,
        plan_name: plan_name.trim(),
        total_estimated_cost: totalEstimatedCost,
        servings,
        recipes_count: recipes.length,
      });
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /meal-plan failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/meal-plans', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const result = await pool.query(
      `SELECT
         mp.id,
         mp.plan_name,
         mp.total_estimated_cost,
         mp.servings,
         mp.status,
         mp.is_public,
         mp.share_slug,
         mp.created_at,
         (SELECT COUNT(*)::int FROM recipes r WHERE r.meal_plan_id = mp.id) AS recipes_count
       FROM meal_plans mp
       WHERE mp.user_id = $1
       ORDER BY mp.created_at DESC
       LIMIT 50`,
      [user_id]
    );

    res.json({
      plans: result.rows.map((r) => ({
        id: r.id,
        plan_name: r.plan_name,
        total_estimated_cost: r.total_estimated_cost != null ? parseFloat(r.total_estimated_cost) : null,
        servings: r.servings,
        status: r.status,
        is_public: Boolean(r.is_public),
        share_slug: r.share_slug ?? null,
        created_at: r.created_at,
        recipes_count: r.recipes_count,
      })),
    });
  } catch (err) {
    log('ERROR', 'GET /meal-plans failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/meal-plan/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan id.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const client = await pool.connect();
    try {
      const planResult = await client.query(
        `SELECT id, plan_name, total_estimated_cost, servings, status, is_public, share_slug, created_at
         FROM meal_plans WHERE id = $1 AND user_id = $2`,
        [planId, user_id]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Meal plan not found' });
      }
      const plan = planResult.rows[0];
      const recipes = await loadRecipesForPlan(client, planId);

      res.json({
        id: plan.id,
        plan_name: plan.plan_name,
        total_estimated_cost: plan.total_estimated_cost != null ? parseFloat(plan.total_estimated_cost) : null,
        servings: plan.servings,
        status: plan.status,
        is_public: Boolean(plan.is_public),
        share_slug: plan.share_slug ?? null,
        created_at: plan.created_at,
        recipes,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /meal-plan/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/meal-plan/:id/share', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan id.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const existing = await pool.query(
      `SELECT id, plan_name, is_public, share_slug FROM meal_plans WHERE id = $1 AND user_id = $2`,
      [planId, user_id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Meal plan not found' });
    }

    let shareSlug = existing.rows[0].share_slug as string | null;
    if (!shareSlug) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = makeShareSlug();
        try {
          const updated = await pool.query(
            `UPDATE meal_plans
             SET is_public = TRUE, share_slug = $1, shared_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND user_id = $3
             RETURNING share_slug, plan_name, is_public`,
            [candidate, planId, user_id]
          );
          shareSlug = updated.rows[0].share_slug;
          break;
        } catch (err: unknown) {
          const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : null;
          if (code !== '23505') throw err;
        }
      }
      if (!shareSlug) {
        return res.status(500).json({ error: 'Could not create share link.' });
      }
    } else if (!existing.rows[0].is_public) {
      await pool.query(
        `UPDATE meal_plans
         SET is_public = TRUE, shared_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND user_id = $2`,
        [planId, user_id]
      );
    }

    res.json({
      id: planId,
      plan_name: existing.rows[0].plan_name,
      is_public: true,
      share_slug: shareSlug,
    });
  } catch (err) {
    log('ERROR', 'POST /meal-plan/:id/share failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/meal-plan/:id/unshare', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan id.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const result = await pool.query(
      `UPDATE meal_plans
       SET is_public = FALSE
       WHERE id = $1 AND user_id = $2
       RETURNING id, plan_name, is_public, share_slug`,
      [planId, user_id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Meal plan not found' });
    }

    res.json({
      id: result.rows[0].id,
      plan_name: result.rows[0].plan_name,
      is_public: false,
      share_slug: result.rows[0].share_slug,
    });
  } catch (err) {
    log('ERROR', 'POST /meal-plan/:id/unshare failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/share/list/:slug', async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug || slug.length > 32) {
      return res.status(400).json({ error: 'Invalid share link.' });
    }
    const client = await pool.connect();
    try {
      const found = await client.query<{ id: number }>(
        `SELECT id FROM playlists WHERE share_slug = $1 AND is_public = TRUE`,
        [slug]
      );
      if (!found.rows[0]) {
        return res.status(404).json({ error: 'This list is private or the link is invalid.' });
      }
      const playlist = await serializePlaylist(client, found.rows[0].id, null, { includeTracks: true });
      if (!playlist) {
        return res.status(404).json({ error: 'This list is private or the link is invalid.' });
      }
      const dishes = [];
      for (const track of playlist.tracks) {
        const planId = Number(track.meal_plan_id);
        const recipes = await loadRecipesForPlan(client, planId);
        dishes.push({
          meal_plan_id: planId,
          plan_name: track.plan_name,
          servings: track.servings,
          total_estimated_cost: track.total_estimated_cost,
          image: track.image,
          recipes,
        });
      }
      res.json({ ...playlist, dishes });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /share/list/:slug failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/share/:slug', async (req: Request, res: Response) => {
  try {
    const slug = String(req.params.slug || '').trim();
    if (!slug || slug.length > 32) {
      return res.status(400).json({ error: 'Invalid share link.' });
    }

    const client = await pool.connect();
    try {
      const planResult = await client.query(
        `SELECT mp.id, mp.plan_name, mp.total_estimated_cost, mp.servings, mp.share_slug, mp.shared_at, mp.created_at
         FROM meal_plans mp
         WHERE mp.share_slug = $1 AND mp.is_public = TRUE`,
        [slug]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'This recipe is private or the link is invalid.' });
      }
      const plan = planResult.rows[0];
      const recipes = await loadRecipesForPlan(client, plan.id);

      res.json({
        id: plan.id,
        plan_name: plan.plan_name,
        total_estimated_cost: plan.total_estimated_cost != null ? parseFloat(plan.total_estimated_cost) : null,
        servings: plan.servings,
        share_slug: plan.share_slug,
        shared_at: plan.shared_at,
        created_at: plan.created_at,
        recipes,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /share/:slug failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/playlists', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    const client = await pool.connect();
    try {
      await ensureLikedPlaylist(client, user_id);
      const rows = await client.query<{ id: number }>(
        `SELECT id FROM playlists WHERE user_id = $1 ORDER BY (kind = 'liked') DESC, created_at DESC`,
        [user_id]
      );
      const playlists = [];
      for (const row of rows.rows) {
        const serialized = await serializePlaylist(client, row.id, user_id, { includeTracks: false });
        if (serialized) playlists.push(serialized);
      }
      res.json({ playlists });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /playlists failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 255) : '';
    const blurb = typeof req.body?.blurb === 'string' ? req.body.blurb.trim().slice(0, 500) : '';
    if (!title) return res.status(400).json({ error: 'Give the list a name.' });
    const client = await pool.connect();
    try {
      const created = await client.query<{ id: number }>(
        `INSERT INTO playlists (user_id, title, blurb, kind) VALUES ($1, $2, $3, 'custom') RETURNING id`,
        [user_id, title, blurb || null]
      );
      const playlist = await serializePlaylist(client, created.rows[0].id, user_id, { includeTracks: true });
      res.status(201).json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /playlists failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/playlists/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const client = await pool.connect();
    try {
      const playlist = await serializePlaylist(client, playlistId, user_id, { includeTracks: true });
      if (!playlist) return res.status(404).json({ error: 'List not found' });
      res.json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /playlists/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/playlists/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 255) : null;
    const blurb = typeof req.body?.blurb === 'string' ? req.body.blurb.trim().slice(0, 500) : null;
    const client = await pool.connect();
    try {
      const existing = await client.query<{ kind: string }>(
        'SELECT kind FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!existing.rows[0]) return res.status(404).json({ error: 'List not found' });
      if (existing.rows[0].kind === 'liked' && title) {
        return res.status(400).json({ error: 'Liked cannot be renamed.' });
      }
      await client.query(
        `UPDATE playlists SET
           title = COALESCE($1, title),
           blurb = COALESCE($2, blurb)
         WHERE id = $3 AND user_id = $4`,
        [title || null, blurb, playlistId, user_id]
      );
      const playlist = await serializePlaylist(client, playlistId, user_id, { includeTracks: true });
      res.json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'PATCH /playlists/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/playlists/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const result = await pool.query(
      `DELETE FROM playlists WHERE id = $1 AND user_id = $2 AND kind = 'custom' RETURNING id`,
      [playlistId, user_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'List not found, or Liked cannot be deleted.' });
    res.json({ ok: true });
  } catch (err) {
    log('ERROR', 'DELETE /playlists/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists/:id/items', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    const mealPlanId = parseInt(req.body?.meal_plan_id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1 || isNaN(mealPlanId) || mealPlanId < 1) {
      return res.status(400).json({ error: 'Invalid list or dish.' });
    }
    const client = await pool.connect();
    try {
      const owned = await client.query(
        `SELECT p.id FROM playlists p WHERE p.id = $1 AND p.user_id = $2`,
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      const plan = await client.query(
        'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
        [mealPlanId, user_id]
      );
      if (!plan.rows[0]) return res.status(404).json({ error: 'Dish not found' });
      const maxOrder = await client.query<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order), -1)::int AS n FROM playlist_items WHERE playlist_id = $1',
        [playlistId]
      );
      await client.query(
        `INSERT INTO playlist_items (playlist_id, meal_plan_id, sort_order)
         VALUES ($1, $2, $3)
         ON CONFLICT (playlist_id, meal_plan_id) DO NOTHING`,
        [playlistId, mealPlanId, (maxOrder.rows[0]?.n ?? -1) + 1]
      );
      await generateShoppingListForPlaylist(client, playlistId);
      const playlist = await serializePlaylist(client, playlistId, user_id, { includeTracks: true });
      res.status(201).json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /playlists/:id/items failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/playlists/:id/items/:planId', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    const mealPlanId = parseInt(req.params.planId, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || isNaN(mealPlanId)) return res.status(400).json({ error: 'Invalid list or dish.' });
    const client = await pool.connect();
    try {
      const owned = await client.query(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      await client.query(
        'DELETE FROM playlist_items WHERE playlist_id = $1 AND meal_plan_id = $2',
        [playlistId, mealPlanId]
      );
      await generateShoppingListForPlaylist(client, playlistId);
      const playlist = await serializePlaylist(client, playlistId, user_id, { includeTracks: true });
      res.json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'DELETE /playlists/:id/items/:planId failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.put('/playlists/:id/items/order', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    const ids = Array.isArray(req.body?.meal_plan_ids) ? req.body.meal_plan_ids.map((n: unknown) => parseInt(String(n), 10)) : [];
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    if (!ids.length || ids.some((n: number) => isNaN(n) || n < 1)) {
      return res.status(400).json({ error: 'meal_plan_ids must be a non-empty array.' });
    }
    const client = await pool.connect();
    try {
      const owned = await client.query(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      for (let i = 0; i < ids.length; i++) {
        await client.query(
          'UPDATE playlist_items SET sort_order = $1 WHERE playlist_id = $2 AND meal_plan_id = $3',
          [i, playlistId, ids[i]]
        );
      }
      const playlist = await serializePlaylist(client, playlistId, user_id, { includeTracks: true });
      res.json(playlist);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'PUT /playlists/:id/items/order failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists/:id/share', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });

    const existing = await pool.query(
      `SELECT id, title, is_public, share_slug FROM playlists WHERE id = $1 AND user_id = $2`,
      [playlistId, user_id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'List not found' });

    let shareSlug = existing.rows[0].share_slug as string | null;
    if (!shareSlug) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = makeShareSlug();
        try {
          const updated = await pool.query(
            `UPDATE playlists
             SET is_public = TRUE, share_slug = $1, shared_at = CURRENT_TIMESTAMP
             WHERE id = $2 AND user_id = $3
             RETURNING share_slug`,
            [candidate, playlistId, user_id]
          );
          shareSlug = updated.rows[0].share_slug;
          break;
        } catch (err: unknown) {
          const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : null;
          if (code !== '23505') throw err;
        }
      }
      if (!shareSlug) return res.status(500).json({ error: 'Could not create share link.' });
    } else if (!existing.rows[0].is_public) {
      await pool.query(
        `UPDATE playlists SET is_public = TRUE, shared_at = CURRENT_TIMESTAMP WHERE id = $1 AND user_id = $2`,
        [playlistId, user_id]
      );
    }

    res.json({
      id: playlistId,
      title: existing.rows[0].title,
      is_public: true,
      share_slug: shareSlug,
    });
  } catch (err) {
    log('ERROR', 'POST /playlists/:id/share failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists/:id/unshare', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const result = await pool.query(
      `UPDATE playlists SET is_public = FALSE WHERE id = $1 AND user_id = $2
       RETURNING id, title, is_public, share_slug`,
      [playlistId, user_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'List not found' });
    res.json({
      id: result.rows[0].id,
      title: result.rows[0].title,
      is_public: false,
      share_slug: result.rows[0].share_slug,
    });
  } catch (err) {
    log('ERROR', 'POST /playlists/:id/unshare failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/playlists/:id/shopping-list', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const client = await pool.connect();
    try {
      const owned = await client.query(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      let list = await loadPlaylistShoppingList(client, playlistId);
      if (!list) {
        await generateShoppingListForPlaylist(client, playlistId);
        list = await loadPlaylistShoppingList(client, playlistId);
      }
      res.json(list);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /playlists/:id/shopping-list failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists/:id/shopping-list/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const client = await pool.connect();
    try {
      const owned = await client.query(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      await generateShoppingListForPlaylist(client, playlistId);
      const list = await loadPlaylistShoppingList(client, playlistId);
      res.json(list);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /playlists/:id/shopping-list/generate failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/playlist-list/items/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const { checked } = req.body ?? {};
    if (isNaN(itemId) || itemId < 1) return res.status(400).json({ error: 'Invalid item id.' });
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (typeof checked !== 'boolean') return res.status(400).json({ error: 'checked must be a boolean' });
    const result = await pool.query(
      `UPDATE playlist_shopping_list_items sli
       SET checked = $1
       FROM playlist_shopping_lists sl
       JOIN playlists p ON p.id = sl.playlist_id
       WHERE sli.id = $2
         AND sli.shopping_list_id = sl.id
         AND p.user_id = $3
       RETURNING sli.id, sli.checked`,
      [checked, itemId, user_id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Shopping list item not found' });
    res.json({ id: result.rows[0].id, checked: result.rows[0].checked });
  } catch (err) {
    log('ERROR', 'PATCH /playlist-list/items/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/playlists/:id/shopping-list/clear-checks', authenticateToken, async (req: Request, res: Response) => {
  try {
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const playlistId = parseInt(req.params.id, 10);
    if (user_id == null) return res.status(401).json({ error: 'Authentication required.' });
    if (isNaN(playlistId) || playlistId < 1) return res.status(400).json({ error: 'Invalid list id.' });
    const client = await pool.connect();
    try {
      const owned = await client.query(
        'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
        [playlistId, user_id]
      );
      if (!owned.rows[0]) return res.status(404).json({ error: 'List not found' });
      const listRow = await client.query<{ id: number }>(
        'SELECT id FROM playlist_shopping_lists WHERE playlist_id = $1',
        [playlistId]
      );
      if (!listRow.rows[0]) return res.status(404).json({ error: 'Shopping list not found' });
      await client.query(
        'UPDATE playlist_shopping_list_items SET checked = FALSE WHERE shopping_list_id = $1',
        [listRow.rows[0].id]
      );
      const list = await loadPlaylistShoppingList(client, playlistId);
      res.json(list);
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /playlists/:id/shopping-list/clear-checks failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/shopping-list/:plan_id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.plan_id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan_id. Must be a positive integer.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const client = await pool.connect();
    try {
      const planResult = await client.query(
        'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
        [planId, user_id]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Meal plan not found' });
      }

      const listResult = await client.query<{ id: number; total_cost: string | null }>(
        'SELECT id, total_cost FROM shopping_lists WHERE meal_plan_id = $1',
        [planId]
      );

      let shoppingListId: number;
      let totalCost: number;

      if (listResult.rows.length === 0) {
        await client.query('BEGIN');
        try {
          const generated = await generateShoppingListForPlan(client, planId);
          shoppingListId = generated.shoppingListId;
          totalCost = generated.totalCost;
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK').catch(() => {});
          throw txErr;
        }
      } else {
        shoppingListId = listResult.rows[0].id;
        totalCost = listResult.rows[0].total_cost != null ? parseFloat(listResult.rows[0].total_cost) : 0;
      }

      const itemsResult = await client.query<ShoppingItemRow>(
        `SELECT id, ingredient_name, quantity, unit, category, estimated_price, checked
         FROM shopping_list_items WHERE shopping_list_id = $1
         ORDER BY category NULLS LAST, ingredient_name`,
        [shoppingListId]
      );

      res.json({
        shopping_list_id: shoppingListId,
        plan_id: planId,
        items: mapShoppingItems(itemsResult.rows),
        total_cost: totalCost,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'GET /shopping-list/:plan_id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/shopping-list/:plan_id/generate', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.plan_id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan_id. Must be a positive integer.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const client = await pool.connect();
    try {
      const planResult = await client.query(
        'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
        [planId, user_id]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Meal plan not found' });
      }

      await client.query('BEGIN');
      try {
        const { shoppingListId, totalCost } = await generateShoppingListForPlan(client, planId);
        await client.query('COMMIT');

        const itemsResult = await client.query<ShoppingItemRow>(
          `SELECT id, ingredient_name, quantity, unit, category, estimated_price, checked
           FROM shopping_list_items WHERE shopping_list_id = $1
           ORDER BY category NULLS LAST, ingredient_name`,
          [shoppingListId]
        );

        res.json({
          shopping_list_id: shoppingListId,
          plan_id: planId,
          items: mapShoppingItems(itemsResult.rows),
          total_cost: totalCost,
        });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /shopping-list/:plan_id/generate failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/shopping-list/items/:id', authenticateToken, async (req: Request, res: Response) => {
  try {
    const itemId = parseInt(req.params.id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    const { checked } = req.body ?? {};

    if (isNaN(itemId) || itemId < 1) {
      return res.status(400).json({ error: 'Invalid item id.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (typeof checked !== 'boolean') {
      return res.status(400).json({ error: 'checked must be a boolean' });
    }

    const result = await pool.query(
      `UPDATE shopping_list_items sli
       SET checked = $1
       FROM shopping_lists sl
       JOIN meal_plans mp ON mp.id = sl.meal_plan_id
       WHERE sli.id = $2
         AND sli.shopping_list_id = sl.id
         AND mp.user_id = $3
       RETURNING sli.id, sli.checked`,
      [checked, itemId, user_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Shopping list item not found' });
    }

    res.json({ id: result.rows[0].id, checked: result.rows[0].checked });
  } catch (err) {
    log('ERROR', 'PATCH /shopping-list/items/:id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/shopping-list/:plan_id/clear-checks', authenticateToken, async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.plan_id, 10);
    const user_id = (req as AuthenticatedRequest).user?.userId;
    if (isNaN(planId) || planId < 1) {
      return res.status(400).json({ error: 'Invalid plan_id. Must be a positive integer.' });
    }
    if (user_id == null) {
      return res.status(401).json({ error: 'Authentication required.' });
    }

    const client = await pool.connect();
    try {
      const planResult = await client.query(
        'SELECT id FROM meal_plans WHERE id = $1 AND user_id = $2',
        [planId, user_id]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Meal plan not found' });
      }

      const listResult = await client.query<{ id: number; total_cost: string | null }>(
        'SELECT id, total_cost FROM shopping_lists WHERE meal_plan_id = $1',
        [planId]
      );
      if (listResult.rows.length === 0) {
        return res.status(404).json({ error: 'Shopping list not found' });
      }

      const shoppingListId = listResult.rows[0].id;
      await client.query(
        'UPDATE shopping_list_items SET checked = FALSE WHERE shopping_list_id = $1',
        [shoppingListId]
      );

      const itemsResult = await client.query<ShoppingItemRow>(
        `SELECT id, ingredient_name, quantity, unit, category, estimated_price, checked
         FROM shopping_list_items WHERE shopping_list_id = $1
         ORDER BY category NULLS LAST, ingredient_name`,
        [shoppingListId]
      );

      res.json({
        shopping_list_id: shoppingListId,
        plan_id: planId,
        items: mapShoppingItems(itemsResult.rows),
        total_cost: listResult.rows[0].total_cost != null ? parseFloat(listResult.rows[0].total_cost) : 0,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /shopping-list/:plan_id/clear-checks failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

function buildRetailerUrl(retailer: Retailer): string {
  const utmSource = encodeURIComponent(config.UTM_SOURCE);

  switch (retailer) {
    case 'tesco':
      return `https://www.tesco.com/groceries/en-GB/?utm_source=${utmSource}`;
    case 'sainsburys':
      return `https://www.sainsburys.co.uk/gol-ui/groceries?utm_source=${utmSource}`;
    default:
      throw new Error(`Unknown retailer: ${retailer}`);
  }
}

// No product-level search: retailer search boxes only handle one term, and a whole
// week's ingredient list doesn't map to a single query. This links to the retailer's
// grocery homepage instead, so the customer shops normally with the affiliate
// tracking tag attached while referring to the shopping list still on screen.
app.post('/affiliate-link', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { retailer } = req.body;

    if (typeof retailer !== 'string' || !RETAILERS.includes(retailer.toLowerCase() as Retailer)) {
      return res.status(400).json({
        error: 'Invalid request. Required: retailer ("tesco" | "sainsburys")',
      });
    }

    const url = buildRetailerUrl(retailer.toLowerCase() as Retailer);
    res.json({ url });
  } catch (err) {
    log('ERROR', 'POST /affiliate-link failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// 404 & Error Handlers
// ---------------------------------------------------------------------------

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log('ERROR', 'Unhandled error', { err: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Startup: apply schema.sql (idempotent, IF NOT EXISTS) so a fresh database
// gets its tables created automatically instead of needing a manual step.
// ---------------------------------------------------------------------------

async function applySchemaAndStart() {
  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await pool.query(schemaSql);
    const existing = await pool.query('SELECT count(*)::int AS n FROM collections');
    if ((existing.rows[0]?.n ?? 0) === 0) {
      const rows = [
        ['italian', 'Italian classics', 'Carbonara, ragù, risotto — the real ones.', 1],
        ['french', 'French classics', 'Bistro plates you can cook at home.', 2],
        ['british', 'British comfort', 'Sunday energy, weeknight ease.', 3],
        ['japanese', 'Japanese favourites', 'Clean flavours, weeknight-friendly.', 4],
        ['indian', 'Indian classics', 'Spice, warmth, and balance.', 5],
        ['mexican', 'Mexican kitchen', 'Bright, bold, shareable plates.', 6],
        ['mediterranean', 'Mediterranean', 'Olive oil, herbs, sunshine plates.', 7],
        ['vegetarian', 'Vegetarian', 'No meat — still proper supper.', 8],
        ['vegan', 'Vegan', 'Plant-based, cooked with care.', 9],
        ['wellbeing', 'High-protein', 'Wellbeing without sad salads.', 10],
        ['budget', 'Budget week', 'Feed well when prices bite.', 11],
        ['pantry', 'From the cupboard', 'Cook what you already have.', 12],
      ];
      for (const [slug, title, blurb, sort] of rows) {
        await pool.query(
          'INSERT INTO collections (slug, title, blurb, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
          [slug, title, blurb, sort]
        );
      }
      log('INFO', 'Seeded house collections');
    }
    log('INFO', 'Database schema up to date');
  } catch (err) {
    log('ERROR', 'Failed to apply database schema', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }

  app.listen(config.PORT, '0.0.0.0', () => {
    log('INFO', `Server listening on port ${config.PORT}`);
  });
}

applySchemaAndStart();
