-- Wrong PINs are counted per phone number, whether or not it has an account, so the lockout can't
-- reveal which numbers use Ubah. (Replaces users.pin_failures / pin_locked_until, now unused.)
CREATE TABLE IF NOT EXISTS pin_attempts (
  phone_hash    TEXT PRIMARY KEY,
  failures      INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
