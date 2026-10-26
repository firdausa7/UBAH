-- Voice notes: what the speech model thought she spoke, how sure it was, and whether that
-- disagrees with the language she chose. Shown to the worker; the audio itself is never kept.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS detected_language TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS stt_confidence    REAL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS language_mismatch BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS voice_unclear     BOOLEAN NOT NULL DEFAULT FALSE;
