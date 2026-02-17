import 'dotenv/config';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import express, { Request, Response, NextFunction } from 'express';
import { authenticateToken, AuthenticatedRequest } from './middleware/auth';
import { Pool } from 'pg';
import cors from 'cors';

// ---------------------------------------------------------------------------
// Environment & Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkey';

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is required. Set it in .env');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database Connection Pool
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: DATABASE_URL,
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
// Claude API Integration
// ---------------------------------------------------------------------------

const CLAUDE_MEAL_PLANNING_SYSTEM_PROMPT = `You are My Food SORTED, an AI assistant that helps users plan meals, manage budgets, and generate shopping lists.

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
- Be concise, friendly, and helpful. If the user's message doesn't require a meal plan, respond conversationally without JSON.`;

interface ClaudeMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ClaudeResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason?: string;
}

async function callClaudeAPI(
  messages: ClaudeMessage[],
  systemPrompt: string = CLAUDE_MEAL_PLANNING_SYSTEM_PROMPT
): Promise<string> {
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY is not set');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = (await response.json()) as ClaudeResponse;
  const textContent = data.content?.find((c) => c.type === 'text');
  return textContent?.text ?? '';
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
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.recipes)) {
      return parsed as unknown as ParsedMealPlan;
    }
    return null;
  } catch {
    return null;
  }
}

/** Remove the meal-plan JSON block from assistant text so the chat shows only conversational content. */
function messageWithoutJsonBlock(text: string): string {
  // Remove entire ```json ... ``` code block (greedy match to closing ```)
  let out = text.replace(/```json\s*[\s\S]*?```/g, '');
  // If no fenced block, remove raw { ... } that we parse as meal plan
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) out = out.replace(jsonMatch[0], '');
  return out.replace(/\n{3,}/g, '\n\n').trim() || text;
}

// ---------------------------------------------------------------------------
// Express App
// ---------------------------------------------------------------------------

const app = express();

app.use(cors());
app.use(express.json());

app.use((req: Request, _res: Response, next: NextFunction) => {
  log('INFO', `${req.method} ${req.path}`, { ip: req.ip });
  next();
});

// ---------------------------------------------------------------------------
// Authentication Routes
// ---------------------------------------------------------------------------

