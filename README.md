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
| Content, translation and glossary studios: nothing reaches girls until a named health-partner reviewer approves it and it is published | `src/web/content.ts`, `src/web/strings.ts`, `src/content/workflow.ts` |
| Inbox with claim/assign, notes, history, live updates, one-button escalation to a nurse, and a protection pathway per site | `src/web/inbox.ts`, `src/cases.ts` |
| Clinic desks check passes by SMS or USSD when they have no internet | `src/clinicDesk.ts` |
| Dashboard with filters, trends, CSV and a monthly donor PDF; every count under 5 hidden | `src/web/dashboard.ts`, `src/stats.ts`, `src/reports/` |
| Dada payments through M-Pesa B2C, approved in batches and reconciled | `src/web/payments.ts`, `src/payments/mpesa.ts` |
| WhatsApp buttons and lists, the 24-hour window (templates, SMS fallback, held messages), delivery statuses, recorded voice answers | `src/channels/` |
| Every inbound message recorded first: duplicates ignored, crashes recovered, each girl's messages handled in order | `src/channels/inbound.ts` |
| USSD menus for feature phones, including "Urgent help now" that reaches a human | `src/ussd.ts` |
| Nearest partner clinic from a shared location or a typed landmark (coordinates never stored) | `src/location.ts` |
| Model registry: new models are candidates; a danger-sign model can't go live if recall drops for any danger class | `src/ml/registry.ts`, `/staff/models` |

## Run it locally (no accounts needed)

Requires Node.js 22.12 or newer.

```bash
npm install
npm run train      # trains the starter models from data/seed
npm run dev        # http://localhost:3000
```

- **Simulator** (chat as a girl): http://localhost:3000/simulator
- **Staff login**: http://localhost:3000/staff/login — logins `admin`, `nurse`, `dada`, `clinic-a`, `partner`, `reviewer` (health-partner reviewer), `editor` (content editor / translator); password `change-me-now` (set `DEMO_STAFF_PASSWORD` to change it)

With no keys set, everything runs in **mock mode**: answers come straight from the approved content, voice notes use the simulator's typed text, and messages are logged instead of sent. The database is embedded Postgres (PGlite) in `./.data`. Settings are read from `.env` if it exists (copy `.env.example`).

**Two-step login is on by default, also locally:**

- `admin`, `nurse`, `partner`, `reviewer` and `editor` set up an authenticator app (Aegis, FreeOTP, Google Authenticator…) the first time they log in, by scanning a QR code. They get 8 one-time recovery codes.
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

### Health content in production

Production starts with no health content. Import the starter topics and glossary as **drafts**, then review and publish them in the Content studio:

