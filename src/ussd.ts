import type { Db } from "./db.js";
import { shareOnRequest } from "./auth/access.js";
import { config } from "./config.js";
import { t, LANGUAGE_MENU } from "./i18n.js";
import { getOrCreateUser, openCase, say } from "./engine.js";
import { issuePass, SERVICE_MENU } from "./referrals.js";
import { sendToUser } from "./channels/outbound.js";
import { refreshCaches } from "./caches.js";
import { servingContent, localize } from "./content/content.js";
import { handleDeskUssd } from "./clinicDesk.js";

// USSD for feature phones (Africa's Talking). `text` is every answer in this session so far,
// joined by "*". Reply "CON …" to show a menu, "END …" to finish. Screens stay under 182 characters.
// Anything longer (a full answer, pass details) is also sent by SMS. Free text isn't possible on
// most feature phones, so danger signs have their own "Urgent help now" menu that reaches a human.

const MAX = 182;
const con = (s: string) => `CON ${s}`.slice(0, MAX);
const end = (s: string) => `END ${s}`.slice(0, MAX);
const CATEGORY_ORDER = ["periods", "conditions", "pregnancy", "family_planning", "sti", "safety", "fgm", "body", "feelings", "other"];
const URGENT: Record<string, { reason: string; services: string[] }> = {
  "1": { reason: "danger_medical", services: ["antenatal", "pregnancy_test", "period_care"] },
  "2": { reason: "danger_safety", services: ["safety", "counselling"] },
  "3": { reason: "danger_selfharm", services: ["counselling"] },
};

