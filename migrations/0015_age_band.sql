-- Her age band, only if she chooses to say (no date of birth). Under 18: her worker follows the
-- child-safeguarding procedure. under_15 | 15_17 | 18_plus | not_said
ALTER TABLE users ADD COLUMN IF NOT EXISTS age_band TEXT CHECK (age_band IN ('under_15', '15_17', '18_plus', 'not_said'));
