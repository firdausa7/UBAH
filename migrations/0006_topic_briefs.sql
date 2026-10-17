-- Topic briefs: what a topic should cover, written for the health partner who writes it.
-- A brief is guidance for writers only. It is never sent to girls.
ALTER TABLE content_topics ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT '';

-- Empty topic slots requested by the Ubah team (DRAFT briefs). They have no text, so girls see nothing
-- until a health or protection partner writes the answer and a reviewer approves it.
INSERT INTO content_topics (id, category, services, brief) VALUES
  ('pcos', 'conditions', '{period_care}',
   'DRAFT brief, for the health partner to write. Questions to answer in simple words: What is PCOS? Which signs (for example periods that are very irregular or stop) mean a girl should visit a clinic? What can a clinic do for her? Reassure her that she can ask a nurse privately. Sources: name the WHO or Kenya MoH guidance you use.'),
  ('endometriosis', 'conditions', '{period_care}',
   'DRAFT brief, for the health partner to write. Questions to answer in simple words: When is period pain NOT normal (for example pain that stops her going to school)? What is endometriosis? When should she visit a clinic, and what can a clinic do? She should never be told the pain is in her head. Sources: name the WHO or Kenya MoH guidance you use.'),
  ('fgm-support', 'fgm', '{counselling,safety}',
   'DRAFT brief, to be written WITH a protection partner. For girls who have been cut: it is not her fault; which health problems should make her visit a clinic, and what a clinic can do; where she can get care and counselling; her rights under Kenyan law. Never shame her or her family. Every helpline or contact must be verified by the protection partner before it is published.'),
  ('gbv-help', 'safety', '{safety,counselling}',
   'DRAFT brief, to be written WITH a protection partner. Gender-based violence: it is never her fault; what to do after violence, and how soon she should go to a clinic; her rights; how Ubah can connect her to a Dada or nurse privately; where to get help. Every helpline number must be entered and verified by the protection partner before it is published.')
ON CONFLICT (id) DO NOTHING;
