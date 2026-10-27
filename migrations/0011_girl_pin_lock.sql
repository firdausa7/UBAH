-- The PIN lock: a girl's session locks after a few minutes without her using it (phones are shared).
-- Until she enters her PIN, nothing of hers is sent to the phone.
ALTER TABLE girl_sessions ADD COLUMN IF NOT EXISTS unlocked_until TIMESTAMPTZ;
