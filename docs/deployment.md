# Deploying Ubah

Two ways to run a pilot. Both use the same Docker image and the same settings (`.env.example`).

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

## Incidents

- **Data breach** (lost laptop, leaked backup key, unauthorised access): follow your data breach procedure. Kenya's Data Protection Act requires notifying the ODPC within 72 hours of becoming aware (section 43). Rotate every secret that may be exposed, revoke staff sessions (deactivate and reactivate accounts), and check `/staff/audit`.
- **Ubah down:** girls' messages are kept by WhatsApp and Africa's Talking, which retry webhooks; Ubah records each message before handling it and recovers anything left unhandled within 2 minutes of restarting. Tell the Dadas and nurses to watch for urgent cases once it is back.
