-- Add message_count to users table for chat rate limiting (10 messages per user).
-- Run this if your database was created before this column was added to schema.sql.

ALTER TABLE users ADD COLUMN IF NOT EXISTS message_count INT DEFAULT 0;
