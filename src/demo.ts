// Demo mode: realistic, made-up activity for presentations (e.g. to UNICEF).
//   npm run demo            add 8 weeks of demo data (refused in production)
//   npm run demo -- --wipe  remove every demo record
// Every demo record is marked (users/clinics/sites/staff.demo = TRUE) and labelled "[DEMO]";
// staff pages show a "DEMO DATA" banner while any exists, and demo girls can never be sent a message.
import type { Db } from "./db.js";
import { config } from "./config.js";
import { encryptPhone, hashPhone } from "./privacy.js";
import { analyse } from "./ml/models.js";

// Small deterministic random generator, so a demo looks the same every time.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Example questions (made up, in English) covering every topic and danger class.
const QUESTIONS: Array<[string, number]> = [
  ["my period is two weeks late, what should i do", 9],
  ["i get very bad cramps every month", 8],
  ["how do i use a pad", 5],
  ["how can i prevent pregnancy", 8],
  ["the condom broke last night", 4],
  ["i have itching and a smell down there", 5],
  ["where can i get an hiv test", 4],
  ["am i pregnant if i feel sick every morning", 6],
  ["i feel sad and alone all the time", 4],
  ["is white discharge normal", 4],
  ["my uncle beats me when he is angry", 2],
  ["i am pregnant and bleeding a lot", 2],
  ["i don't want to live anymore", 1],
  ["what is the capital of france", 1],
];

const LANGS: Array<[string, number]> = [
  ["so", 55],
  ["en", 20],
  ["sw", 15],
  ["om", 10],
];
const CHANNELS: Array<[string, number]> = [
  ["whatsapp", 55],
  ["sms", 25],
  ["app", 12],
  ["ussd", 8],
];

function pick<T>(r: () => number, items: Array<[T, number]>): T {
  const total = items.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of items) if ((x -= w) <= 0) return v;
  return items[0][0];
}

export async function hasDemoData(db: Db): Promise<boolean> {
  const [r] = await db.query<{ x: boolean }>(`SELECT EXISTS (SELECT 1 FROM users WHERE demo) OR EXISTS (SELECT 1 FROM clinics WHERE demo) AS x`);
  return r.x;
}

export async function wipeDemo(db: Db): Promise<void> {
  await db.tx(async (t) => {
    await t.query(`DELETE FROM users WHERE demo`); // cascades to messages, passes, check-ins, cases, notes
    await t.query(`DELETE FROM dada_payouts WHERE staff_id IN (SELECT id FROM staff WHERE demo)`);
    await t.query(`DELETE FROM payout_batches WHERE created_by IN (SELECT id FROM staff WHERE demo)`);
    await t.query(`UPDATE cases SET assigned_to = NULL WHERE assigned_to IN (SELECT id FROM staff WHERE demo)`);
    await t.query(`DELETE FROM labels WHERE labeled_by IN (SELECT id FROM staff WHERE demo)`);
    await t.query(`DELETE FROM staff WHERE demo`);
    await t.query(`DELETE FROM clinics WHERE demo`);
    await t.query(`DELETE FROM sites WHERE demo`);
  });
}

