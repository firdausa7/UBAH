import type { Db } from "./db.js";
import { config } from "./config.js";
import { issueAndSend } from "./engine.js";
import type { UserRow } from "./channels/outbound.js";
import { refreshCaches } from "./caches.js";
import { localize, servingContent } from "./content/content.js";
import { clinicRatings } from "./ratings.js";
import { SERVICES, SERVICE_MENU } from "./referrals.js";

// Care, passes and lessons for girls, shared by the old app (/app) and the girls' space (/me).

export async function clinicsFor(db: Db, services: string[]) {
  const want = services.filter((s) => s in SERVICES);
  const [clinics, ratings] = await Promise.all([
    db.query(`SELECT c.id, c.name, c.area, c.hours, c.services, c.free, c.verified, s.name AS site FROM clinics c LEFT JOIN sites s ON s.id = c.site_id WHERE c.active ORDER BY c.verified DESC, c.name`),
    clinicRatings(db),
  ]);
  const list = clinics
    .map((c) => ({ c, overlap: want.filter((s) => c.services.includes(s)).length }))
    .filter((x) => !want.length || x.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map(({ c }) => ({ id: c.id, name: c.name, area: c.area, site: c.site, hours: c.hours, free: c.free, verified: c.verified, services: c.services, rating: ratings.get(c.id) ?? null }));
  return { services: SERVICE_MENU, clinics: list };
}

// Issues a pass (and sends its message on `user.channel`); null when no partner clinic offers the services.
export async function issuePassFor(db: Db, user: UserRow, requested: unknown): Promise<{ code: string | null } | "services"> {
  const services = (Array.isArray(requested) ? requested : []).map(String).filter((s: string) => SERVICE_MENU.includes(s));
  if (!services.length) return "services";
  await refreshCaches(db);
  await issueAndSend(db, user, services);
  const [p] = await db.query(`SELECT code FROM passes WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`, [user.id]);
  return { code: p?.code ?? null };
}

export async function passesFor(db: Db, userId: number) {
  const rows = await db.query(
    `SELECT p.code, p.services, p.urgent, p.issued_at, p.expires_at, p.redeemed_at, c.name AS clinic, c.area, c.hours,
            (SELECT respect FROM checkins ch WHERE ch.pass_code = p.code) AS respect
       FROM passes p LEFT JOIN clinics c ON c.id = p.suggested_clinic WHERE p.user_id = $1 ORDER BY p.issued_at DESC LIMIT 50`,
    [userId],
  );
  return rows.map((p) => ({
    code: p.code,
    services: p.services,
    urgent: p.urgent,
    issuedAt: p.issued_at,
    expiresAt: p.expires_at,
    valid: !p.redeemed_at && new Date(p.expires_at) > new Date(),
    redeemed: Boolean(p.redeemed_at),
    clinic: p.clinic,
    area: p.area,
    hours: p.hours,
    checkedIn: Boolean(p.respect),
  }));
}

// Published lessons in her language (else English, marked), and the sections still being written.
export async function lessonsFor(db: Db, lang: string) {
  await refreshCaches(db);
  const lessons = servingContent()
    .filter((c) => c.language === "en")
    .map((c) => localize(c, lang))
    .map(({ item, translated }) => ({ id: item.id, category: item.topic, title: item.title, body: item.body, translated, audio: translated && item.audioMediaId ? `/app/api/audio/${item.audioMediaId}` : null }));
  const ready = new Set(lessons.map((l) => l.category));
  const waiting = await db.query<{ category: string }>(
    `SELECT DISTINCT t.category FROM content_topics t WHERE NOT t.archived AND NOT EXISTS (SELECT 1 FROM content_versions v WHERE v.topic_id = t.id AND v.status = 'published')`,
  );
  const upcoming = waiting.map((w) => w.category).filter((c) => !ready.has(c)).sort();
  return { lang, lessons, upcoming, draft: config.allowDraftContent };
}
