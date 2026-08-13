-- Public sharing for meal plans (Spotify-style library share links)

ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS share_slug VARCHAR(32) UNIQUE;
ALTER TABLE meal_plans ADD COLUMN IF NOT EXISTS shared_at TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_meal_plans_share_slug ON meal_plans(share_slug) WHERE share_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meal_plans_is_public ON meal_plans(is_public) WHERE is_public = TRUE;
