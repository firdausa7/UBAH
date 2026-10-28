-- When a girl's app showed her a reply (web/app only; WhatsApp and SMS report their own delivery).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;
