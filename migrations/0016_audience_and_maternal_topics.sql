-- Who may receive a topic's answer: everyone, or only girls who said they are 18 or older.
-- Set by the content team and reviewers per topic; everything stays "all" until they decide.
ALTER TABLE content_topics ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'adults'));

-- Empty topic slots for maternal and postnatal health (DRAFT briefs). They have no text, so girls see
-- nothing until a health partner writes the answer and a reviewer approves it.
INSERT INTO content_topics (id, category, services, brief) VALUES
  ('antenatal-care', 'pregnancy', '{antenatal,pregnancy_test}',
   'DRAFT brief, for the health partner to write. In simple words: why check-ups during pregnancy matter and when to start; how many visits and what happens at them; that they are free at partner clinics; which signs mean she should go to a clinic the same day (link to pregnancy danger signs). Kind and non-judgemental, also for very young mothers. Sources: name the WHO or Kenya MoH guidance you use.'),
  ('postnatal-care', 'pregnancy', '{antenatal,family_planning,counselling}',
   'DRAFT brief, for the health partner to write. In simple words, for after the birth: danger signs for the mother and the baby that need a clinic at once; check-ups after birth and for the baby; feeding the baby; feelings after birth and where to get support; family planning after birth. Sources: name the WHO or Kenya MoH guidance you use.')
ON CONFLICT (id) DO NOTHING;
