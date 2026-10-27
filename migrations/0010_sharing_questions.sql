-- When a girl on WhatsApp or SMS was asked what her health worker may see (asked once each).
-- Her answers are in consents; no answer leaves her messages and voice private.
ALTER TABLE users ADD COLUMN IF NOT EXISTS share_asked_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS voice_asked_at TIMESTAMPTZ;
