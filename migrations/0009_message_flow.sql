-- The message flow: where an English translation came from, and whether it failed
-- (the worker then sees the original only, with a warning).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS english_source     TEXT CHECK (english_source IN ('machine', 'template', 'none'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS translation_failed BOOLEAN NOT NULL DEFAULT FALSE;
-- Which danger list or rule made a message urgent, and on which text (original or English).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS urgent_reason      TEXT;
