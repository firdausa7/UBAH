-- An empty topic slot (DRAFT brief) for what a normal period is. Girls ask it often ("How long should my
-- period last?", "Is it normal to bleed for 10 days?") and no topic answers it, so those questions were
-- matched to a nearby topic. It has no text: girls see nothing from it until a health partner writes
-- the answer and a reviewer approves it.
INSERT INTO content_topics (id, category, services, brief) VALUES
  ('periods-normal', 'periods', '{period_care}',
   'DRAFT brief, for the health partner to write. Questions girls ask, to answer in simple words: How often does a period come, and is it normal if it is not regular in the first years? How many days does bleeding usually last? How much bleeding is normal, and how can she tell if it is too much? Which signs mean she should see a nurse (for example bleeding for many days, or very heavy bleeding)? Reassure her that periods differ from girl to girl and that she can ask a nurse privately. Sources: name the WHO or Kenya MoH guidance you use.')
ON CONFLICT (id) DO NOTHING;
