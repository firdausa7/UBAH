import { fileURLToPath } from "node:url";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { hashPassword } from "./privacy.js";
import { importContentFiles } from "./content/content.js";
import { glossaryFile } from "./ml/glossary.js";

// Demo data for local testing. Clinic names are placeholders — replace with real,
// verified partner clinics (ideally matched to Kenya Master Facility List codes).

export const DEMO_CLINICS = [
  { name: "[Health post A]", area: "[Camp block]", services: ["pregnancy_test", "family_planning", "period_care", "sti", "counselling", "antenatal"], hours: "[Mon-Fri 8am-5pm]", verified: true },
  { name: "[Health post B]", area: "[Camp block]", services: ["pregnancy_test", "sti", "counselling", "safety"], hours: "[Mon-Sat 8am-4pm]", verified: true },
  { name: "[Clinic C]", area: "[Town]", services: ["family_planning", "period_care", "antenatal"], hours: "[Daily 8am-6pm]", verified: false },
];

// Starting content for any database (also production): content files and the glossary JSON, all as
// DRAFT / unverified. Safe to run repeatedly: only adds what is missing.
export async function importStarterContent(db: Db) {
  const added = await importContentFiles(db);
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM glossary_terms`);
  if (n === 0) {
    for (const g of glossaryFile()) {
      await db.query(`INSERT INTO glossary_terms (term, language, means, topic, verified) VALUES ($1,$2,$3,$4,FALSE) ON CONFLICT DO NOTHING`, [g.term, g.language, g.means, g.topic]);
    }
  }
  return added;
}

export async function seedDemo(db: Db, opts: { staffPassword?: string } = {}) {
  const [{ n }] = await db.query(`SELECT count(*)::int AS n FROM clinics`);
  if (n === 0) {
    const [site] = await db.query<{ id: number }>(`INSERT INTO sites (name, county) VALUES ('[Demo site]', '[County]') ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`);
    for (const c of DEMO_CLINICS) {
      await db.query(`INSERT INTO clinics (name, area, services, hours, verified, site_id) VALUES ($1,$2,$3,$4,$5,$6)`, [c.name, c.area, c.services, c.hours, c.verified, site.id]);
    }
  }
  await importStarterContent(db);
  if (config.production) throw new Error("Demo data is never seeded in production");
  const pw = opts.staffPassword ?? config.demoStaffPassword;
  // The demo Dada gets a fake phone so her SMS login code works in mock mode (it appears in the log).
  const staff: Array<[string, string, string, number | null, string | null]> = [
    ["Admin", "admin", "admin", null, null],
    ["Nurse on call", "nurse", "nurse", null, null],
    ["Dada Demo", "dada", "dada", null, "+254700000001"],
    ["Health post A desk", "clinic-a", "clinic", 1, null],
    ["Partner viewer", "partner", "partner", null, null],
    ["Reviewer Demo", "reviewer", "reviewer", null, null],
    ["Editor Demo", "editor", "editor", null, null],
  ];
  for (const [name, login, role, clinicId, phone] of staff) {
    await db.query(
      `INSERT INTO staff (name, role, login, password_hash, clinic_id, phone) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (login) DO NOTHING`,
      [name, role, login, hashPassword(pw), clinicId, phone],
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { getDb } = await import("./db.js");
  const db = await getDb();
  await seedDemo(db);
  console.log("Seeded demo clinics and staff logins: admin, nurse, dada, clinic-a, partner, reviewer, editor");
  console.log(`Password: ${process.env.DEMO_STAFF_PASSWORD ? "(from DEMO_STAFF_PASSWORD)" : "change-me-now"} — change it before sharing.`);
  console.log("Admin, nurse and partner set up an authenticator app at first login; the Dada's SMS code appears in the server log (mock mode).");
  await db.close();
  process.exit(0);
}