export async function handleUssd(db: Db, phone: string, text: string): Promise<string> {
  const desk = await handleDeskUssd(db, phone, text);
  if (desk !== null) return desk;

  await refreshCaches(db);
  // Follow-up messages (answers, passes, Dada replies) go by SMS.
  const { user } = await getOrCreateUser(db, { channel: "sms", from: phone });
  let parts = text === "" ? [] : text.split("*").map((p) => p.trim());

  // First, a language (once).
  if (!user.language) {
    if (!parts.length) return con(t("en", "ussd_language"));
    const lang = LANGUAGE_MENU.find(([n]) => n === parts[0])?.[1];
    if (!lang) return end(t("en", "ussd_invalid"));
    user.language = lang;
    await db.query(`UPDATE users SET language = $2, state = $3 WHERE id = $1`, [user.id, lang, JSON.stringify({ step: "free" })]);
    parts = parts.slice(1);
  }
  const lang = user.language;
  if (user.opted_out) {
    await db.query(`UPDATE users SET opted_out = FALSE WHERE id = $1`, [user.id]);
    user.opted_out = false;
  }
  if (!parts.length) return con(t(lang, "ussd_main"));
  const [choice, ...rest] = parts;

  // 1 Health topics -> category -> topic -> short answer (+ full answer by SMS)
  if (choice === "1") {
    const items = servingContent().filter((c) => c.language === "en");
    const cats = CATEGORY_ORDER.filter((c) => items.some((i) => i.topic === c));
    if (!cats.length) return end(t(lang, "ussd_no_topics"));
    if (!rest.length) return con(`${t(lang, "ussd_topics")}\n${cats.map((c, i) => `${i + 1} ${t(lang, `cat_${c}`)}`).join("\n")}`);
    const cat = cats[Number(rest[0]) - 1];
    if (!cat) return end(t(lang, "ussd_invalid"));
    const topics = items.filter((i) => i.topic === cat).slice(0, 7).map((i) => localize(i, lang));
    if (rest.length === 1) return con(`${t(lang, "ussd_topics")}\n${topics.map((x, i) => `${i + 1} ${x.item.title.slice(0, 22)}`).join("\n")}`);
    const pick = topics[Number(rest[1]) - 1];
    if (!pick) return end(t(lang, "ussd_invalid"));
    let body = pick.item.body;
    if (!pick.translated) body = `${body}\n${t(lang, "translation_pending")}`;
    body = `${body}\n${t(lang, "answer_source", { title: pick.item.title })}`;
    await db.query(`INSERT INTO messages (user_id, direction, channel, kind, body, topic) VALUES ($1,'in','ussd','text',$2,$3)`, [user.id, `[USSD topic: ${pick.item.id}]`, pick.item.topic]);
    await sendToUser(db, user, body, pick.item.id, null, { contentVersionId: pick.item.versionId });
    const short = pick.item.body.length > 110 ? `${pick.item.body.slice(0, 107).trimEnd()}…` : pick.item.body;
    return end(`${short}\n${t(lang, "ussd_full_by_sms")}`);
  }

  // 2 Find a clinic -> service -> pass (+ details by SMS)
  if (choice === "2") {
    if (!rest.length) return con(t(lang, "ussd_services"));
    const service = SERVICE_MENU[Number(rest[0]) - 1];
    if (!service) return end(t(lang, "ussd_invalid"));
    const pass = await issuePass(db, user.id, [service]);
    if (!pass) {
      await openCase(db, user, "asked_for_person", false, `USSD: needs ${service} but no partner clinic offers it`);
      return end(t(lang, "ussd_no_clinic"));
    }
    await say(db, user, "pass_issued", {
      code: pass.code,
      clinic: pass.clinic.name,
      area: pass.clinic.area,
      hours: pass.clinic.hours,
      free: pass.clinic.free ? t(lang, "pass_free") : "",
      days: config.passValidDays,
    });
    return end(t(lang, "ussd_pass", { code: pass.code, clinic: pass.clinic.name, area: pass.clinic.area }));
  }

  // 3 My passes
  if (choice === "3") {
    const passes = await db.query<{ code: string; expires_at: string }>(
      `SELECT code, expires_at FROM passes WHERE user_id = $1 AND expires_at > now() AND redeemed_at IS NULL ORDER BY issued_at DESC LIMIT 4`,
      [user.id],
    );
    if (!passes.length) return end(t(lang, "ussd_no_passes"));
    return end(`${t(lang, "ussd_passes")}\n${passes.map((p) => `${p.code} → ${new Date(p.expires_at).toISOString().slice(0, 10)}`).join("\n")}`);
  }

  // 4 Talk to a Dada
  if (choice === "4") {
    await shareOnRequest(db, user.id);
    await openCase(db, user, "asked_for_person", false, "Asked for a Dada on USSD");
    return end(t(lang, "ussd_dada"));
  }

  // 5 Urgent help now: always a human, at once.
  if (choice === "5") {
    if (!rest.length) return con(t(lang, "ussd_urgent_menu"));
    const u = URGENT[rest[0]];
    if (!u) return end(t(lang, "ussd_invalid"));
    await db.query(`INSERT INTO messages (user_id, direction, channel, kind, body, danger) VALUES ($1,'in','ussd','text',$2,$3)`, [user.id, `[USSD urgent help: ${u.reason}]`, u.reason.replace("danger_", "")]);
    await openCase(db, user, u.reason, true, `USSD urgent help: ${u.reason.replace("danger_", "")}`);
    if (u.reason === "danger_medical") {
      const pass = await issuePass(db, user.id, u.services, true);
      if (pass) await say(db, user, "urgent_medical", { code: pass.code, clinic: pass.clinic.name, area: pass.clinic.area });
      else await say(db, user, "urgent_safety");
    } else await say(db, user, u.reason === "danger_safety" ? "urgent_safety" : "urgent_selfharm");
    return end(t(lang, "ussd_urgent_done"));
  }

  // 6 Language
  if (choice === "6") {
    if (!rest.length) return con(t(lang, "ussd_language"));
    const next = LANGUAGE_MENU.find(([n]) => n === rest[0])?.[1];
    if (!next) return end(t(lang, "ussd_invalid"));
    await db.query(`UPDATE users SET language = $2 WHERE id = $1`, [user.id, next]);
    return end(t(next, "ussd_lang_saved"));
  }
  return end(t(lang, "ussd_invalid"));
}
