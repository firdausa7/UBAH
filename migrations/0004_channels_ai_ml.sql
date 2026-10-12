-- Phase 3: channels (WhatsApp window, delivery status, durable inbound), location, voice, model registry.

-- WhatsApp's 24-hour customer-service window is counted from her last WhatsApp message.
ALTER TABLE users ADD COLUMN IF NOT EXISTS wa_last_inbound_at TIMESTAMPTZ;
-- The area or landmark she named (never coordinates).
ALTER TABLE users ADD COLUMN IF NOT EXISTS area TEXT;

-- Delivery tracking.
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS provider_id   TEXT;           -- WhatsApp wamid / Africa's Talking messageId
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS via           TEXT;           -- text | interactive | template | audio | sms
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS delivered_at  TIMESTAMPTZ;
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS read_at       TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_outbox_provider ON outbox(provider_id) WHERE provider_id IS NOT NULL;

-- Messages held while her WhatsApp window is closed; sent as soon as she writes again.
CREATE TABLE IF NOT EXISTS pending_outbound (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  content_id     TEXT,
  sent_by_staff  INTEGER REFERENCES staff(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pending_user ON pending_outbound(user_id);

-- Every inbound webhook message is recorded first (encrypted), so a duplicate delivery is ignored
-- and a crash mid-way is recovered. The row is emptied once handled.
CREATE TABLE IF NOT EXISTS inbound_messages (
  id            BIGSERIAL PRIMARY KEY,
  provider      TEXT NOT NULL,                 -- whatsapp | sms
  provider_id   TEXT NOT NULL,
  payload_enc   TEXT,                          -- encrypted until processed, then NULL
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  UNIQUE (provider, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_unprocessed ON inbound_messages(received_at) WHERE processed_at IS NULL;

-- Recorded voice answers uploaded to WhatsApp (their media ids expire after 30 days).
ALTER TABLE media ADD COLUMN IF NOT EXISTS wa_media_id          TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS wa_media_uploaded_at TIMESTAMPTZ;

-- Which approved version an answer came from (the citation).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS content_version_id INTEGER REFERENCES content_versions(id);

-- Clinic location, for "nearest clinic".
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS lat        DOUBLE PRECISION;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS lng        DOUBLE PRECISION;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS landmarks  TEXT[] NOT NULL DEFAULT '{}';

-- Model registry: every trained model, its evaluation, and which one is live.
CREATE TABLE IF NOT EXISTS model_versions (
  id           SERIAL PRIMARY KEY,
  task         TEXT NOT NULL,                  -- danger | topic
  version      INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'candidate', -- candidate | active | retired | rejected
  model        JSONB NOT NULL,
  report       JSONB NOT NULL,
  examples     INTEGER NOT NULL,
  sources      JSONB NOT NULL DEFAULT '{}',
  trained_by   INTEGER REFERENCES staff(id),
  trained_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  promoted_by  INTEGER REFERENCES staff(id),
  promoted_at  TIMESTAMPTZ,
  notes        TEXT NOT NULL DEFAULT '',
  UNIQUE (task, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_model_one_active ON model_versions(task) WHERE status = 'active';