app.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || !email.trim() || !/^[\w-.]+@([\w-]+\.)+[\w-]{2,4}$/.test(email)) {
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
      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
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

app.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password.trim()) {
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

      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
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

    if (!CLAUDE_API_KEY) {
      return res.status(503).json({ error: 'Claude API is not configured' });
    }

    const client = await pool.connect();

    try {
      await client.query('INSERT INTO chat_messages (user_id, sender, message_text, conversation_id) VALUES ($1, $2, $3, $4)', [
        user_id,
        'user',
        user_message.trim(),
        conversation_id.trim().slice(0, 100),
      ]);

      const historyResult = await client.query(
        `SELECT sender, message_text FROM chat_messages 
         WHERE conversation_id = $1 AND user_id = $2 
         ORDER BY timestamp ASC`,
        [conversation_id.trim(), user_id]
      );

      const messages: ClaudeMessage[] = historyResult.rows.map((row: { sender: string; message_text: string }) => ({
        role: row.sender === 'user' ? 'user' : 'assistant',
        content: row.message_text,
      }));

      const assistantText = await callClaudeAPI(messages);

      await client.query(
        'INSERT INTO chat_messages (user_id, sender, message_text, conversation_id) VALUES ($1, $2, $3, $4)',
        [user_id, 'assistant', assistantText, conversation_id.trim().slice(0, 100)]
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

    const client = await pool.connect();
    try {
      let totalEstimatedCost = 0;

      const mealPlanResult = await client.query(
        `INSERT INTO meal_plans (user_id, plan_name, total_estimated_cost, servings, status)
         VALUES ($1, $2, 0, $3, 'draft') RETURNING id`,
        [user_id, plan_name.trim(), servings]
      );
      const mealPlanId = mealPlanResult.rows[0].id as number;

      for (const r of recipes) {
        const dayOfWeek = (r.day_of_week || 'Monday').toString().slice(0, 20);
        const mealSlot = (r.meal_slot || 'dinner').toString().slice(0, 50);
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

        const recipeResult = await client.query(
          `INSERT INTO recipes (meal_plan_id, day_of_week, meal_slot, title, instructions, prep_time, cook_time, estimated_cost, calories, protein, carbs, fat)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [mealPlanId, dayOfWeek, mealSlot, title, instructions, prepTime, cookTime, estimatedCost, calories, protein, carbs, fat]
        );
        const recipeId = recipeResult.rows[0].id as number;

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

      res.status(201).json({
        meal_plan_id: mealPlanId,
        plan_name: plan_name.trim(),
        total_estimated_cost: totalEstimatedCost,
        servings,
        recipes_count: recipes.length,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /meal-plan failed', { err: String(err) });
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

      let listResult = await client.query(
        'SELECT id FROM shopping_lists WHERE meal_plan_id = $1',
        [planId]
      );
      let shoppingListId: number;

      if (listResult.rows.length === 0) {
        const insertResult = await client.query(
          'INSERT INTO shopping_lists (meal_plan_id, total_cost) VALUES ($1, 0) RETURNING id',
          [planId]
        );
        shoppingListId = insertResult.rows[0].id as number;
      } else {
        shoppingListId = listResult.rows[0].id as number;
        await client.query('DELETE FROM shopping_list_items WHERE shopping_list_id = $1', [shoppingListId]);
      }

      const aggResult = await client.query(
        `SELECT
           i.ingredient_name,
           COALESCE(i.unit, '') AS unit,
           i.category,
           SUM(i.quantity) AS quantity,
           SUM(i.estimated_price) AS estimated_price
         FROM ingredients i
         JOIN recipes r ON r.id = i.recipe_id
         WHERE r.meal_plan_id = $1
         GROUP BY i.ingredient_name, COALESCE(i.unit, ''), i.category`,
        [planId]
      );

      let totalCost = 0;
      for (const row of aggResult.rows) {
        const qty = row.quantity != null ? parseFloat(row.quantity) : null;
        const price = row.estimated_price != null ? parseFloat(row.estimated_price) : null;
        if (price != null) totalCost += price;

        await client.query(
          `INSERT INTO shopping_list_items (shopping_list_id, ingredient_name, quantity, unit, category, estimated_price, checked)
           VALUES ($1, $2, $3, $4, $5, $6, FALSE)`,
          [
            shoppingListId,
            row.ingredient_name,
            qty,
            row.unit === '' ? null : row.unit,
            row.category,
            price,
          ]
        );
      }

      await client.query(
        'UPDATE shopping_lists SET total_cost = $1 WHERE id = $2',
        [totalCost, shoppingListId]
      );

      const itemsResult = await client.query(
        `SELECT ingredient_name, quantity, unit, category, estimated_price, checked
         FROM shopping_list_items WHERE shopping_list_id = $1 ORDER BY category NULLS LAST, ingredient_name`,
        [shoppingListId]
      );

      res.json({
        shopping_list_id: shoppingListId,
        plan_id: planId,
        items: itemsResult.rows.map((r) => ({
          ingredient_name: r.ingredient_name,
          quantity: r.quantity,
          unit: r.unit,
          category: r.category,
          estimated_price: r.estimated_price,
          checked: r.checked,
        })),
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

const RETAILERS = ['tesco', 'sainsburys'] as const;
type Retailer = (typeof RETAILERS)[number];

function buildRetailerSearchUrl(retailer: Retailer, searchQuery: string): string {
  const encoded = encodeURIComponent(searchQuery.trim());
  const utmSource = process.env.UTM_SOURCE || 'my-food-sorted';

  switch (retailer) {
    case 'tesco':
      return `https://www.tesco.com/groceries/en-GB/search?query=${encoded}&utm_source=${encodeURIComponent(utmSource)}`;
    case 'sainsburys':
      return `https://www.sainsburys.co.uk/gol-ui/SearchDisplayView?searchTerm=${encoded}&utm_source=${encodeURIComponent(utmSource)}`;
    default:
      throw new Error(`Unknown retailer: ${retailer}`);
  }
}

app.post('/affiliate-link', authenticateToken, async (req: Request, res: Response) => {
  try {
    const { retailer, search_query } = req.body;

    if (
      typeof retailer !== 'string' ||
      !RETAILERS.includes(retailer.toLowerCase() as Retailer) ||
      typeof search_query !== 'string' ||
      !search_query.trim()
    ) {
      return res.status(400).json({
        error: 'Invalid request. Required: retailer ("tesco" | "sainsburys"), search_query (non-empty string)',
      });
    }

    const url = buildRetailerSearchUrl(retailer.toLowerCase() as Retailer, search_query);
    res.json({ url });
  } catch (err) {
    log('ERROR', 'POST /affiliate-link failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Error Handler & Server Start
// ---------------------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log('ERROR', 'Unhandled error', { err: err.message });
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  log('INFO', `Server listening on port ${PORT}`);
});
