# Ubah

**A voice-first Somali health companion for refugee and pastoralist girls in northern Kenya — one that doesn't just refer girls to care, but checks they actually got it, with dignity.**

Girls ask questions privately on WhatsApp or SMS, by text or voice note. Ubah answers only from health-partner-approved content, sends danger signs to a trained human at once, issues an anonymous referral pass that works at any partner clinic, and three days later asks whether she was seen and treated with respect. Those anonymous answers become a dignity score for each clinic.

This repository started as the **functional prototype** for the UNICEF Femtech Ventures application and is being hardened for a real pilot, phase by phase (see [Roadmap](#roadmap-to-a-pilot)).

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
| Two-step staff login, lockout, CSRF protection, append-only audit log | `src/web/login.ts`, `src/security/`, `src/audit.ts` |
| Durable background jobs: check-ins, retries of failed messages and nurse alerts | `src/jobs/` |

## Run it locally (no accounts needed)

Requires Node.js 22.12 or newer.

```bash
npm install
npm run train      # trains the starter models from data/seed
npm run dev        # http://localhost:3000
```

- **Simulator** (chat as a girl): http://localhost:3000/simulator
- **Staff login**: http://localhost:3000/staff/login — logins `admin`, `nurse`, `dada`, `clinic-a`, `partner`; password `change-me-now` (set `DEMO_STAFF_PASSWORD` to change it)

With no keys set, everything runs in **mock mode**: answers come straight from the approved content, voice notes use the simulator's typed text, and messages are logged instead of sent. The database is embedded Postgres (PGlite) in `./.data`. Settings are read from `.env` if it exists (copy `.env.example`).

**Two-step login is on by default, also locally:**

- `admin`, `nurse` and `partner` set up an authenticator app (Aegis, FreeOTP, Google Authenticator…) the first time they log in, by scanning a QR code. They get 8 one-time recovery codes.
- `dada` gets a 6-digit SMS code. In mock mode the code appears in the server log (`[sms:mock] Ubah login code: …`).
- `clinic-a` (the clinic desk) uses a password only: it sees the services on a pass, never who the girl is.
- For a quick local demo only, set `MFA_REQUIRED=false` in `.env`. Production refuses to start with it off.

Try in the simulator: `hi` → `3` → `my period is two weeks late` → `1` → **Skip 3 days** → `1` → `1` → `2`. Then log in as `admin` and open the dashboard.

## Run it in production

Production (`NODE_ENV=production`) refuses to start until every safety- and privacy-critical setting is in place, and lists everything that is missing: real secrets, `ALLOW_DRAFT_CONTENT=false`, a Postgres `DATABASE_URL`, an `https://` `BASE_URL`, at least one `NURSE_ALERT_NUMBERS` entry (danger signs must reach a human), a live Africa's Talking key (nurse alerts and Dada login codes are SMS), two-step login on, no demo data, and webhook secrets for every channel that is switched on.

### With Docker on one server

```bash
cp .env.example .env              # fill it in; also set POSTGRES_PASSWORD
docker compose up -d --build      # app + Postgres 16; migrations run on start
docker compose exec app node --import tsx src/createAdmin.ts --login amina --name "Amina Hassan"
```

`create-admin` prints a one-time password. The new admin must choose their own password and set up two-step login at first login. The app listens on `127.0.0.1:3000`: put a TLS reverse proxy (Caddy, nginx or a cloud load balancer) in front and set `TRUST_PROXY=1`.

### Without Docker

```bash
npm ci --omit=dev
npm run migrate                   # or let the app apply them at start
npm run create-admin -- --login amina --name "Amina Hassan"
npm start
```

### Connect real channels

1. **WhatsApp Cloud API** (Meta): set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, and point the webhook to `https://<your-host>/webhooks/whatsapp` with your `WHATSAPP_VERIFY_TOKEN`.
2. **Africa's Talking SMS**: set `AT_USERNAME`, `AT_API_KEY` (and a sender ID or shortcode), and set the inbound callback to `https://<your-host>/webhooks/sms?key=<SMS_WEBHOOK_KEY>`.
3. **AI**: any OpenAI-compatible API — `LLM_API_KEY` for OpenAI, or `LLM_BASE_URL` pointing at an open-weight model on vLLM or Ollama.
4. **Speech-to-text**: `STT_API_KEY` (Whisper), or `STT_BASE_URL` for a self-hosted Whisper / Meta MMS model fine-tuned on Somali.
5. **Nurse alerts**: `NURSE_ALERT_NUMBERS`.

## How it is built

- **Database migrations** — numbered files in `migrations/` (`0001_initial.sql`, `0002_…`). Each runs once, in its own transaction, under a Postgres advisory lock, so two instances starting together are safe. Applied files are checksummed: editing one stops the app; add a new numbered file instead. `npm run migrate -- --status` lists them.
- **Configuration** — every environment variable is validated with zod at startup (`src/config.ts`), with one clear message per problem.
- **Staff security** — sessions are stored server-side (only a hash of the token), so log-out, deactivation and password changes take effect immediately. Every staff form carries a CSRF token. Login and two-step codes are rate-limited; 5 wrong passwords or codes lock an account for 15 minutes. Passwords need 12+ characters. Security headers (strict Content-Security-Policy, no framing, HSTS in production), request size limits, and `Cache-Control: no-store` on every staff page (phones are often shared).
- **Audit log** — `/staff/audit` (admins) shows every login, case view, reply sent (by message id), pass check, label and admin action. The table is append-only (a database trigger refuses edits and deletes) and never stores message text or phone numbers.
- **Background jobs** — a Postgres-backed queue (`src/jobs/`) with retries, backoff, crash recovery and de-duplication. Each referral schedules its own day-3 check-in; a sweep every 15 minutes catches anything missed; failed messages to girls and failed nurse alerts are retried until delivered (nurse alerts up to 20 times). Several app instances can share the queue.
- **Operations** — JSON logs (one line per event; no message text, phone numbers, cookies or keys), `X-Request-Id` on every response, `GET /health` (checks the database; 503 while down or shutting down) and `GET /health/live`. On `SIGTERM` the app stops taking requests, finishes in-flight work and the current job, then closes the database.

## Training Ubah's models

```bash
npm run train                # seed data + data/labeled/*.jsonl
npm run train -- --export    # first export nurse/Dada labels from the database
```

Each run writes `models/<task>.json` and `models/<task>.report.json` (5-fold cross-validated precision and recall per class). **Seed-only results prove the pipeline works; they are not evidence of real-world accuracy.** Report numbers from labelled pilot data. `data/labeled/` is git-ignored because it contains real (anonymous) messages.

## Tests

```bash
npm run check      # lint + typecheck + all tests
npm test           # tests on embedded Postgres (PGlite)
TEST_DATABASE_URL=postgres://user@localhost:5432/ubah_test npm test   # the same tests on a real Postgres server
```

Covers the full loop (question → answer → pass → check-in → dignity score), danger handoffs, coded words, voice notes, STOP/DELETE, the webhooks and their authentication, every staff page and role, two-step login, lockout, CSRF, sessions, the audit log, migrations, config validation, the job queue and retries, health checks and graceful shutdown. A route inventory test fails if a route is added without being listed and tested, or if any form lacks a CSRF token.

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on both PGlite and Postgres 16, and builds the Docker image.

## Before a pilot — must do

- [ ] Health partner reviews every file in `content/topics/` and sets `status: approved`; verify the hotline numbers.
- [ ] Native speakers translate `src/i18n.ts` and the content into Somali, Kiswahili and Afaan Oromoo (add `<id>.so.md` files); test with girls.
- [ ] Collect real coded words for `data/glossary.json` in community sessions.
- [ ] Replace the demo clinics in `src/seed.ts` with verified partner clinics (with Kenya Master Facility List codes).
- [ ] Ethics approval; testing starts with young women aged 18+.
- [ ] Data protection impact assessment (Kenya Data Protection Act 2019).
- [ ] Generate production secrets (`openssl rand -hex 32` for each), create the first admin with `npm run create-admin`, and give every staff member their own account.
- [ ] Agree safeguarding and referral pathways with health and protection partners.

## Roadmap to a pilot

- [x] **Phase 1 — Production foundations**: migrations, validated config, CSRF, rate limits, lockout, security headers, two-step login (TOTP and SMS), audit log, structured logs, health checks, graceful shutdown, Postgres job queue, Docker and CI.
- [ ] **Phase 2 — Staff platform**: admin (staff, clinics), content, translation and glossary studios with review workflow, full inbox, protection pathway, clinic desk, dashboard exports, Dada payments.
- [ ] **Phase 3 — Channels, AI and machine learning**: WhatsApp interactive menus and templates, SMS delivery reports, USSD, voice answers, multilingual retrieval, model registry.
- [ ] **Phase 4 — Girl-facing app**: offline-capable PWA.
- [ ] **Phase 5 — Pilot readiness**: end-to-end and load tests, deployment guide, DPIA, privacy notice and safeguarding drafts, demo mode.

## Licences

- Code: Apache License 2.0 (add the full licence text with GitHub's "Add file → LICENSE" template).
- Health content (`content/`), glossary and evaluation data (`data/`): Creative Commons Attribution 4.0 (CC BY 4.0).

## Author

Created by Firdausa Salat, HPI-SOLUTIONS KE LIMITED, Nairobi, Kenya.
