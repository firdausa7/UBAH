# Ubah

**A voice-first Somali health companion for refugee and pastoralist girls in northern Kenya — one that doesn't just refer girls to care, but checks they actually got it, with dignity.**

Girls ask questions privately on WhatsApp or SMS, by text or voice note. Ubah answers only from health-partner-approved content, sends danger signs to a trained human at once, issues an anonymous referral pass that works at any partner clinic, and three days later asks whether she was seen and treated with respect. Those anonymous answers become a dignity score for each clinic.

This repository is the **functional prototype** for the UNICEF Femtech Ventures application.

## What makes it different

| Feature | Where in the code |
|---|---|
| Voice notes in Somali (speech-to-text, pluggable model) | `src/ai/stt.ts` |
| Answers grounded only in approved content — "I don't know" instead of guessing | `src/ai/llm.ts`, `src/content/`, `content/topics/` |
| Coded-word glossary ("monthly visitor", "down there") | `data/glossary.json`, `src/ml/glossary.ts` |
| Ubah's own trained models: danger-sign and topic classifiers, with honest accuracy reports | `src/ml/` |
| Safety rules that always send self-harm, violence and medical emergencies to a human | `src/ml/models.ts` |
| Portable referral pass, valid at any partner clinic | `src/referrals.ts` |
| Day-3 check-in → clinic dignity score (hidden below 5 answers to protect privacy) | `src/engine.ts`, `src/stats.ts` |
| Dada and nurse inbox, AI-drafted replies a human always approves | `src/web/staff.ts` |
| Labelling tool: nurses and Dadas create the training data | `/staff/label` |
| Dada payment log, ready for M-Pesa payouts | `dada_payouts` table |
| No names stored; phone numbers hashed + encrypted; STOP and DELETE commands | `src/privacy.ts`, `src/engine.ts` |

## Run it locally (no accounts needed)

Requires Node.js 20+.

```bash
npm install
npm run train      # trains the starter models from data/seed
npm run dev        # http://localhost:3000
```

- **Simulator** (chat as a girl): http://localhost:3000/simulator
- **Staff login**: http://localhost:3000/staff/login — logins `admin`, `nurse`, `dada`, `clinic-a`, `partner`; password `change-me-now` (set `DEMO_STAFF_PASSWORD` to change it)

With no keys set, everything runs in **mock mode**: answers come straight from the approved content, voice notes use the simulator's typed text, and messages are logged instead of sent. The database is embedded Postgres (PGlite) in `./.data`.

Try in the simulator: `hi` → `3` → `my period is two weeks late` → `1` → **Skip 3 days** → `1` → `1` → `2`. Then log in as `admin` and open the dashboard.

## Connect real channels

Copy `.env.example` to `.env` and fill in:

1. **WhatsApp Cloud API** (Meta): set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and point the webhook to `https://<your-host>/webhooks/whatsapp` with your `WHATSAPP_VERIFY_TOKEN`.
2. **Africa's Talking SMS**: set `AT_USERNAME`, `AT_API_KEY` (and a sender ID or shortcode), and set the inbound callback to `https://<your-host>/webhooks/sms?key=<SMS_WEBHOOK_KEY>`.
3. **AI**: any OpenAI-compatible API — `LLM_API_KEY` for OpenAI, or `LLM_BASE_URL` pointing at an open-weight model on vLLM or Ollama.
4. **Speech-to-text**: `STT_API_KEY` (Whisper), or `STT_BASE_URL` for a self-hosted Whisper / Meta MMS model fine-tuned on Somali.
5. **Database**: `DATABASE_URL` for real Postgres.
6. **Nurse alerts**: `NURSE_ALERT_NUMBERS`.

In production (`NODE_ENV=production`) Ubah refuses to start until the privacy secrets are set and `ALLOW_DRAFT_CONTENT=false`.

## Training Ubah's models

```bash
npm run train                # seed data + data/labeled/*.jsonl
npm run train -- --export    # first export nurse/Dada labels from the database
```

Each run writes `models/<task>.json` and `models/<task>.report.json` (5-fold cross-validated precision and recall per class). **Seed-only results prove the pipeline works; they are not evidence of real-world accuracy.** Report numbers from labelled pilot data. `data/labeled/` is git-ignored because it contains real (anonymous) messages.

## Before a pilot — must do

- [ ] Health partner reviews every file in `content/topics/` and sets `status: approved`; verify the hotline numbers.
- [ ] Native speakers translate `src/i18n.ts` and the content into Somali, Kiswahili and Afaan Oromoo (add `<id>.so.md` files); test with girls.
- [ ] Collect real coded words for `data/glossary.json` in community sessions.
- [ ] Replace the demo clinics in `src/seed.ts` with verified partner clinics (with Kenya Master Facility List codes).
- [ ] Ethics approval; testing starts with young women aged 18+.
- [ ] Data protection impact assessment (Kenya Data Protection Act 2019); set strong secrets; change all staff passwords.
- [ ] Agree safeguarding and referral pathways with health and protection partners.

## Tests

```bash
npm test
```

Covers the full loop (question → answer → pass → check-in → dignity score), danger handoffs, coded words, voice notes, STOP/DELETE, the webhooks, staff roles, clinic pass checks, the dashboard, labelling, and the simulator.

## Licences

- Code: Apache License 2.0 (add the full licence text with GitHub's "Add file → LICENSE" template).
- Health content (`content/`), glossary and evaluation data (`data/`): Creative Commons Attribution 4.0 (CC BY 4.0).

## Author

Created by Firdausa Salat, HPI-SOLUTIONS KE LIMITED, Nairobi, Kenya.
