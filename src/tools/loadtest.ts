// Load test for Ubah's webhooks. Run it against a STAGING server, never production with real numbers.
//   npm run loadtest -- --url https://staging.example.org --rate 50 --duration 30 --kind whatsapp
// Options:
//   --url        base URL of a running Ubah (default http://localhost:3000)
//   --rate       requests per second (default 20)
//   --duration   seconds (default 20)
//   --kind       whatsapp | sms (default whatsapp)
//   --app-secret WhatsApp app secret, to sign requests like Meta does (or WHATSAPP_APP_SECRET)
//   --sms-key    SMS webhook key (or SMS_WEBHOOK_KEY)
// Every request is a new made-up sender (+2547990xxxxx), so each one creates a girl and a reply:
// that is the expensive path. Fails (exit code 1) if more than 1% of requests fail or p95 > 1000 ms.
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export interface LoadOptions {
  url: string;
  rate: number;
  durationS: number;
  kind: "whatsapp" | "sms";
  appSecret?: string;
  smsKey?: string;
  senderPrefix?: string;
}

export interface LoadResult {
  sent: number;
  ok: number;
  failed: number;
  statuses: Record<string, number>;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  rps: number;
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export async function runLoad(o: LoadOptions): Promise<LoadResult> {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  let sent = 0;
  const total = Math.max(1, Math.round(o.rate * o.durationS));
  const start = Date.now();
  const inflight: Promise<void>[] = [];
  const prefix = o.senderPrefix ?? "2547990";
  for (let i = 0; i < total; i++) {
    // Spread requests evenly over the duration.
    const due = start + (i * 1000) / o.rate;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const from = `${prefix}${String(i).padStart(5, "0")}`;
    let url: string;
    let init: RequestInit;
    if (o.kind === "whatsapp") {
      const body = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from, id: `wamid.load.${start}.${i}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hello" } }] } }] }] });
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.appSecret) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", o.appSecret).update(body).digest("hex")}`;
      url = `${o.url}/webhooks/whatsapp`;
      init = { method: "POST", headers, body };
    } else {
      url = `${o.url}/webhooks/sms${o.smsKey ? `?key=${encodeURIComponent(o.smsKey)}` : ""}`;
      init = { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ from: `+${from}`, to: "UBAH", text: "hello", id: `ATload-${start}-${i}` }) };
    }
    sent++;
    const t0 = performance.now();
    inflight.push(
      fetch(url, { ...init, signal: AbortSignal.timeout(10_000) })
        .then((res) => {
          statuses[res.status] = (statuses[res.status] ?? 0) + 1;
        })
        .catch(() => {
          statuses.error = (statuses.error ?? 0) + 1;
        })
        .finally(() => latencies.push(performance.now() - t0)),
    );
  }
  await Promise.all(inflight);
  const sorted = latencies.sort((a, b) => a - b);
  const ok = statuses["200"] ?? 0;
  return {
    sent,
    ok,
    failed: sent - ok,
    statuses,
    p50: Math.round(pct(sorted, 50)),
    p95: Math.round(pct(sorted, 95)),
    p99: Math.round(pct(sorted, 99)),
    max: Math.round(sorted.at(-1) ?? 0),
    rps: Math.round((sent / Math.max(1, Date.now() - start)) * 1000),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({
    options: { url: { type: "string" }, rate: { type: "string" }, duration: { type: "string" }, kind: { type: "string" }, "app-secret": { type: "string" }, "sms-key": { type: "string" } },
  });
  const o: LoadOptions = {
    url: (values.url ?? "http://localhost:3000").replace(/\/$/, ""),
    rate: Number(values.rate ?? 20),
    durationS: Number(values.duration ?? 20),
    kind: values.kind === "sms" ? "sms" : "whatsapp",
    appSecret: values["app-secret"] ?? process.env.WHATSAPP_APP_SECRET,
    smsKey: values["sms-key"] ?? process.env.SMS_WEBHOOK_KEY,
  };
  console.log(`Load test: ${o.kind} webhooks at ${o.rate}/s for ${o.durationS}s against ${o.url}`);
  const r = await runLoad(o);
  console.log(JSON.stringify(r, null, 2));
  const errorRate = r.failed / Math.max(1, r.sent);
  if (errorRate > 0.01 || r.p95 > 1000) {
    console.error(`FAILED: ${(errorRate * 100).toFixed(1)}% errors, p95 ${r.p95} ms (limits: 1%, 1000 ms)`);
    process.exit(1);
  }
  console.log("PASSED");
}