export async function loadDemo(db: Db, opts: { girls?: number; weeks?: number; seed?: number } = {}): Promise<{ girls: number; cases: number; passes: number }> {
  if (config.production) throw new Error("Demo data is never loaded in production.");
  await wipeDemo(db);
  const r = rng(opts.seed ?? 2026);
  const girls = opts.girls ?? 140;
  const weeks = opts.weeks ?? 8;
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  // Sites, clinics and staff, all labelled.
  const siteIds: number[] = [];
  for (const [name, county] of [
    ["[DEMO] Camp A", "[DEMO] County 1"],
    ["[DEMO] Town B", "[DEMO] County 2"],
  ]) {
    const [s] = await db.query<{ id: number }>(`INSERT INTO sites (name, county, demo) VALUES ($1,$2,TRUE) RETURNING id`, [name, county]);
    siteIds.push(s.id);
    await db.query(`INSERT INTO protection_steps (site_id, position, title, details) VALUES ($1,1,'[DEMO] Check she is safe right now',''),($1,2,'[DEMO] Offer the agreed protection referral',''),($1,3,'[DEMO] Agree a safe way to follow up','')`, [s.id]);
    await db.query(`INSERT INTO protection_contacts (site_id, name, organisation, service, phone) VALUES ($1,'[DEMO] Case worker','[DEMO] Protection partner','GBV case management','[DEMO]')`, [s.id]);
  }
  const clinicDefs: Array<[string, string, string[], boolean, number, number, number]> = [
    ["[DEMO] Health post 1", "Block 1", ["pregnancy_test", "family_planning", "period_care", "sti", "counselling", "antenatal"], true, 0, 0.051, 40.31],
    ["[DEMO] Health post 2", "Block 4", ["pregnancy_test", "sti", "counselling", "safety"], true, 0, 0.068, 40.34],
    ["[DEMO] Clinic 3", "Market road", ["family_planning", "period_care", "antenatal"], true, 1, 0.2, 40.42],
    ["[DEMO] Clinic 4", "Town centre", ["pregnancy_test", "family_planning", "sti", "counselling", "safety"], false, 1, 0.22, 40.45],
  ];
  const clinicIds: number[] = [];
  for (const [name, area, services, verified, site, lat, lng] of clinicDefs) {
    const [c] = await db.query<{ id: number }>(
      `INSERT INTO clinics (name, area, services, hours, verified, site_id, lat, lng, landmarks, demo) VALUES ($1,$2,$3,'[DEMO] Mon–Fri 8am–5pm',$4,$5,$6,$7,$8,TRUE) RETURNING id`,
      [name, area, services, verified, siteIds[site], lat, lng, [`[DEMO] ${area} market`]],
    );
    clinicIds.push(c.id);
  }
  const staffIds: Record<string, number> = {};
  for (const [login, name, role] of [
    ["demo-dada-1", "[DEMO] Dada Amina", "dada"],
    ["demo-dada-2", "[DEMO] Dada Hodan", "dada"],
    ["demo-nurse-1", "[DEMO] Nurse Faith", "nurse"],
  ]) {
    // No usable password: demo staff can't log in.
    const [s] = await db.query<{ id: number }>(`INSERT INTO staff (name, role, login, password_hash, phone, demo) VALUES ($1,$2,$3,'!',$4,TRUE) RETURNING id`, [name, role, login, role === "dada" ? "+254700000000" : null]);
    staffIds[login] = s.id;
  }
  const dadas = [staffIds["demo-dada-1"], staffIds["demo-dada-2"]];
  const nurse = staffIds["demo-nurse-1"];

  let caseCount = 0;
  let passCount = 0;
  const handledByDada: Array<{ caseId: number; dada: number; at: string }> = [];
  for (let i = 0; i < girls; i++) {
    // More girls in recent weeks, as a pilot grows.
    const startAgo = Math.floor(Math.pow(r(), 1.6) * weeks * 7 * 864e5);
    const lang = pick(r, LANGS);
    const channel = pick(r, CHANNELS);
    const id = `app:demo-${opts.seed ?? 2026}-${i}`;
    const [u] = await db.query<{ id: number }>(
      `INSERT INTO users (anon_id, phone_hash, phone_enc, channel, language, state, created_at, last_seen_at, site_id, demo) VALUES ($1,$2,$3,$4,$5,'{"step":"free"}',$6,$6,$7,TRUE) RETURNING id`,
      [`D${String(i).padStart(3, "0")}`, hashPhone(id), encryptPhone(id), channel === "ussd" ? "sms" : channel, lang, at(startAgo), siteIds[r() < 0.7 ? 0 : 1]],
    );
    const questions = 1 + Math.floor(r() * 3);
    for (let q = 0; q < questions; q++) {
      const text = pick(r, QUESTIONS);
      const a = analyse(text, "en");
      const when = startAgo - q * 3600e3;
      const voice = channel === "whatsapp" && r() < 0.3;
      await db.query(`INSERT INTO messages (user_id, direction, channel, kind, body, topic, danger, coded_terms, created_at) VALUES ($1,'in',$2,$3,$4,$5,$6,$7,$8)`, [
        u.id,
        channel,
        voice ? "voice" : "text",
        `[DEMO] ${text}`,
        a.topic,
        a.danger,
        a.codedTerms,
        at(when),
      ]);
      await db.query(`INSERT INTO messages (user_id, direction, channel, body, created_at) VALUES ($1,'out',$2,'[DEMO] (Ubah''s checked answer)',$3)`, [u.id, channel, at(when - 5000)]);
      if (a.danger !== "none") {
        const reason = `danger_${a.danger}`;
        const level = a.danger === "safety" ? "dada" : "nurse";
        const replyMin = 3 + Math.floor(r() * 25);
        const handler = level === "nurse" ? nurse : dadas[Math.floor(r() * 2)];
        const [c] = await db.query<{ id: number }>(
          `INSERT INTO cases (user_id, reason, urgent, summary, level, status, assigned_to, created_at, first_reply_at, handled_at, site_id)
           VALUES ($1,$2,TRUE,$3,$4,'handled',$5,$6,$7,$8,$9) RETURNING id`,
          [u.id, reason, `[DEMO] ${text}`, level, handler, at(when), at(when - replyMin * 60e3), at(when - (replyMin + 30) * 60e3), siteIds[0]],
        );
        await db.query(`INSERT INTO case_events (case_id, kind, at) VALUES ($1,'opened',$2)`, [c.id, at(when)]);
        caseCount++;
        if (level === "dada") handledByDada.push({ caseId: c.id, dada: handler, at: at(when) });
      } else if (r() < 0.12) {
        const [c] = await db.query<{ id: number }>(
          `INSERT INTO cases (user_id, reason, urgent, summary, level, status, assigned_to, created_at, first_reply_at, handled_at) VALUES ($1,'asked_for_person',FALSE,$2,'dada',$3,$4,$5,$6,$7) RETURNING id`,
          [u.id, `[DEMO] ${text}`, r() < 0.85 ? "handled" : "open", dadas[Math.floor(r() * 2)], at(when), at(when - 20 * 60e3), at(when - 60 * 60e3)],
        );
        caseCount++;
        handledByDada.push({ caseId: c.id, dada: dadas[0], at: at(when) });
      }
      // About half of girls with a care question get a pass.
      if (a.danger === "none" && a.topic && a.topic !== "feelings" && r() < 0.55) {
        const services = a.topic === "family_planning" ? ["family_planning"] : a.topic === "sti" ? ["sti"] : a.topic === "pregnancy" ? ["pregnancy_test"] : ["period_care"];
        const options = clinicIds.filter((_, k) => clinicDefs[k][2].some((s) => services.includes(s)));
        const clinic = options[Math.floor(r() * options.length)] ?? clinicIds[0];
        const code = `UB-D${(i * 7 + q).toString(36).toUpperCase().padStart(3, "0")}`;
        const issued = when - 60e3;
        const redeemed = r() < 0.6 && issued > 2 * 864e5;
        await db.query(
          `INSERT INTO passes (code, user_id, services, suggested_clinic, issued_at, expires_at, redeemed_at, redeemed_clinic) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [code, u.id, services, clinic, at(issued), at(issued - 7 * 864e5), redeemed ? at(issued - 1.5 * 864e5) : null, redeemed ? clinic : null],
        );
        passCount++;
        if (issued > 3 * 864e5) {
          const answered = r() < 0.75;
          const visited = answered ? r() < 0.78 : null;
          // Clinic 4 (not verified) gets worse respect answers, so the dashboard has something to show.
          const k = clinicIds.indexOf(clinic);
          const respect = visited ? pick(r, k === 3 ? [["yes", 4], ["partly", 3], ["no", 3]] : [["yes", 8], ["partly", 2], ["no", 1]]) : null;
          await db.query(
            `INSERT INTO checkins (pass_code, user_id, due_at, sent_at, visited, clinic_id, respect, completed_at) VALUES ($1,$2,$3,$3,$4,$5,$6,$7)`,
            [code, u.id, at(issued - 3 * 864e5), visited, visited ? clinic : null, respect, answered ? at(issued - 3.1 * 864e5) : null],
          );
        }
      }
    }
  }
  // Labels for model training, and Dada payouts.
  await db.query(
    `INSERT INTO labels (message_id, task, label, labeled_by) SELECT m.id, 'danger', coalesce(m.danger, 'none'), $1 FROM messages m JOIN users u ON u.id = m.user_id WHERE u.demo AND m.direction = 'in' AND m.id % 3 = 0 ON CONFLICT DO NOTHING`,
    [nurse],
  );
  const [batch] = await db.query<{ id: number }>(`INSERT INTO payout_batches (created_by, total_kes, payouts) VALUES ($1, 0, 0) RETURNING id`, [nurse]);
  for (const [n, h] of handledByDada.entries()) {
    const paid = n % 3 !== 0;
    await db.query(
      `INSERT INTO dada_payouts (staff_id, case_id, amount_kes, status, batch_id, receipt, paid_at, created_at, reason) VALUES ($1,$2,150,$3,$4,$5,$6,$7,'case') ON CONFLICT DO NOTHING`,
      [h.dada, h.caseId, paid ? "paid" : "pending", paid ? batch.id : null, paid ? `DEMO${String(n).padStart(6, "0")}` : null, paid ? h.at : null, h.at],
    );
  }
  await db.query(`UPDATE payout_batches SET total_kes = (SELECT coalesce(sum(amount_kes),0) FROM dada_payouts WHERE batch_id = $1), payouts = (SELECT count(*) FROM dada_payouts WHERE batch_id = $1) WHERE id = $1`, [batch.id]);
  return { girls, cases: caseCount, passes: passCount };
}
