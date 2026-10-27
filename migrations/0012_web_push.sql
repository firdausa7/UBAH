-- Web push for the girls' space (/me): only the browser's push address is kept, so Ubah can say
-- "new message" without sending the message itself through Google's or Apple's push service.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_push_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