```bash
npm run import-content    # or: docker compose exec app node --import tsx src/importContent.ts
```

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
6. **USSD** (Africa's Talking, for girls on feature phones and for clinic desks): see [USSD](#ussd).
7. **Dada payments**: see [Dada payments](#dada-payments-m-pesa).
8. **SMS delivery reports and opt-outs** (Africa's Talking dashboard → SMS → Callback URLs): delivery reports to `https://<your-host>/webhooks/sms/delivery?key=<SMS_WEBHOOK_KEY>`, opt-outs to `https://<your-host>/webhooks/sms/optout?key=<SMS_WEBHOOK_KEY>`.

## How it is built

- **Database migrations** — numbered files in `migrations/` (`0001_initial.sql`, `0002_…`). Each runs once, in its own transaction, under a Postgres advisory lock, so two instances starting together are safe. Applied files are checksummed: editing one stops the app; add a new numbered file instead. `npm run migrate -- --status` lists them.
- **Configuration** — every environment variable is validated with zod at startup (`src/config.ts`), with one clear message per problem.
- **Staff security** — sessions are stored server-side (only a hash of the token), so log-out, deactivation and password changes take effect immediately. Every staff form carries a CSRF token. Login and two-step codes are rate-limited; 5 wrong passwords or codes lock an account for 15 minutes. Passwords need 12+ characters. Security headers (strict Content-Security-Policy, no framing, HSTS in production), request size limits, and `Cache-Control: no-store` on every staff page (phones are often shared).
- **Audit log** — `/staff/audit` (admins) shows every login, case view, reply sent (by message id), pass check, label and admin action. The table is append-only (a database trigger refuses edits and deletes) and never stores message text or phone numbers.
- **Background jobs** — a Postgres-backed queue (`src/jobs/`) with retries, backoff, crash recovery and de-duplication. Each referral schedules its own day-3 check-in; a sweep every 15 minutes catches anything missed; failed messages to girls and failed nurse alerts are retried until delivered (nurse alerts up to 20 times). Several app instances can share the queue.
- **Operations** — JSON logs (one line per event; no message text, phone numbers, cookies or keys), `X-Request-Id` on every response, `GET /health` (checks the database; 503 while down or shutting down) and `GET /health/live`. On `SIGTERM` the app stops taking requests, finishes in-flight work and the current job, then closes the database.

## The staff platform

Every page is server-rendered, works on a cheap Android phone on 3G, and shows each role only what it needs.

| Role | Sees |
|---|---|
| Admin | Everything except approving content: staff, clinics, sites, payments, audit log, inbox, dashboard |
| Nurse | Every case, labelling, dashboard |
| Dada | Dada-level cases (safety, "talk to a person") and cases assigned to her; medical and self-harm cases go to nurses |
| Clinic desk | Pass checks only, never who the girl is |
| Partner | Dashboard, CSV and monthly PDF (aggregates only) |
| Health-partner reviewer | Approves or returns content, translations and glossary terms; can never approve their own work |
| Editor / translator | Writes content and translations, uploads recorded voice answers, publishes approved versions |

- **Admin** (`/staff/admin`): invite staff with a one-time link (72 hours, optionally sent by SMS), change roles (ends their sessions), deactivate, reset a password (24-hour link) or two-step login, unlock. Clinics with services, hours, verified flag, Kenya Master Facility List code and site. Sites, each with its protection checklist and referral contacts; a contact stays "Not verified" until a staff member confirms it, and editing it clears that.
- **Content studio** (`/staff/content`): Draft → In review → Approved (the reviewer's name, title and organisation are recorded) → Published. One published version per topic and language, full version history, the four languages side by side, a recorded voice answer per version. Translation studio (`/staff/translations`) works the same way for every message in `src/i18n.ts` and refuses a translation that drops a `{placeholder}`. Glossary studio (`/staff/glossary`) for coded words, verified by a reviewer.
- **Inbox** (`/staff/inbox`): filters (urgent, mine, unassigned, language), claim, assign, return to the queue, internal notes, a full history per case, live updates (server-sent events), and **Escalate to nurse**, which alerts the nurses by SMS. Safety cases show the site's protection checklist (each step recorded) and its referral contacts.
- **Clinic desk**: the web page, or from the clinic's registered phone with a desk PIN: SMS `CHECK UB-7K42 1234` / `SEEN UB-7K42 1234`, or the USSD menu. Wrong PINs lock the desk like wrong passwords.
- **Dashboard** (`/staff/dashboard`): date range or presets, site/clinic/language filters, weekly trend charts with a table view, clinic dignity scores, **Download CSV**, **Monthly PDF report**. Counts from 1 to 4 are shown as "<5" everywhere, including exports.

## Channels

**WhatsApp.** Menus are written once as numbered lines in the (translated) message text; WhatsApp shows them as reply buttons (up to 3) or a list (up to 10), and a tap sends back the number, so SMS and WhatsApp share one flow and one set of translations. WhatsApp only allows free-form messages within 24 hours of the girl's last message:

- the day-3 check-in outside that window uses the approved **check-in template** (Yes / Not yet buttons) if one exists for her language, otherwise it goes **by SMS**;
- any other message (a Dada's reply, a held answer) is **held** and sent the moment she writes again; she gets the approved **notify template**, or, without one, a short SMS that reveals nothing about the message;
- delivered / read / failed statuses are recorded; a failure because the window closed puts the message on hold; temporary failures are retried.

Recorded voice answers (uploaded in the Content studio and approved with the text) are sent after the text on WhatsApp.

**Setting up the WhatsApp templates** (needs your Meta Business account):

1. In **WhatsApp Manager → Account tools → Message templates**, create a template named `ubah_checkin`, category **Utility**, language English. Body: `Hi, it's Ubah. Did you visit a clinic with your pass {{1}}?` Add two **Quick reply** buttons in this order: `Yes`, `Not yet` (Ubah sends their payloads as 1 and 2).
2. Create `ubah_new_message`, category **Utility**, body: `You have a new message from Ubah. Reply to this message to read it.` No buttons, no variables.
3. Add a language version of each template only once a native speaker has written and a reviewer approved the wording (the same text you'd publish in the Translation studio). Meta reviews templates, usually within a day.
4. When approved, set `WHATSAPP_TEMPLATE_CHECKIN=ubah_checkin`, `WHATSAPP_TEMPLATE_NOTIFY=ubah_new_message`, and list the approved languages: `WHATSAPP_TEMPLATE_LANGUAGES=en:en,sw:sw` (Ubah language : WhatsApp language code). A girl whose language has no approved template gets SMS instead.

**SMS.** Long answers are split at sentence breaks into numbered parts of at most `SMS_PART_CHARS` characters. Delivery reports mark messages delivered or failed; when a phone was switched off, Ubah tries again later. Network opt-outs and the STOP command both stop every message until she writes again (a danger sign is always answered).

### USSD

One service code serves both girls and clinic desks (a clinic desk is recognised by its registered phone).

- **Girls:** language, then 1 Health topics (short answer on screen, full answer by SMS, with its source), 2 Find a clinic (pass by SMS), 3 My passes, 4 Talk to a Dada, **5 Urgent help now** (heavy bleeding or pregnancy problem / someone is hurting me / I want to hurt myself — each opens an urgent case for a nurse or Dada at once, and a medical one also issues an urgent pass), 6 Language.
- **Clinic desks:** check a pass or record a visit, with the desk PIN.

Setup: in the Africa's Talking dashboard, **USSD → Create channel** (a shared code like `*384*1234#` costs less than a dedicated one), and set the callback URL to `https://<your-host>/webhooks/ussd?key=<SMS_WEBHOOK_KEY>`. Test it first in the Africa's Talking sandbox simulator.

### Nearest clinic

A girl can share her WhatsApp location, or reply `NEAR` and the name of her area or a landmark. Ubah suggests the two nearest partner clinics that offer what she needs. Her coordinates are used once and never stored; only the matched area name and site are kept. Add each clinic's coordinates and the landmarks girls use (market, school, mosque, block names) in **Admin → Clinics**.

### Voice

Voice notes are transcribed by any OpenAI-compatible `/audio/transcriptions` endpoint (`STT_BASE_URL`, `STT_MODEL`), then the audio is discarded. Choose a model only after measuring it:

1. Record a **consented** test set: young women (18+) reading or speaking typical questions in each language, each with a signed consent form. Put the clips and a `manifest.jsonl` in `data/stt-eval/` (git-ignored; see the top of `src/ai/sttEval.ts` for the format, including `consent_ref`).
2. Run `npm run eval:stt` against each candidate model. It refuses clips without documented consent and reports word and character error rates per language.
3. Options: OpenAI Whisper (simplest, but the audio leaves Kenya: include it in the DPIA), a self-hosted Whisper server (e.g. faster-whisper with an OpenAI-compatible API), or Meta MMS, which covers Somali and Afaan Oromoo. Fine-tune on the consented set if error rates are high.

Until voice works well, Ubah always invites girls to type instead.

## Machine learning

The danger-sign classifier sits behind fixed rules (`src/ml/models.ts`): the rules always send self-harm, violence and medical emergencies to a human; the model catches what the rules miss. Danger signs are checked on every message, at every step of the conversation.

- **Registry** (`/staff/models`, admins and nurses): every trained model is kept with its 5-fold cross-validated report (precision and recall per class, confusion matrix). The models in `models/` are registered as version 1 on first start.
- **Retrain** from the seed set plus every message nurses and Dadas labelled: the **Train new candidates** button, or `npm run train -- --register`. New models are candidates; an admin promotes one to live.
- **Safety gate:** a danger-sign candidate whose recall for medical, safety or self-harm is lower than the live model's can't be promoted, and the attempt is logged.
- **Languages:** search and the classifiers tokenize each language separately. Somali has a stopword list and light suffix stripping (marked DRAFT in `src/ml/text.ts`, for native speakers to review); Kiswahili and Afaan Oromoo are lower-cased only for now.

## Dada payments (M-Pesa)

Handled cases create a payout (`DADA_PAY_PER_CASE_KES`); admins can also add one (e.g. a training day). On `/staff/payments` an admin approves payouts into a batch, then pays the batch through M-Pesa B2C. Results arrive on a callback; `/staff/payments/reconcile` lists anything failed or unanswered, with **retry**, **paid (enter the receipt from the M-Pesa portal)** or **cancel**. A request is sent to M-Pesa at most once automatically: if the outcome is unclear it is marked failed with a note to check the portal first, so no one is paid twice.

Without keys, payments run in **mock mode** (marked paid with a `MOCK…` receipt) — development only; production refuses to send. To connect real M-Pesa:

1. Your organisation needs a **Safaricom M-Pesa B2C (bulk disbursement) paybill or short code**. Apply through Safaricom Business (or your bank/aggregator); this needs company documents and can take a few weeks.
2. Create an account at **developer.safaricom.co.ke** (Daraja), create an app with the **M-Pesa Sandbox** product, and note its **Consumer Key** and **Consumer Secret**.
3. In the Daraja sandbox **Test credentials** page note the test **short code**, **initiator name**, and generate the **Security Credential** from the initiator password.
4. Put them in `.env`: `MPESA_ENV=sandbox`, `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORTCODE`, `MPESA_INITIATOR_NAME`, `MPESA_SECURITY_CREDENTIAL`, and `MPESA_CALLBACK_TOKEN` (`openssl rand -hex 16`). `BASE_URL` must be your public https address: Safaricom calls `https://<your-host>/webhooks/mpesa/<MPESA_CALLBACK_TOKEN>/result`.
5. Pay a small sandbox batch and check it on the reconcile page.
6. For real money, go live on the Daraja portal ("Go Live"), which links your production short code; then set `MPESA_ENV=production` with the production key, secret, initiator and security credential (generated with the production certificate).

## Training Ubah's models

```bash
npm run train                # seed data + data/labeled/*.jsonl -> models/ files
npm run train -- --export    # first export nurse/Dada labels from the database
npm run train -- --register  # train from seed + database labels and register candidates (promote on /staff/models)
```

Each run writes `models/<task>.json` and `models/<task>.report.json` (5-fold cross-validated precision and recall per class). **Seed-only results prove the pipeline works; they are not evidence of real-world accuracy.** Report numbers from labelled pilot data. `data/labeled/` is git-ignored because it contains real (anonymous) messages.

## Tests

```bash
npm run check      # lint + typecheck + all tests
npm test           # tests on embedded Postgres (PGlite)
TEST_DATABASE_URL=postgres://user@localhost:5432/ubah_test npm test   # the same tests on a real Postgres server
```

129 tests cover the full loop (question → answer → pass → check-in → dignity score), danger handoffs, coded words, voice notes, STOP/DELETE, the webhooks and their authentication, two-step login, lockout, CSRF, sessions, the audit log, migrations, config validation, the job queue and retries, health checks and graceful shutdown, and every Phase 2 page and action: staff invites and resets, clinics, sites and the protection pathway, the content/translation/glossary review workflow (including "only published content reaches girls"), voice uploads, the inbox (visibility, claim, assign, escalate, notes, live updates), SMS and USSD pass checks, dashboard filters, CSV and PDF, M-Pesa payments (mock, real API shape, callbacks, reconciliation), and the channels work: danger signs on every step (including a girl's first message), WhatsApp buttons, de-duplication, delivery statuses, the 24-hour window with templates, SMS fallback and held messages, voice answers, SMS splitting, delivery reports and opt-outs, inbound recovery, girls' USSD menus including urgent help, nearest clinic, citations, Somali search, the model registry's safety gate and the STT evaluation. A route inventory test fails if any of the 120 routes is added without being listed, if a page breaks for a role that should see it or opens for one that shouldn't, or if any form lacks a CSRF token.

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on both PGlite and Postgres 16, and builds the Docker image.

## Before a pilot — must do

- [ ] Import the starter content (`npm run import-content`); a health-partner reviewer reviews every topic in the Content studio and editors publish the approved ones; verify the hotline numbers in the text.
- [ ] Native speakers translate every message in the Translation studio and the content into Somali, Kiswahili and Afaan Oromoo; reviewers who speak each language approve; test with girls.
- [ ] Collect real coded words in community sessions and add them in the Glossary studio.
- [ ] Add the verified partner clinics (with Kenya Master Facility List codes) and sites in Admin; agree each site's protection checklist and referral contacts with protection partners and mark contacts verified.
- [ ] Register each clinic desk's phone and set desk PINs; set up M-Pesa (see [Dada payments](#dada-payments-m-pesa)).
- [ ] Get the WhatsApp templates approved (see [Channels](#channels)), set up the USSD code and SMS callbacks, and add clinic coordinates and landmarks.
- [ ] Measure speech-to-text on a consented test set before relying on voice notes (see [Voice](#voice)); native speakers review the DRAFT Somali word lists.
- [ ] Ethics approval; testing starts with young women aged 18+.
- [ ] Data protection impact assessment (Kenya Data Protection Act 2019).
- [ ] Generate production secrets (`openssl rand -hex 32` for each), create the first admin with `npm run create-admin`, and give every staff member their own account.
- [ ] Agree safeguarding and referral pathways with health and protection partners.

## Roadmap to a pilot

- [x] **Phase 1 — Production foundations**: migrations, validated config, CSRF, rate limits, lockout, security headers, two-step login (TOTP and SMS), audit log, structured logs, health checks, graceful shutdown, Postgres job queue, Docker and CI.
- [x] **Phase 2 — Staff platform**: admin (staff, clinics, sites), content, translation and glossary studios with review workflow, full inbox, protection pathway, clinic desk by SMS/USSD, dashboard filters, trends, CSV and PDF, Dada payments through M-Pesa.
- [x] **Phase 3 — Channels, AI and machine learning**: WhatsApp buttons, templates and the 24-hour window, delivery reports, durable inbound, USSD for girls, voice answers and STT evaluation, multilingual search with citations, nearest clinic, model registry with a danger-recall gate.
- [ ] **Phase 4 — Girl-facing app**: offline-capable PWA.
- [ ] **Phase 5 — Pilot readiness**: end-to-end and load tests, deployment guide, DPIA, privacy notice and safeguarding drafts, demo mode.

## Licences

- Code: Apache License 2.0 (add the full licence text with GitHub's "Add file → LICENSE" template).
- Health content (`content/`), glossary and evaluation data (`data/`): Creative Commons Attribution 4.0 (CC BY 4.0).

## Author

Created by Firdausa Salat, HPI-SOLUTIONS KE LIMITED, Nairobi, Kenya.
