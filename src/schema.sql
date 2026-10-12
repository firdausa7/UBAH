-- Ubah database schema (PostgreSQL).
-- Privacy rule: no table stores a girl's name, and phone numbers are only stored hashed + encrypted.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  anon_id       TEXT UNIQUE NOT NULL,          -- short public ID shown to staff, e.g. "A19F"
  phone_hash    TEXT UNIQUE NOT NULL,          -- HMAC of the phone number, used to recognise her
  phone_enc     TEXT NOT NULL,                 -- encrypted number, only decrypted to send her messages
  channel       TEXT NOT NULL,                 -- whatsapp | sms | simulator
  language      TEXT,                          -- so | sw | en | om
  state         JSONB NOT NULL DEFAULT '{}',   -- conversation state
  opted_out     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction     TEXT NOT NULL,                 -- in | out
  channel       TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'text',  -- text | voice
  body          TEXT NOT NULL,
  topic         TEXT,                          -- predicted topic (incoming only)
  danger        TEXT,                          -- predicted danger label (incoming only)
  coded_terms   TEXT[] NOT NULL DEFAULT '{}',  -- glossary terms found
  content_id    TEXT,                          -- approved content used for the answer (outgoing)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinics (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  area          TEXT NOT NULL,
  services      TEXT[] NOT NULL,               -- pregnancy_test, family_planning, period_care, sti, counselling, safety
  hours         TEXT NOT NULL,
  free          BOOLEAN NOT NULL DEFAULT TRUE,
  notes         TEXT NOT NULL DEFAULT '',
  verified      BOOLEAN NOT NULL DEFAULT FALSE,
  mfl_code      TEXT,                          -- Kenya Master Facility List code, when known
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- A pass is portable: valid at ANY partner clinic offering its services.
CREATE TABLE IF NOT EXISTS passes (
  code              TEXT PRIMARY KEY,          -- e.g. UB-7K42
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  services          TEXT[] NOT NULL,
  suggested_clinic  INTEGER REFERENCES clinics(id),
  urgent            BOOLEAN NOT NULL DEFAULT FALSE,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  redeemed_at       TIMESTAMPTZ,
  redeemed_clinic   INTEGER REFERENCES clinics(id)
);

-- The day-3 follow-up that closes the loop.
CREATE TABLE IF NOT EXISTS checkins (
  id            SERIAL PRIMARY KEY,
  pass_code     TEXT NOT NULL REFERENCES passes(code) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  due_at        TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  visited       BOOLEAN,
  clinic_id     INTEGER REFERENCES clinics(id), -- clinic she says she went to
  respect       TEXT,                           -- yes | partly | no
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS staff (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,                 -- admin | nurse | dada | clinic | partner
  login         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  clinic_id     INTEGER REFERENCES clinics(id),
  phone         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- Human handoffs: danger signs, safety concerns, or "talk to a Dada".
CREATE TABLE IF NOT EXISTS cases (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason        TEXT NOT NULL,                 -- danger_medical | danger_safety | danger_selfharm | asked_for_person
  urgent        BOOLEAN NOT NULL,
  summary       TEXT NOT NULL,
  draft_reply   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'open',  -- open | handled
  assigned_to   INTEGER REFERENCES staff(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_reply_at TIMESTAMPTZ,
  handled_at    TIMESTAMPTZ
);

-- Dada payment log (paid out through M-Pesa B2C after the pilot is approved).
CREATE TABLE IF NOT EXISTS dada_payouts (
  id            SERIAL PRIMARY KEY,
  staff_id      INTEGER NOT NULL REFERENCES staff(id),
  case_id       INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  amount_kes    INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | paid
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human labels on anonymous messages: the training data for Ubah's own models.
CREATE TABLE IF NOT EXISTS labels (
  id            SERIAL PRIMARY KEY,
  message_id    INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  task          TEXT NOT NULL,                 -- danger | topic
  label         TEXT NOT NULL,
  labeled_by    INTEGER NOT NULL REFERENCES staff(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (message_id, task, labeled_by)
);

-- Outbox: every message Ubah sends (also lets the simulator and tests read replies).
CREATE TABLE IF NOT EXISTS outbox (
  id            SERIAL PRIMARY KEY,
  channel       TEXT NOT NULL,
  to_hash       TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'sent',  -- sent | failed | mock
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_due ON checkins(due_at) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
