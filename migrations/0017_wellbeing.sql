-- Her private wellbeing: mood check-ins and journal entries. Only she can read them (no staff route
-- exists); the text is encrypted; never sent to any outside service; deleted with her account.
CREATE TABLE IF NOT EXISTS wellbeing_entries (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mood        SMALLINT CHECK (mood BETWEEN 1 AND 5), -- 1 very low … 5 very good
  note_enc    TEXT,                                  -- her words, encrypted (AES-256-GCM)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (mood IS NOT NULL OR note_enc IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_wellbeing_user ON wellbeing_entries(user_id, created_at DESC);
