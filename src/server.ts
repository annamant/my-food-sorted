import 'dotenv/config';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { authenticateToken, AuthenticatedRequest } from './middleware/auth';
import { Pool, PoolClient } from 'pg';
import cors from 'cors';
import * as fs from 'fs';
import * as path from 'path';
import { config, RETAILERS, type Retailer } from './config';

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

const MEAL_PLANNING_SYSTEM_PROMPT = `You are My Food SORTED, an AI assistant that helps users plan meals, manage budgets, and generate shopping lists.

Your responsibilities:
- Create practical, budget-conscious meal plans based on user preferences, dietary requirements, and allergies
- Respect household size and default budget when suggesting meals
- Provide recipes with clear instructions, prep/cook times, and nutritional info (calories, protein, carbs, fat)
- When returning meal plans, always respond with valid JSON in this structure:
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
- Ingredient naming and units must be consistent across every recipe in the same plan, since matching ingredients get combined into one shopping list line: use the same lowercase singular name for the same ingredient every time it appears (e.g. always "onion", not "onions" or "red onion" unless it's genuinely a different ingredient), and always use the same metric unit for a given ingredient (e.g. always grams, not a mix of "g" and "kg").
- Be concise, friendly, and helpful. If the user's message doesn't require a meal plan, respond conversationally without JSON.`;

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
    ingredients?: Array<{
      ingredient_name?: string;
      quantity?: number;
      unit?: string;
      category?: string;
      estimated_price?: number;
    }>;
  }>;
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

function buildSystemPrompt(prefs: UserPrefs | null): string {
  if (!prefs) return MEAL_PLANNING_SYSTEM_PROMPT;

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

  if (lines.length === 0) return MEAL_PLANNING_SYSTEM_PROMPT;

  return `${MEAL_PLANNING_SYSTEM_PROMPT}

Known preferences for this user (always respect these unless they override them in the conversation):
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

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();

app.use(helmet());
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
      const token = jwt.sign({ userId: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: '1h' });
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

      const token = jwt.sign({ userId: user.id, email: user.email }, config.JWT_SECRET, { expiresIn: '1h' });
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

// ---------------------------------------------------------------------------
// Protected Routes
// ---------------------------------------------------------------------------

app.post('/chat', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { user_message, conversation_id } = req.body;
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

      const assistantText = await callMealPlanningAPI(messages, buildSystemPrompt(prefs));

      await client.query(
        'INSERT INTO chat_messages (user_id, sender, message_text, conversation_id) VALUES ($1, $2, $3, $4)',
        [user_id, 'assistant', assistantText, convId]
      );

      const mealPlan = parseRecipeJSON(assistantText);
      const displayMessage = mealPlan ? messageWithoutJsonBlock(assistantText) : assistantText;

      res.json({
        message: displayMessage,
        ...(mealPlan && { meal_plan: mealPlan }),
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

        totalEstimatedCost += estimatedCost;

        const recipeResult = await client.query<{ id: number }>(
          `INSERT INTO recipes (meal_plan_id, day_of_week, meal_slot, title, instructions, prep_time, cook_time, estimated_cost, calories, protein, carbs, fat)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [mealPlanId, dayOfWeek, mealSlot, title, instructions, prepTime, cookTime, estimatedCost, calories, protein, carbs, fat]
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

      await client.query('COMMIT');

      res.status(201).json({
        meal_plan_id: mealPlanId,
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
        `SELECT id, plan_name, total_estimated_cost, servings, status, created_at
         FROM meal_plans WHERE id = $1 AND user_id = $2`,
        [planId, user_id]
      );
      if (planResult.rows.length === 0) {
        return res.status(404).json({ error: 'Meal plan not found' });
      }
      const plan = planResult.rows[0];

      const recipesResult = await client.query(
        `SELECT id, day_of_week, meal_slot, title, instructions, prep_time, cook_time,
                estimated_cost, calories, protein, carbs, fat
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
          ingredients: ingredientsResult.rows.map((ing) => ({
            ingredient_name: ing.ingredient_name,
            quantity: ing.quantity != null ? parseFloat(ing.quantity) : null,
            unit: ing.unit,
            category: ing.category,
            estimated_price: ing.estimated_price != null ? parseFloat(ing.estimated_price) : null,
          })),
        });
      }

      res.json({
        id: plan.id,
        plan_name: plan.plan_name,
        total_estimated_cost: plan.total_estimated_cost != null ? parseFloat(plan.total_estimated_cost) : null,
        servings: plan.servings,
        status: plan.status,
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
