-- One app for girls, health workers and admins.
-- Girls stay in `users` (no name; phone only hashed + encrypted) and staff in `staff`: one login page,
-- two tables. "health_worker" in the app means a staff member with the nurse or dada role.

-- ---- Girls' login on the web: phone + SMS code once, then a PIN on her phone ----
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash          TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_failures      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_locked_until  TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS girl_otp (
  id          SERIAL PRIMARY KEY,
  phone_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_girl_otp_phone ON girl_otp(phone_hash, created_at DESC);

CREATE TABLE IF NOT EXISTS girl_sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_girl_sessions_user ON girl_sessions(user_id);

-- ---- Which health worker looks after which girl (one active assignment per girl) ----
CREATE TABLE IF NOT EXISTS assignments (
  id                SERIAL PRIMARY KEY,
  health_worker_id  INTEGER NOT NULL REFERENCES staff(id),
  girl_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assigned_by       INTEGER REFERENCES staff(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at          TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_assignment_active ON assignments(girl_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_assignment_worker ON assignments(health_worker_id) WHERE ended_at IS NULL;

-- ---- What each girl agreed to share with her health worker ----
-- scope: messages (her messages and the replies) | voice (her recorded voice notes)
-- The latest row per scope counts. Urgent messages always reach a human, whatever she chose.
CREATE TABLE IF NOT EXISTS consents (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('messages', 'voice')),
  granted     BOOLEAN NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_consents_user ON consents(user_id, scope, id DESC);

-- ---- Her voice notes, encrypted, kept only for the worker to listen to ----
-- Deleted after 30 days, or as soon as the message is resolved.
CREATE TABLE IF NOT EXISTS voice_notes (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  mime         TEXT NOT NULL,
  bytes_enc    BYTEA NOT NULL,
  size         INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  delete_after TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_voice_notes_delete ON voice_notes(delete_after);

-- ---- Messages: the full picture a worker needs ----
ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_ref       INTEGER REFERENCES voice_notes(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS original_text   TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS chosen_language TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS english_text    TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS urgent          BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS status          TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'open', 'resolved'));
CREATE INDEX IF NOT EXISTS idx_messages_inbox ON messages(user_id, direction, urgent DESC, created_at DESC);

-- ---- A worker's reply, in English and as the girl receives it ----
CREATE TABLE IF NOT EXISTS replies (
  id                  SERIAL PRIMARY KEY,
  message_id          INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  worker_id           INTEGER NOT NULL REFERENCES staff(id),
  english_text        TEXT NOT NULL,
  translated_text     TEXT NOT NULL,
  translation_source  TEXT NOT NULL CHECK (translation_source IN ('template', 'machine', 'none')),
  voice_ref           INTEGER REFERENCES media(id),
  sent_message_id     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_replies_message ON replies(message_id);

-- ---- Answers a native speaker has checked, used instead of machine translation ----
CREATE TABLE IF NOT EXISTS answer_templates (
  id               SERIAL PRIMARY KEY,
  language         TEXT NOT NULL,
  english_text     TEXT NOT NULL,
  translated_text  TEXT NOT NULL DEFAULT '',
  reviewed_by      TEXT NOT NULL DEFAULT '',      -- name of the native speaker who checked it; empty = not reviewed
  reviewed_at      TIMESTAMPTZ,
  created_by       INTEGER REFERENCES staff(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  active           BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_text ON answer_templates(language, lower(english_text)) WHERE active;

-- ---- Who looked at which girl's data, and when (append-only, like audit_log) ----
-- what: profile | messages | message | voice. Never stores the content itself.
CREATE TABLE IF NOT EXISTS access_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id    INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  staff_login TEXT,
  girl_id     INTEGER,                              -- kept (not a foreign key) so the record survives her DELETE
  what        TEXT NOT NULL,
  target_id   TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_girl ON access_log(girl_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_access_staff ON access_log(staff_id, at DESC);

CREATE OR REPLACE FUNCTION access_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.staff_id IS NULL AND OLD.staff_id IS NOT NULL
     AND NEW.at = OLD.at AND NEW.what = OLD.what
     AND NEW.girl_id IS NOT DISTINCT FROM OLD.girl_id
     AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'access_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_log_no_change ON access_log;
CREATE TRIGGER access_log_no_change BEFORE UPDATE OR DELETE ON access_log
  FOR EACH ROW EXECUTE FUNCTION access_log_append_only();
