-- Phase 2: staff platform (admin, sites and protection, content/translation/glossary studios,
-- richer inbox, clinic desk by SMS/USSD, Dada payments).

-- ---- Sites (camps, counties) ----
CREATE TABLE IF NOT EXISTS sites (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  county      TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE clinics ADD COLUMN IF NOT EXISTS site_id    INTEGER REFERENCES sites(id);
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
-- A girl's site, once she shares her area (Phase 3). Never more precise than a site.
ALTER TABLE users   ADD COLUMN IF NOT EXISTS site_id    INTEGER REFERENCES sites(id);

-- ---- Staff ----
ALTER TABLE staff ADD COLUMN IF NOT EXISTS title          TEXT NOT NULL DEFAULT '';  -- e.g. "Clinical officer"; shown on approvals
ALTER TABLE staff ADD COLUMN IF NOT EXISTS organisation   TEXT NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS languages      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE staff ADD COLUMN IF NOT EXISTS site_id        INTEGER REFERENCES sites(id);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS desk_pin_hash  TEXT;                      -- clinic desk PIN for SMS/USSD pass checks
ALTER TABLE staff ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

-- One-time links to set a password (new account) or reset it. Only a hash is stored.
CREATE TABLE IF NOT EXISTS staff_tokens (
  token_hash  TEXT PRIMARY KEY,
  staff_id    INTEGER NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                 -- invite | reset
  created_by  INTEGER REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

-- ---- Protection pathway (per site) ----
CREATE TABLE IF NOT EXISTS protection_steps (
  id          SERIAL PRIMARY KEY,
  site_id     INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL,
  details     TEXT NOT NULL DEFAULT '',
  active      BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS protection_contacts (
  id            SERIAL PRIMARY KEY,
  site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  organisation  TEXT NOT NULL DEFAULT '',
  service       TEXT NOT NULL DEFAULT '',     -- e.g. GBV case management, police gender desk, safe shelter
  phone         TEXT NOT NULL DEFAULT '',
  hours         TEXT NOT NULL DEFAULT '',
  notes         TEXT NOT NULL DEFAULT '',
  verified      BOOLEAN NOT NULL DEFAULT FALSE, -- confirmed with the organisation by a named staff member
  verified_by   INTEGER REFERENCES staff(id),
  verified_at   TIMESTAMPTZ,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---- Cases ----
ALTER TABLE cases ADD COLUMN IF NOT EXISTS level        TEXT NOT NULL DEFAULT 'dada';  -- dada | nurse
ALTER TABLE cases ADD COLUMN IF NOT EXISTS site_id      INTEGER REFERENCES sites(id);
ALTER TABLE cases ADD COLUMN IF NOT EXISTS assigned_at  TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS escalated_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS escalated_by INTEGER REFERENCES staff(id);
UPDATE cases SET level = 'nurse' WHERE reason = 'danger_medical' AND level = 'dada';
CREATE INDEX IF NOT EXISTS idx_cases_open ON cases(status, urgent DESC, created_at);

CREATE TABLE IF NOT EXISTS case_notes (
  id          SERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  staff_id    INTEGER NOT NULL REFERENCES staff(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS case_events (
  id          BIGSERIAL PRIMARY KEY,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  staff_id    INTEGER REFERENCES staff(id),
  kind        TEXT NOT NULL,                 -- opened | claimed | assigned | unassigned | note | reply | escalated | handled | reopened | site | step
  details     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_case_events_case ON case_events(case_id, at);
CREATE TABLE IF NOT EXISTS case_protection (
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  step_id     INTEGER NOT NULL REFERENCES protection_steps(id) ON DELETE CASCADE,
  done_by     INTEGER NOT NULL REFERENCES staff(id),
  done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, step_id)
);

-- ---- Uploaded media (recorded voice answers) ----
CREATE TABLE IF NOT EXISTS media (
  id           SERIAL PRIMARY KEY,
  mime         TEXT NOT NULL,
  bytes        BYTEA NOT NULL,
  size         INTEGER NOT NULL,
  sha256       TEXT NOT NULL,
  filename     TEXT NOT NULL DEFAULT '',
  uploaded_by  INTEGER REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Content studio ----
-- A topic has one version history per language. Status: draft -> in_review -> approved -> published (-> archived).
CREATE TABLE IF NOT EXISTS content_topics (
  id          TEXT PRIMARY KEY,               -- slug, e.g. periods-pain
  category    TEXT NOT NULL,                  -- periods | pregnancy | family_planning | sti | safety | body | feelings
  services    TEXT[] NOT NULL DEFAULT '{}',
  archived    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by  INTEGER REFERENCES staff(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS content_versions (
  id              SERIAL PRIMARY KEY,
  topic_id        TEXT NOT NULL REFERENCES content_topics(id) ON DELETE CASCADE,
  language        TEXT NOT NULL,
  version         INTEGER NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  keywords        TEXT[] NOT NULL DEFAULT '{}',
  sources         TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'draft',
  audio_media_id  INTEGER REFERENCES media(id),
  author_id       INTEGER REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  reviewed_by     INTEGER REFERENCES staff(id),
  reviewer_name   TEXT,                         -- name + title at the time of approval
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT NOT NULL DEFAULT '',
  published_by    INTEGER REFERENCES staff(id),
  published_at    TIMESTAMPTZ,
  UNIQUE (topic_id, language, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_one_published ON content_versions(topic_id, language) WHERE status = 'published';

-- ---- Translation studio (every string Ubah sends outside the health content) ----
CREATE TABLE IF NOT EXISTS string_versions (
  id              SERIAL PRIMARY KEY,
  key             TEXT NOT NULL,
  language        TEXT NOT NULL,
  version         INTEGER NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  author_id       INTEGER REFERENCES staff(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at    TIMESTAMPTZ,
  reviewed_by     INTEGER REFERENCES staff(id),
  reviewer_name   TEXT,
  reviewed_at     TIMESTAMPTZ,
  review_note     TEXT NOT NULL DEFAULT '',
  published_by    INTEGER REFERENCES staff(id),
  published_at    TIMESTAMPTZ,
  UNIQUE (key, language, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_strings_one_published ON string_versions(key, language) WHERE status = 'published';

-- ---- Glossary studio (coded words) ----
CREATE TABLE IF NOT EXISTS glossary_terms (
  id           SERIAL PRIMARY KEY,
  term         TEXT NOT NULL,
  language     TEXT NOT NULL,
  means        TEXT NOT NULL,
  topic        TEXT NOT NULL,
  notes        TEXT NOT NULL DEFAULT '',
  verified     BOOLEAN NOT NULL DEFAULT FALSE,
  verified_by  INTEGER REFERENCES staff(id),
  verified_at  TIMESTAMPTZ,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   INTEGER REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_glossary_term ON glossary_terms(lower(term), language);

-- ---- Dada payments (M-Pesa B2C) ----
CREATE TABLE IF NOT EXISTS payout_batches (
  id           SERIAL PRIMARY KEY,
  created_by   INTEGER NOT NULL REFERENCES staff(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_by      INTEGER REFERENCES staff(id),
  pay_started_at TIMESTAMPTZ,
  total_kes    INTEGER NOT NULL,
  payouts      INTEGER NOT NULL
);
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS batch_id        INTEGER REFERENCES payout_batches(id);
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS reason          TEXT NOT NULL DEFAULT 'case';
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS approved_by     INTEGER REFERENCES staff(id);
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ;
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS request_id      TEXT;          -- our OriginatorConversationID
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS conversation_id TEXT;          -- M-Pesa ConversationID
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS receipt         TEXT;          -- M-Pesa TransactionID
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS result_code     TEXT;
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS result_desc     TEXT;
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS sent_at         TIMESTAMPTZ;
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS paid_at         TIMESTAMPTZ;
ALTER TABLE dada_payouts ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE dada_payouts ALTER COLUMN case_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_request ON dada_payouts(request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_case ON dada_payouts(case_id) WHERE case_id IS NOT NULL;

-- Every M-Pesa callback, kept as received for reconciliation.
CREATE TABLE IF NOT EXISTS mpesa_callbacks (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind         TEXT NOT NULL,                 -- result | timeout
  request_id   TEXT,
  payload      JSONB NOT NULL
);
