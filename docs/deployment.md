# Deploying Ubah

Two ways to run a pilot. Both use the same Docker image and the same settings (`.env.example`). The image contains everything at one address: the landing page, the girls' space (`/me`), the health-worker dashboard (`/worker`), admin (`/admin`), the staff pages (`/staff`) and the channels' webhooks. Start with the [go-live checklist](#go-live-checklist) at the end: it lists what must be true before the first real girl.

| | Option A: one server | Option B: AWS managed |
|---|---|---|
| Good for | A pilot of a few thousand girls | Growth, or a partner that requires AWS |
| Pieces | 1 Linux server running Docker: Ubah + Postgres + Caddy (HTTPS) | ECS Fargate (Ubah) + RDS Postgres + S3 (backups) + CloudWatch |
| Rough cost | Low (one small server + off-site backup storage) | Higher (managed database, load balancer) |
| You manage | OS updates, backups (scripted below) | Less: AWS patches the database and keeps backups |

**Where the data lives.** Kenya's Data Protection Act 2019 allows storage outside Kenya only with appropriate safeguards (sections 48–50). AWS has no Kenyan region (the nearest is Cape Town, `af-south-1`). A Kenyan hosting provider or a server in a Kenyan data centre keeps data in the country. Record the choice and its safeguards in the DPIA (`docs/dpia-template.md`) and confirm it with your legal adviser and the Office of the Data Protection Commissioner (ODPC) requirements.

---

## Option A: one server

### 1. Server
- Ubuntu 24.04 LTS, 2 vCPU, 4 GB RAM, 40 GB disk is plenty for a pilot.
- A domain name pointing at the server (e.g. `ubah.example.org`, an `A` record).
- Only ports 22 (SSH, keys only), 80 and 443 open:

```bash
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config && sudo systemctl restart ssh
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades   # automatic security updates
```

### 2. Ubah
```bash
git clone <your private copy of the repository> /opt/ubah && cd /opt/ubah
cp .env.example .env && chmod 600 .env
# Fill in .env. Generate each secret with: openssl rand -hex 32
#   NODE_ENV=production, BASE_URL=https://ubah.example.org, TRUST_PROXY=1
#   POSTGRES_PASSWORD, HASH_SECRET, ENCRYPTION_KEY, SESSION_SECRET, OPS_KEY
#   ALLOW_DRAFT_CONTENT=false, SEED_DEMO=false, NURSE_ALERT_NUMBERS, AT_USERNAME, AT_API_KEY, SMS_WEBHOOK_KEY
#   GOOGLE_TRANSLATE_API_KEY (required: workers read girls' messages in English)
#   STT_API_KEY (speech-to-text), and per language STT_<LANG>_* if a language uses MMS or Google (see below)
#   VOICE_REPLIES stays false until a language has an approved voice
docker compose up -d --build
docker compose exec app node --import tsx src/createAdmin.ts --login <login> --name "<full name>"
docker compose exec app node --import tsx src/importContent.ts   # starter content as DRAFTS
```

**Keep `ENCRYPTION_KEY` and `HASH_SECRET` safe and backed up separately from the database** (e.g. in a password manager two named people can open). Without them, the encrypted phone numbers can't be read and returning girls aren't recognised. Never change them on a running pilot.

### 3. HTTPS with Caddy
Caddy gets and renews the certificate automatically.

```bash
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'EOF'
ubah.example.org {
  encode gzip
  reverse_proxy 127.0.0.1:3000
  request_body {
    max_size 3MB
  }
}
EOF
sudo systemctl reload caddy
curl -s https://ubah.example.org/health   # {"ok":true,"db":"ok",...}
```

### 4. Backups (nightly, encrypted, off-site)
`pg_dump` every night, encrypted with [age](https://age-encryption.org) (open source) before it leaves the server, copied to S3-compatible storage. Keep 30 nightly and 12 monthly copies.

```bash
sudo apt-get install -y age awscli
age-keygen -o /root/ubah-backup.key        # the PRIVATE key: store it OFF the server (password manager), then delete it here
grep 'public key' /root/ubah-backup.key    # copy the age1... public key
sudo tee /opt/ubah/backup.sh >/dev/null <<'EOF'
#!/bin/sh
set -eu
STAMP=$(date -u +%Y-%m-%dT%H%M)
cd /opt/ubah
docker compose exec -T db pg_dump -U ubah -d ubah --format=custom \
  | age -r "age1REPLACE_WITH_PUBLIC_KEY" > /var/backups/ubah-$STAMP.dump.age
aws s3 cp /var/backups/ubah-$STAMP.dump.age s3://YOUR-BUCKET/ubah/$STAMP.dump.age
find /var/backups -name 'ubah-*.dump.age' -mtime +7 -delete
curl -fsS "$HEALTHCHECK_URL" >/dev/null || true   # tell your monitor the backup ran (optional)
EOF
sudo chmod 700 /opt/ubah/backup.sh
echo '30 2 * * * root /opt/ubah/backup.sh' | sudo tee /etc/cron.d/ubah-backup
```

Set the bucket's lifecycle rules to delete daily copies after 30 days and keep the first copy of each month for 12 months. Turn on bucket versioning and block public access.

### 5. Restore (practise it before the pilot, then every 3 months)
```bash
aws s3 cp s3://YOUR-BUCKET/ubah/<STAMP>.dump.age /tmp/restore.dump.age
age -d -i /path/to/ubah-backup.key /tmp/restore.dump.age > /tmp/restore.dump
docker compose stop app
docker compose exec -T db dropdb -U ubah ubah && docker compose exec -T db createdb -U ubah ubah
docker compose exec -T db pg_restore -U ubah -d ubah --no-owner < /tmp/restore.dump
docker compose start app && curl -s https://ubah.example.org/health
shred -u /tmp/restore.dump /tmp/restore.dump.age
```

Record each drill (date, who, how long it took) in your operations log.

### 6. Updates
```bash
cd /opt/ubah && git pull && docker compose up -d --build   # migrations run on start
docker compose logs --tail=50 app
```
Take a backup first (`/opt/ubah/backup.sh`). The app refuses to start if a migration file was edited after it ran, so a bad update can't silently change the database.

### 7. Speech-to-text servers (only if a language uses them)

Which provider each language uses comes from your evaluation (`npm run eval:languages`, see `eval/README.md`), not from this guide.

- **OpenAI** (default for Somali, Kiswahili, English): only `STT_API_KEY`. The audio leaves Kenya: record it in the DPIA.
- **Meta MMS** (Afaan Oromoo): run `tools/mms-server/` on a **separate** machine with a GPU, reachable only from the Ubah server (firewall: allow port 8090 from the Ubah server's address only), with `MMS_API_KEY` set. Then in Ubah's `.env`: `STT_OM_PROVIDER=mms`, `STT_OM_BASE_URL=http://<mms-host>:8090`, `STT_OM_API_KEY=<the same key>`, `STT_OM_LANGUAGE=<the Oromo variety you chose>`. The MMS weights are non-commercial (CC-BY-NC): your legal adviser must approve their use first. Hosting it in Kenya keeps Oromo voices in the country.
- **Google Chirp** (if it measured best, e.g. for Kiswahili): a service account with the *Cloud Speech Client* role; put its JSON key on the server (`chmod 600`) and set `STT_GOOGLE_CREDENTIALS=/path/key.json`, `STT_GOOGLE_LOCATION`, and `STT_<LANG>_PROVIDER=google`. With Docker, mount the key file into the container or use `STT_GOOGLE_CREDENTIALS_JSON`.

Ubah refuses to start in production if a language is set to MMS or Google without its server or key.

---

## Option B: AWS

1. **Database:** RDS for PostgreSQL 16, Multi-AZ, encrypted (KMS), automated backups 30 days, in private subnets. Turn on deletion protection.
2. **Image:** build and push the Docker image to ECR (`docker build -t ubah . && docker push <account>.dkr.ecr.<region>.amazonaws.com/ubah:<version>`).
3. **App:** ECS Fargate service, 2 tasks, 0.5 vCPU / 1 GB each, behind an Application Load Balancer with an ACM certificate. Health check path `/health`. Secrets (`HASH_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `DATABASE_URL`, API keys) in AWS Secrets Manager, injected as environment variables. `TRUST_PROXY=1`.
4. **Logs:** the app writes JSON lines to stdout; send them to CloudWatch Logs with 90-day retention.
5. **Extra backups:** a nightly scheduled task running the same `pg_dump | age` to an S3 bucket in another region, as in Option A.
6. **Rate limits:** the in-app limits are per task; add AWS WAF rate-based rules on `/webhooks/*` and `/staff/login`.
7. With two or more tasks, everything else works as is: the job queue and migrations use Postgres locks, so tasks share work safely.

---

## Monitoring and alerting

| Check | How | Alert when |
|---|---|---|
| App up | `GET https://<host>/health/live` every minute | 2 failures in a row |
| Database reachable | `GET https://<host>/health` | not 200 |
| **Urgent case unanswered** | `GET https://<host>/health/ops?key=<OPS_KEY>` (or `&format=prometheus`) | `urgent_unanswered_15m > 0` |
| Nurse alerts failing | same endpoint | `staff_alerts_failed > 0` |
| Worker stopped | same endpoint | `jobs_overdue_10m > 0` |
| Messages stuck | same endpoint | `inbound_stuck > 0` |
| **Girls waiting** (daily check) | same endpoint | `messages_waiting_24h > 0` (a worker hasn't opened a girl's message for a day: see `/admin`, where each worker shows how many) or `girls_unassigned_waiting_24h > 0` (assign them in `/admin`). These don't turn `/health/ops` red: check them each morning, or alert in working hours only |
| Backups | the backup script pings a monitor | no ping for 26 hours |
| Certificate | your monitor's TLS check | expires in < 14 days |

`/health/ops` returns HTTP 503 whenever something needs a person, so any uptime monitor that alerts on non-200 works. An open-source option is [Uptime Kuma](https://github.com/louislam/uptime-kuma) on a second small server (not the Ubah server itself), sending alerts by SMS, email or Telegram to the on-call lead.

Ubah also acts on its own: an urgent case with no reply after 15 minutes re-alerts the nurses by SMS every 15 minutes until someone replies.

**Load test before going live**, against a staging server (never production with real numbers):

```bash
npm run loadtest -- --url https://staging.example.org --rate 50 --duration 60 --kind whatsapp --app-secret <staging app secret>
npm run loadtest -- --url https://staging.example.org --rate 50 --duration 60 --kind sms --sms-key <staging key>
```

It fails if more than 1% of requests fail or the 95th percentile is above one second.

## Go-live checklist

Tick every line before the first real girl. Keep the ticked copy, with names and dates, in your operations log.

**Legal and safeguarding**
- [ ] DPIA complete (`docs/dpia-template.md`), including every processor: hosting, Google (translation), OpenAI (speech), Meta MMS host if used, WhatsApp (Meta), Africa's Talking; where each stores data
- [ ] Data processing agreements signed with those processors
- [ ] Legal adviser approved: hosting location, the MMS licence (if used), the privacy notice
- [ ] Ethics approval; the age decision recorded (testing with 18+ only unless approved otherwise)
- [ ] Safeguarding procedure agreed with the protection partner (`docs/safeguarding-procedure.md`); referral contacts verified in `/staff`

**Content and languages**
- [ ] Health content approved and published by a named health-partner reviewer, in every language you open
- [ ] Every message girls see translated and published per language: run `npm run translations -- export <lang>`, have a native speaker check it, import it, then a reviewer publishes in the Translation studio (includes the `web_…`, `share_…` and `voice_…` messages)
- [ ] The girls' privacy notice translated and published
- [ ] Danger-word lists (`data/danger/`) checked and extended by nurses and native speakers, per language
- [ ] `npm run eval:languages` per language: **no urgent message missed**; each language set to `enabled` or `beta` in `src/languages/<lang>.ts` from its report, and a disabled language never shown
- [ ] Answer templates for common replies translated and checked (they replace machine translation)

**People and access**
- [ ] Staff accounts created (one per person, never shared), each with two-step login set up; test logins and demo data removed
- [ ] `NURSE_ALERT_NUMBERS` lists the nurses on call; each health worker's phone set in Admin, so urgent alerts reach their own worker too
- [ ] Girls assigned to health workers in `/admin`; who covers nights and weekends is agreed
- [ ] Health workers trained: the `/worker` inbox, "machine translated: check the meaning", urgent alerts switched on in their browser, Quick exit

**Running it**
- [ ] Production settings: Ubah starts (it refuses to start while any required setting is missing or unsafe)
- [ ] WhatsApp and SMS numbers live; one real test message each way per language, including a voice note
- [ ] Monitoring alerts reach the on-call lead (urgent case unanswered 15 minutes, nurse alerts failing, backups)
- [ ] A backup restored on a spare machine (drill recorded)
- [ ] Load test passed against staging
- [ ] An urgent test message ("I want to kill myself", in each language) reached a nurse by SMS and appeared at the top of `/worker`, and the girl got the help message at once

## Incidents

- **Data breach** (lost laptop, leaked backup key, unauthorised access): follow your data breach procedure. Kenya's Data Protection Act requires notifying the ODPC within 72 hours of becoming aware (section 43). Rotate every secret that may be exposed, revoke staff sessions (deactivate and reactivate accounts), and check `/staff/audit`.
- **Ubah down:** girls' messages are kept by WhatsApp and Africa's Talking, which retry webhooks; Ubah records each message before handling it and recovers anything left unhandled within 2 minutes of restarting. Tell the Dadas and nurses to watch for urgent cases once it is back.
