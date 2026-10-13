-- Phase 5: urgent-case reminders and demo data markers.

-- An urgent case nobody has answered re-alerts the nurses every 15 minutes.
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS reminders        INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_cases_unanswered ON cases(created_at) WHERE urgent AND status = 'open' AND first_reply_at IS NULL;

-- Demo data (npm run demo) is marked so it is always labelled and can be removed completely.
ALTER TABLE users   ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE sites   ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE staff   ADD COLUMN IF NOT EXISTS demo BOOLEAN NOT NULL DEFAULT FALSE;
