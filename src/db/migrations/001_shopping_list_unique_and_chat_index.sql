-- Run this on existing databases that were created before meal_plan_id UNIQUE and chat composite index.
-- New installs use schema.sql which already includes these. Run once per database.

-- Add UNIQUE on shopping_lists(meal_plan_id) for INSERT ... ON CONFLICT (meal_plan_id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shopping_lists_meal_plan_id_key'
  ) THEN
    ALTER TABLE shopping_lists ADD CONSTRAINT shopping_lists_meal_plan_id_key UNIQUE (meal_plan_id);
  END IF;
END $$;

-- Composite index for chat queries (conversation_id, user_id)
CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_user ON chat_messages(conversation_id, user_id);
