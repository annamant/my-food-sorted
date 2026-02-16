import 'dotenv/config';
import express, { Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import cors from 'cors';

// ---------------------------------------------------------------------------
// Environment & Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATABASE_URL = process.env.DATABASE_URL;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;

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
      model: 'claude-sonnet-4-20250514',
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
// Routes
// ---------------------------------------------------------------------------

app.post('/chat', async (req: Request, res: Response) => {
  try {
    const { user_message, conversation_id, user_id } = req.body;

    if (
      typeof user_message !== 'string' ||
      !user_message.trim() ||
      typeof conversation_id !== 'string' ||
      !conversation_id.trim() ||
      typeof user_id !== 'number' ||
      !Number.isInteger(user_id) ||
      user_id < 1
    ) {
      return res.status(400).json({
        error: 'Invalid request. Required: user_message (string), conversation_id (string), user_id (positive integer)',
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

      res.json({
        message: assistantText,
        ...(mealPlan && { meal_plan: mealPlan }),
      });
    } finally {
      client.release();
    }
  } catch (err) {
    log('ERROR', 'POST /chat failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/meal-plan', async (req: Request, res: Response) => {
  try {
    const mealPlanData = req.body;

    // TODO: Validate meal plan payload (plan_name, servings, recipes array)
    // TODO: Fetch user_id from request (auth/session) or require in body
    // TODO: Insert into meal_plans (user_id, plan_name, total_estimated_cost, servings, status)
    // TODO: For each recipe: insert into recipes (meal_plan_id, day_of_week, meal_slot, ...)
    // TODO: For each ingredient in each recipe: insert into ingredients (recipe_id, ...)
    // TODO: Calculate and update total_estimated_cost on meal_plans
    // TODO: Return { meal_plan_id: number, ... }

    res.status(501).json({ error: 'Not implemented' });
  } catch (err) {
    log('ERROR', 'POST /meal-plan failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/shopping-list/:plan_id', async (req: Request, res: Response) => {
  try {
    const planId = parseInt(req.params.plan_id, 10);

    // TODO: Validate plan_id
    // TODO: Check meal plan exists and user has access
    // TODO: Create shopping_lists row for meal_plan_id if not exists
    // TODO: Aggregate ingredients from all recipes in plan (sum quantities by ingredient_name + unit)
    // TODO: Insert/upsert into shopping_list_items
    // TODO: Calculate total_cost
    // TODO: Return { shopping_list_id, items: [...], total_cost }

    res.status(501).json({ error: 'Not implemented' });
  } catch (err) {
    log('ERROR', 'GET /shopping-list/:plan_id failed', { err: String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/affiliate-link', async (req: Request, res: Response) => {
  try {
    const { retailer, search_query } = req.body;

    // TODO: Validate retailer ('tesco' | 'sainsburys') and search_query
    // TODO: Build affiliate URL for Tesco or Sainsbury's search
    // TODO: Apply affiliate tracking params if configured
    // TODO: Return { url: string }

    res.status(501).json({ error: 'Not implemented' });
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
