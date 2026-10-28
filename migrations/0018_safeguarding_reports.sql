-- Confidential reports (harassment, abuse, exploitation, online harm), kept apart from ordinary
-- support messages and cases. Only protection officers can open them (see src/safeguarding.ts).
-- Her words and staff notes are encrypted. Deleted with her account (her choice wins; the protection
-- partner decides whether that must change).
CREATE TABLE IF NOT EXISTS safeguarding_reports (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category         TEXT NOT NULL CHECK (category IN ('harassment', 'abuse', 'exploitation', 'online', 'other')),
  in_danger        BOOLEAN NOT NULL DEFAULT FALSE,
  who              TEXT CHECK (who IN ('family', 'partner', 'school', 'stranger', 'online', 'other', 'not_said')),
  happened         TEXT CHECK (happened IN ('now', 'days', 'weeks', 'longer', 'not_said')),
  description_enc  TEXT,
  contact_ok       BOOLEAN NOT NULL DEFAULT FALSE,
  priority_hint    TEXT NOT NULL DEFAULT 'normal' CHECK (priority_hint IN ('high', 'normal')), -- a suggestion, never a decision
  status           TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'in_review', 'referred', 'follow_up', 'closed')),
  assigned_to      INTEGER REFERENCES staff(id),
  follow_up_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sg_queue ON safeguarding_reports(status, in_danger DESC, created_at);
CREATE INDEX IF NOT EXISTS idx_sg_user ON safeguarding_reports(user_id);

-- Every step on a report: created, status changes (with a note), notes, referrals, messages to her.
CREATE TABLE IF NOT EXISTS safeguarding_events (
  id           SERIAL PRIMARY KEY,
  report_id    INTEGER NOT NULL REFERENCES safeguarding_reports(id) ON DELETE CASCADE,
  staff_id     INTEGER REFERENCES staff(id),
  kind         TEXT NOT NULL CHECK (kind IN ('created', 'status', 'note', 'referral', 'message', 'assigned')),
  from_status  TEXT,
  to_status    TEXT,
  note_enc     TEXT,
  contact_id   INTEGER REFERENCES protection_contacts(id),
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sg_events ON safeguarding_events(report_id, id);
