-- Phase 1: staff security (lockout, 2FA, server-side sessions), audit log, background jobs.

-- ---- Staff accounts ----
ALTER TABLE staff ADD COLUMN IF NOT EXISTS failed_logins        INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS locked_until         TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS password_changed_at  TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_secret_enc      TEXT;          -- AES-256-GCM, never in clear
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_enabled_at      TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS totp_last_step       BIGINT;        -- blocks re-use of a code
ALTER TABLE staff ADD COLUMN IF NOT EXISTS last_login_at        TIMESTAMPTZ;
ALTER TABLE staff ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT now();

-- One-time recovery codes for staff who lose their authenticator phone (hashed).
CREATE TABLE IF NOT EXISTS staff_recovery_codes (
  id          SERIAL PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_recovery_staff ON staff_recovery_codes(staff_id) WHERE used_at IS NULL;

-- SMS login codes for Dadas (hashed, short-lived, limited attempts).
CREATE TABLE IF NOT EXISTS staff_otp (
  id          SERIAL PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_staff_otp_staff ON staff_otp(staff_id, created_at DESC);

-- Server-side sessions: logout, deactivation and password resets take effect at once.
-- Only a hash of the session token is stored.
CREATE TABLE IF NOT EXISTS staff_sessions (
  token_hash    TEXT PRIMARY KEY,
  staff_id      INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  mfa_passed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  ip            TEXT,
  user_agent    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_staff ON staff_sessions(staff_id) WHERE revoked_at IS NULL;

-- ---- Who sent what ----
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by_staff INTEGER REFERENCES staff(id);

-- Outbox retries.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS kind            TEXT NOT NULL DEFAULT 'girl';   -- girl | staff_alert
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS attempts        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

-- ---- Audit log (append-only) ----
-- Records who viewed which case, who sent what, and who changed accounts, content or clinics.
-- Stores references (case id, message id), never message text or phone numbers.
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id     INTEGER REFERENCES staff(id) ON DELETE SET NULL,
  staff_login  TEXT,                 -- kept even if the account is later removed
  action       TEXT NOT NULL,        -- e.g. login.success, case.view, case.reply
  target_type  TEXT,                 -- case | staff | clinic | pass | content | message
  target_id    TEXT,
  details      JSONB NOT NULL DEFAULT '{}',
  ip           TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_staff ON audit_log(staff_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_log(target_type, target_id);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  -- Allow only the FK's ON DELETE SET NULL on staff_id; anything else is tampering.
  IF TG_OP = 'UPDATE'
     AND NEW.staff_id IS NULL AND OLD.staff_id IS NOT NULL
     AND NEW.at = OLD.at AND NEW.action = OLD.action
     AND NEW.staff_login IS NOT DISTINCT FROM OLD.staff_login
     AND NEW.target_type IS NOT DISTINCT FROM OLD.target_type
     AND NEW.target_id IS NOT DISTINCT FROM OLD.target_id
     AND NEW.details = OLD.details
     AND NEW.ip IS NOT DISTINCT FROM OLD.ip THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ---- Background jobs (Postgres-backed queue) ----
CREATE TABLE IF NOT EXISTS jobs (
  id            BIGSERIAL PRIMARY KEY,
  type          TEXT NOT NULL,                       -- checkin.send | checkins.sweep | alert.send | outbox.retry
  payload       JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued',      -- queued | running | done | dead
  run_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 8,
  unique_key    TEXT,                                -- at most one queued/running job per key
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(run_at, id) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS idx_jobs_running ON jobs(locked_at) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_unique_active ON jobs(unique_key) WHERE unique_key IS NOT NULL AND status IN ('queued', 'running');
