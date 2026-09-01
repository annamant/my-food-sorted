-- My Food SORTED - Database Schema
-- PostgreSQL - Production Ready

-- Users
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  dietary_preferences TEXT,
  allergies TEXT,
  household_size INT DEFAULT 1,
  default_budget DECIMAL(10, 2),
  preferred_retailer VARCHAR(50) DEFAULT 'tesco',
  message_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Existing databases: add preferred_retailer if missing
ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_retailer VARCHAR(50) DEFAULT 'tesco';

-- Structured cooking profile (generalist)
ALTER TABLE users ADD COLUMN IF NOT EXISTS cooking_skill VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cuisines TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_cook_minutes INT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS kitchen_equipment TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cooks_for VARCHAR(100);

-- Light body info (generalist — no medication, no weight-loss targeting)
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_range VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS sex VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS activity_level VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg NUMERIC(5,1);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);

-- Chat messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender VARCHAR(50) NOT NULL,
  message_text TEXT NOT NULL,
  conversation_id VARCHAR(100) NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_user ON chat_messages(conversation_id, user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp ON chat_messages(timestamp);

-- Meal plans (library entries — single recipes or weekly playlists)
CREATE TABLE IF NOT EXISTS meal_plans (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_name VARCHAR(255),
  total_estimated_cost DECIMAL(10, 2),
  servings INT,
  status VARCHAR(50) DEFAULT 'draft',
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  share_slug VARCHAR(32) UNIQUE,
  shared_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_meal_plans_user_id ON meal_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_meal_plans_status ON meal_plans(status);
CREATE INDEX IF NOT EXISTS idx_meal_plans_created_at ON meal_plans(created_at);

-- Existing databases: add share columns before indexes that depend on them
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS share_slug VARCHAR(32) UNIQUE;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS shared_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_meal_plans_share_slug ON meal_plans(share_slug) WHERE share_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meal_plans_is_public ON meal_plans(is_public) WHERE is_public = TRUE;

-- Recipes (linked to meal plans)
CREATE TABLE IF NOT EXISTS recipes (
  id SERIAL PRIMARY KEY,
  meal_plan_id INT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  day_of_week VARCHAR(20) NOT NULL,
  meal_slot VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  instructions TEXT,
  prep_time INT,
  cook_time INT,
  estimated_cost DECIMAL(10, 2),
  calories INT,
  protein DECIMAL(10, 2),
  carbs DECIMAL(10, 2),
  fat DECIMAL(10, 2),
  image_url TEXT
);

-- Existing databases: store a photo of the actual dish
ALTER TABLE recipes ADD COLUMN IF NOT EXISTS image_url TEXT;

CREATE INDEX IF NOT EXISTS idx_recipes_meal_plan_id ON recipes(meal_plan_id);
CREATE INDEX IF NOT EXISTS idx_recipes_day_meal ON recipes(meal_plan_id, day_of_week, meal_slot);

-- Ingredients (linked to recipes)
CREATE TABLE IF NOT EXISTS ingredients (
  id SERIAL PRIMARY KEY,
  recipe_id INT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10, 3),
  unit VARCHAR(50),
  category VARCHAR(100),
  estimated_price DECIMAL(10, 2)
);

CREATE INDEX IF NOT EXISTS idx_ingredients_recipe_id ON ingredients(recipe_id);
CREATE INDEX IF NOT EXISTS idx_ingredients_category ON ingredients(category);

-- Shopping lists (linked to meal plans; one list per plan for ON CONFLICT upsert)
CREATE TABLE IF NOT EXISTS shopping_lists (
  id SERIAL PRIMARY KEY,
  meal_plan_id INT NOT NULL UNIQUE REFERENCES meal_plans(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  total_cost DECIMAL(10, 2)
);

CREATE INDEX IF NOT EXISTS idx_shopping_lists_meal_plan_id ON shopping_lists(meal_plan_id);
CREATE INDEX IF NOT EXISTS idx_shopping_lists_created_at ON shopping_lists(created_at);

-- Existing databases created before meal_plan_id UNIQUE
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shopping_lists_meal_plan_id_key'
  ) THEN
    ALTER TABLE shopping_lists ADD CONSTRAINT shopping_lists_meal_plan_id_key UNIQUE (meal_plan_id);
  END IF;
END $$;

-- Shopping list items
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id SERIAL PRIMARY KEY,
  shopping_list_id INT NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  ingredient_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10, 3),
  unit VARCHAR(50),
  category VARCHAR(100),
  estimated_price DECIMAL(10, 2),
  checked BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_shopping_list_items_shopping_list_id ON shopping_list_items(shopping_list_id);
CREATE INDEX IF NOT EXISTS idx_shopping_list_items_checked ON shopping_list_items(checked);

