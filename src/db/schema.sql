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