-- House catalog (classics that already exist — not per-user meal_plans)
CREATE TABLE IF NOT EXISTS collections (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(64) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  blurb TEXT,
  cover_url TEXT,
  sort_order INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS catalog_recipes (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(128) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL,
  blurb TEXT,
  image_url TEXT,
  payload JSONB NOT NULL,
  search_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS catalog_recipe_collections (
  catalog_recipe_id INT NOT NULL REFERENCES catalog_recipes(id) ON DELETE CASCADE,
  collection_id INT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  PRIMARY KEY (catalog_recipe_id, collection_id)
);

CREATE INDEX IF NOT EXISTS idx_catalog_recipes_search ON catalog_recipes (search_text);
CREATE INDEX IF NOT EXISTS idx_catalog_recipe_collections_collection ON catalog_recipe_collections (collection_id);

-- User playlists (Spotify-style lists of saved dishes)
CREATE TABLE IF NOT EXISTS playlists (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  blurb TEXT,
  kind VARCHAR(20) NOT NULL DEFAULT 'custom',
  is_public BOOLEAN NOT NULL DEFAULT FALSE,
  share_slug VARCHAR(32) UNIQUE,
  shared_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
CREATE INDEX IF NOT EXISTS idx_playlists_share_slug ON playlists(share_slug) WHERE share_slug IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_playlists_user_liked ON playlists(user_id) WHERE kind = 'liked';

CREATE TABLE IF NOT EXISTS playlist_items (
  playlist_id INT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  meal_plan_id INT NOT NULL REFERENCES meal_plans(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (playlist_id, meal_plan_id)
);

CREATE INDEX IF NOT EXISTS idx_playlist_items_plan ON playlist_items(meal_plan_id);
CREATE INDEX IF NOT EXISTS idx_playlist_items_order ON playlist_items(playlist_id, sort_order);

CREATE TABLE IF NOT EXISTS playlist_shopping_lists (
  id SERIAL PRIMARY KEY,
  playlist_id INT NOT NULL UNIQUE REFERENCES playlists(id) ON DELETE CASCADE,
  total_cost DECIMAL(10, 2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS playlist_shopping_list_items (
  id SERIAL PRIMARY KEY,
  shopping_list_id INT NOT NULL REFERENCES playlist_shopping_lists(id) ON DELETE CASCADE,
  ingredient_name VARCHAR(255) NOT NULL,
  quantity DECIMAL(10, 3),
  unit VARCHAR(50),
  category VARCHAR(100),
  estimated_price DECIMAL(10, 2),
  checked BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_playlist_shop_items_list ON playlist_shopping_list_items(shopping_list_id);

-- Meal feedback (generalist matching engine learning loop)
CREATE TABLE IF NOT EXISTS meal_feedback (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feedback_key TEXT NOT NULL,
  feedback VARCHAR(32),
  repeat VARCHAR(32),
  plan_id INT REFERENCES meal_plans(id) ON DELETE SET NULL,
  recipe_title TEXT,
  day_label TEXT,
  meal_slot TEXT,
  calories NUMERIC,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, feedback_key)
);

CREATE INDEX IF NOT EXISTS idx_meal_feedback_user_id ON meal_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_meal_feedback_feedback ON meal_feedback(feedback);
CREATE INDEX IF NOT EXISTS idx_meal_feedback_recorded_at ON meal_feedback(recorded_at);

ALTER TABLE meal_feedback ALTER COLUMN feedback DROP NOT NULL;

-- Companion chat + private journal
ALTER TABLE users ADD COLUMN IF NOT EXISTS companion_message_count INT DEFAULT 0;

-- Food logs (generalist journal — photo + text "what I ate/cooked")
CREATE TABLE IF NOT EXISTS food_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description TEXT NOT NULL,
  items JSONB,
  estimated_protein_g NUMERIC,
  estimated_calories NUMERIC,
  estimated_carbs_g NUMERIC,
  estimated_fat_g NUMERIC,
  coach_note TEXT,
  meal_plan_id INT REFERENCES meal_plans(id) ON DELETE SET NULL,
  recipe_title TEXT,
  source VARCHAR(20) DEFAULT 'text',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_food_logs_user_logged ON food_logs(user_id, logged_at DESC);

-- Journal entries (persistent private journal — saved or AI-summarized from companion chat)
CREATE TABLE IF NOT EXISTS journal_entries (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id VARCHAR(100),
  source_message_id INT REFERENCES chat_messages(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  meal_plan_id INT REFERENCES meal_plans(id) ON DELETE SET NULL,
  recipe_title TEXT,
  entry_kind VARCHAR(20) DEFAULT 'saved',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_user_created ON journal_entries(user_id, created_at DESC);
