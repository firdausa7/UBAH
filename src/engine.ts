import type { Db } from "./db.js";
import { config } from "./config.js";
import { encryptPhone, hashPhone, newAnonId } from "./privacy.js";
import { t, languageMenu, hasTranslation } from "./i18n.js";
import { analyse, analyseBoth, type Analysis } from "./ml/models.js";
import { expandCodedTerms } from "./ml/glossary.js";
import { looksEnglish } from "./ml/text.js";
import { search, localize } from "./content/content.js";
import { nearestClinics, matchPlace, type ClinicPlace } from "./location.js";
import { transcribe, type MockVoice } from "./providers/speech.js";
import { toEnglish, type Translation } from "./providers/translation.js";
import { consents, assignedWorkerId, setConsents, shareOnRequest } from "./auth/access.js";
import { saveVoiceNote } from "./voice/store.js";
import { eraseGirl } from "./erase.js";
import { issuePass, SERVICE_MENU, TOPIC_SERVICES } from "./referrals.js";
import { sendToUser, alertStaff, flushPending, type UserRow } from "./channels/outbound.js";
import { log } from "./log.js";
import { refreshCaches } from "./caches.js";
import { caseBus, caseEvent, levelFor, type CaseSignal } from "./cases.js";
import { clinicRatings } from "./ratings.js";

// The conversation engine: one function that handles every incoming message,
// from any channel (WhatsApp, SMS, simulator).

export interface Incoming {
  channel: "whatsapp" | "sms" | "simulator" | "app" | "web";
  from: string; // phone number (never stored in clear); "" for a signed-in web girl
  userId?: number; // a girl signed in on the web: already known, no phone lookup
  text?: string;
  voice?: { audio: Buffer; mimeType: string } & MockVoice;
  // A shared WhatsApp location. Used once to find the nearest clinic, never stored.
  location?: { lat: number; lng: number; name?: string; address?: string };
}

type Step = "language" | "share_messages" | "free" | "after_answer" | "choose_services" | "checkin_visited" | "checkin_clinic" | "checkin_respect";
interface State {
  step: Step;
  lastServices?: string[];
  lastTopic?: string | null;
  checkinId?: number;
  passCode?: string;
  clinicOptions?: number[];
}

export async function getOrCreateUser(db: Db, msg: Pick<Incoming, "channel" | "from">): Promise<{ user: UserRow; isNew: boolean }> {
  const hash = hashPhone(msg.from);
  const wa = msg.channel === "whatsapp";
  const [existing] = await db.query<UserRow>(
    `UPDATE users SET last_seen_at = now(), channel = $2, wa_last_inbound_at = CASE WHEN $3 THEN now() ELSE wa_last_inbound_at END WHERE phone_hash = $1 RETURNING *`,
    [hash, msg.channel, wa],
  );
  if (existing) return { user: existing, isNew: false };
  let anon = newAnonId();
  while ((await db.query(`SELECT 1 FROM users WHERE anon_id = $1`, [anon])).length) anon = newAnonId();
  const [user] = await db.query<UserRow>(
    `INSERT INTO users (anon_id, phone_hash, phone_enc, channel, state, wa_last_inbound_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $6 THEN now() END) RETURNING *`,
    [anon, hash, encryptPhone(msg.from), msg.channel, JSON.stringify({ step: "language" }), wa],
  );
  return { user, isNew: true };
}

export async function setState(db: Db, user: UserRow, state: State) {
  user.state = state;
  await db.query(`UPDATE users SET state = $2 WHERE id = $1`, [user.id, JSON.stringify(state)]);
}

export const say = async (db: Db, user: UserRow, key: string, vars: Record<string, string | number> = {}): Promise<void> => {
  await sendToUser(db, user, t(user.language, key, vars));
};
const reply = async (db: Db, user: UserRow, body: string): Promise<void> => {
  await sendToUser(db, user, body);
};

export async function handleIncoming(db: Db, msg: Incoming): Promise<void> {
  await handleMessage(db, msg);
  if (msg.voice) await maybeAskVoice(db, msg);
}

// On WhatsApp and SMS she can't open settings, so she is asked once each: after choosing her
// language (her messages), and after her first voice note (her voice). The web app has its own switches.
const ASKED_ON = ["whatsapp", "sms", "simulator"];

async function shouldAskShare(db: Db, user: UserRow, channel: string): Promise<boolean> {
  if (!ASKED_ON.includes(channel) || (user as any).share_asked_at) return false;
  const [any] = await db.query(`SELECT 1 FROM consents WHERE user_id = $1 AND scope = 'messages' LIMIT 1`, [user.id]);
  return !any;
}

async function maybeAskVoice(db: Db, msg: Incoming) {
  if (!ASKED_ON.includes(msg.channel) || !msg.from) return;
  const [user] = await db.query<UserRow & { voice_asked_at: string | null }>(`SELECT * FROM users WHERE phone_hash = $1`, [hashPhone(msg.from)]);
  if (!user || user.opted_out || user.voice_asked_at || user.state?.step === "language" || user.state?.step === "share_messages") return;
  const [any] = await db.query(`SELECT 1 FROM consents WHERE user_id = $1 AND scope = 'voice' LIMIT 1`, [user.id]);
  await db.query(`UPDATE users SET voice_asked_at = now() WHERE id = $1`, [user.id]);
  if (!any) await say(db, user, "voice_question");
}

async function handleMessage(db: Db, msg: Incoming): Promise<void> {
  await refreshCaches(db); // published content, translations and glossary
  const { user, isNew } = msg.userId ? await webUser(db, msg.userId) : await getOrCreateUser(db, msg);
  // Her WhatsApp window just opened: first deliver anything held for her.
  if (msg.channel === "whatsapp" && !isNew) await flushPending(db, user);

  if (msg.location) {
    await logIn(db, user, msg.channel, "location", "[shared a location]", null);
    return suggestNearest(db, user, { lat: msg.location.lat, lng: msg.location.lng });
  }

  // Voice note -> text (Somali speech model in the pilot).
  let text = (msg.text ?? "").trim();
  let kind = "text";
  let voice: VoiceInfo | null = null;
  // Her voice is kept for her health worker only if she agreed to share it, so they can listen
  // when the transcript is unclear.
  let audioRef: number | null = null;
  if (msg.voice) {
    kind = "voice";
    if (msg.voice.audio.length > 0 && !isNew && (await consents(db, user.id)).voice) {
      audioRef = await saveVoiceNote(db, user.id, msg.voice.mimeType, msg.voice.audio);
    }
    const tr = await transcribe(msg.voice.audio, msg.voice.mimeType, user.language, msg.voice);
    voice = {
      detected: tr.language,
      confidence: tr.confidence,
      // Her choice and the model's guess disagree: keep both and show the worker.
      mismatch: Boolean(tr.language && user.language && tr.language !== user.language),
      unclear: !tr.ok || (tr.confidence !== null && tr.confidence < config.stt.minConfidence),
    };
    if (!tr.ok) {
      await logIn(db, user, msg.channel, "voice", "[voice note: not understood]", null, { voice, english: null, audioRef });
      if (!isNew) await flagUnclearVoice(db, user, "");
      return say(db, user, "voice_failed");
    }
    text = tr.text;
  }

  // Into English, for her health worker and for the second danger check. The whole text is translated
  // (nothing dropped), and the original is kept. When the speech model heard another language than
  // the one she chose, the provider detects it instead of trusting her choice.
  const words = /\p{L}{3,}/u.test(text) && !/^(STOP|DELETE|HELP|MENU|DADA|SHARE|VOICE|PRIVATE)$/i.test(text.trim());
  const english = words ? await toEnglish(text, user.language, voice?.mismatch ?? false) : null;
  const meta: InboundMeta = { voice, english, audioRef };

  // SAFETY: a danger sign always reaches a human, whatever step she is on (even her very first
  // message, or in the middle of a check-in). Plain numbers and commands are menu answers, not text.
  if (words) {
    const early = analyseBoth(text, user.language, english);
    if (early.danger !== "none") {
      if (user.opted_out) await db.query(`UPDATE users SET opted_out = FALSE WHERE id = $1`, [user.id]);
      user.opted_out = false;
      await logIn(db, user, msg.channel, kind, text, early, meta);
      return handleDanger(db, user, early, text);
    }
  }

  if (isNew || user.opted_out) {
    if (user.opted_out) await db.query(`UPDATE users SET opted_out = FALSE WHERE id = $1`, [user.id]);
    user.opted_out = false;
    await logIn(db, user, msg.channel, kind, text, null, meta);
    await setState(db, user, { step: "language" });
    return say(db, user, "welcome");
  }

  // A voice note we heard poorly (no danger sign in it): don't act on a guess, and never on a
  // command like DELETE. A worker is told; she is gently asked to try again or type.
  if (voice?.unclear) {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    await flagUnclearVoice(db, user, text);
    return say(db, user, "voice_failed");
  }

  // Commands that work at any time.
  const cmd = text.toUpperCase();
  if (cmd === "STOP") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    await say(db, user, "stopped");
    await db.query(`UPDATE users SET opted_out = TRUE WHERE id = $1`, [user.id]);
    await db.query(`DELETE FROM pending_outbound WHERE user_id = $1`, [user.id]);
    return;
  }
  // "NEAR <area or landmark>": find the nearest partner clinic.
  const near = text.match(/^\s*(NEAR|KARIIB|KARIBU|DHIYOO)\s+(.{2,80})$/i);
  if (near) {
    await logIn(db, user, msg.channel, kind, "[asked for the nearest clinic]", null, meta);
    return suggestNearest(db, user, { text: near[2] });
  }
  if (cmd === "DELETE") {
    // Deletes her messages, passes, check-ins and cases; keeps nothing that links back to her.
    await say(db, user, "deleted");
    await eraseGirl(db, user);
    return;
  }
  // What her health worker may see: SHARE, VOICE, PRIVATE (any time, on any channel).
  if (cmd === "SHARE" || cmd === "VOICE" || cmd === "PRIVATE") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    await setConsents(db, user.id, cmd === "SHARE" ? { messages: true } : cmd === "VOICE" ? { voice: true } : { messages: false, voice: false }, { explicit: true });
    if (user.state?.step === "share_messages") await setState(db, user, { step: "free" });
    return say(db, user, cmd === "SHARE" ? "share_yes" : cmd === "VOICE" ? "voice_on" : "private_on");
  }
  if (cmd === "HELP") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    return say(db, user, "help");
  }
  if (cmd === "MENU") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    await setState(db, user, { step: "language" });
    return say(db, user, "welcome");
  }

  const state: State = user.state?.step ? user.state : { step: "language" };

  // Check-in replies are numbers only: don't run them through the classifiers.
  if (state.step === "language") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    const lang = languageMenu().find(([n, code]) => n === text || code === text.toLowerCase())?.[1];
    if (!lang) return say(db, user, "welcome");
    user.language = lang;
    await db.query(`UPDATE users SET language = $2 WHERE id = $1`, [user.id, lang]);
    if (await shouldAskShare(db, user, msg.channel)) {
      await db.query(`UPDATE users SET share_asked_at = now() WHERE id = $1`, [user.id]);
      await setState(db, user, { step: "share_messages" });
      await say(db, user, "language_set");
      return say(db, user, "share_question");
    }
    await setState(db, user, { step: "free" });
    return say(db, user, "language_set");
  }
  // Her answer to the sharing question. Anything else is her first question: she is not asked again,
  // and her messages stay private (no answer means no).
  if (state.step === "share_messages") {
    await setState(db, user, { step: "free" });
    if (text === "1" || text === "2") {
      await logIn(db, user, msg.channel, kind, text, null, meta);
      await setConsents(db, user.id, { messages: text === "1" }, { explicit: true });
      return say(db, user, text === "1" ? "share_yes" : "share_no");
    }
  }
  if (state.step === "checkin_visited" || state.step === "checkin_clinic" || state.step === "checkin_respect") {
    await logIn(db, user, msg.channel, kind, text, null, meta);
    return handleCheckinReply(db, user, state, text);
  }

  // Free text: understand it first.
  const a = analyse(text, user.language);
  await logIn(db, user, msg.channel, kind, text, a, meta);

  if (a.danger !== "none") return handleDanger(db, user, a, text);

  if (cmd === "DADA" || /\b(talk to (a )?(dada|person|human|nurse))\b/i.test(text)) return requestDada(db, user, text);

  if (state.step === "after_answer" && /^[123]$/.test(text)) {
    if (text === "1") return findCare(db, user, state.lastServices ?? [], state);
    if (text === "2") return requestDada(db, user, "Asked to talk to a Dada");
    await setState(db, user, { step: "free" });
    return say(db, user, "language_set");
  }
  if (state.step === "choose_services") {
    const picks = [...new Set(text.match(/[1-6]/g) ?? [])].map((n) => SERVICE_MENU[Number(n) - 1]);
    if (picks.length === 0) return say(db, user, "invalid_choice", { prompt: t(user.language, "choose_services") });
    return issueAndSend(db, user, picks);
  }

  // English answers are found through a real translation. Without one (no key, e.g. the online test
  // version) her own words are used only if they look like English: the mock just labels her words,
  // and Somali read as English goes wrong ("way" matched "ways to prevent pregnancy").
  const realEnglish = meta.english?.ok && meta.english.provider !== "none" && meta.english.provider !== "mock" ? meta.english.text : null;
  const searchEnglish = realEnglish ?? (looksEnglish(text) ? text : null);
  return answerQuestion(db, user, a, text, searchEnglish);
}

interface InboundMeta {
  voice: VoiceInfo | null;
  english: Translation | null;
  audioRef: number | null;
}

// A girl signed in on the web. Replies to a web message stay on the web, so her channel is set for
// this message only: her WhatsApp or SMS girl keeps getting check-ins where she reads them.
async function webUser(db: Db, userId: number): Promise<{ user: UserRow; isNew: boolean }> {
  const [user] = await db.query<UserRow>(`UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING *`, [userId]);
  if (!user) throw Object.assign(new Error("no such girl"), { status: 404 });
  return { user: { ...user, channel: "web" }, isNew: false };
}

interface VoiceInfo {
  detected: string | null;
  confidence: number | null;
  mismatch: boolean;
  unclear: boolean;
}

async function logIn(db: Db, user: UserRow, channel: string, kind: string, body: string, a: Analysis | null, meta: InboundMeta = { voice: null, english: null, audioRef: null }) {
  const { voice, english, audioRef } = meta;
  const urgent = Boolean(a && a.danger !== "none");
  const reason = !urgent || !a ? null : `${a.dangerSource}${a.dangerWord ? `:${a.dangerWord.language}:${a.dangerWord.phrase}` : ""}${a.dangerFromEnglish ? " (in the English translation)" : ""}`;
  await db.query(
    `INSERT INTO messages (user_id, direction, channel, kind, body, original_text, chosen_language, urgent, urgent_reason, topic, danger, coded_terms,
                           detected_language, stt_confidence, language_mismatch, voice_unclear, english_text, english_source, translation_failed, audio_ref)
     VALUES ($1,'in',$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      user.id, channel, kind, body || "[empty]", user.language ?? null, urgent, reason, a?.topic ?? null, a?.danger ?? null, a?.codedTerms ?? [],
      voice?.detected ?? null, voice?.confidence ?? null, voice?.mismatch ?? false, voice?.unclear ?? false,
      english?.ok ? english.text : null, english?.ok ? (english.provider === "none" ? "none" : "machine") : null, english ? !english.ok : false, audioRef,
    ],
  );
}

// One open "audio unclear" case per girl at a time: repeated tries add to it, they don't flood the inbox.
async function flagUnclearVoice(db: Db, user: UserRow, partial: string) {
  // Only if she shares her messages: an unclear note isn't a danger sign, so her choice holds.
  // (She is asked to try again or type either way, and a danger word in it is urgent regardless.)
  if (!(await consents(db, user.id)).messages) return;
  const [open] = await db.query(`SELECT id FROM cases WHERE user_id = $1 AND status = 'open' LIMIT 1`, [user.id]);
  if (open) return;
  await openCase(db, user, "voice_unclear", false, partial ? `Heard (unsure): ${partial}` : "Voice note could not be transcribed");
}

const MIN_ANSWER_SCORE = 2;

async function answerQuestion(db: Db, user: UserRow, a: Analysis, _question: string, english: string | null) {
  const lang = user.language ?? "en";
  // The topic models are trained on English: for her words in another language, read the translation.
  const topic = lang !== "en" && english ? (analyse(english, "en").topic ?? a.topic) : a.topic;
  const hits = search(a.text, { topic: topic ?? undefined, lang, english: english ? expandCodedTerms(english).text : null, ageBand: (user as any).age_band });
  // A weak match is "I'm not sure, talk to a Dada", never a guess. On the 84 labelled questions in
  // data/seed/topic.jsonl (with the topic boost; optimistic, as the topic model learnt from them):
  // at 1, 6 answers come from the wrong topic; at 2, 5, with no right answer lost. Danger signs
  // never get here: they are urgent first. A person is safe; a wrong health answer is not.
  if (hits.length === 0 || hits[0].score < MIN_ANSWER_SCORE) {
    await setState(db, user, { step: "after_answer", lastServices: [], lastTopic: a.topic });
    return say(db, user, "dont_know");
  }
  const best = hits[0].item;
  // The approved version in her language if one is published, else the English one (with a note).
  const { item, translated } = localize(best, lang);
  // The approved text itself, word for word: no machine ever writes or rephrases health advice.
  let body = item.body;
  if (!translated) body = `${body}\n${t(lang, "translation_pending")}`;
  // Citation: which approved topic this answer came from.
  body = `${body}\n${t(lang, "answer_source", { title: item.title })}\n${t(lang, "answer_not_advice")}`;
  const services = best.services.length ? best.services : TOPIC_SERVICES[best.topic] ?? [];
  await sendToUser(db, user, body, item.id, null, { contentVersionId: item.versionId, audioMediaId: translated ? item.audioMediaId : null });
  await setState(db, user, { step: "after_answer", lastServices: services, lastTopic: best.topic });
  return say(db, user, "answer_menu");
}

async function findCare(db: Db, user: UserRow, services: string[], _state: State) {
  if (services.length === 0) {
    await setState(db, user, { step: "choose_services" });
    return say(db, user, "choose_services");
  }
  return issueAndSend(db, user, services);
}

export async function issueAndSend(db: Db, user: UserRow, services: string[]) {
  const pass = await issuePass(db, user.id, services);
  await setState(db, user, { step: "free" });
  if (!pass) {
    await openCase(db, user, "asked_for_person", false, `Needs ${services.join(", ")} but no partner clinic offers it`);
    return say(db, user, "no_clinic");
  }
  await say(db, user, "pass_issued", {
    code: pass.code,
    clinic: pass.clinic.name,
    area: pass.clinic.area,
    hours: pass.clinic.hours,
    free: pass.clinic.free ? t(user.language, "pass_free") : "",
    days: config.passValidDays,
  });
  const rating = (await clinicRatings(db)).get(pass.clinic.id);
  if (rating) await say(db, user, "clinic_rating", { yes: rating.respectful, total: rating.total });
  await say(db, user, "checkin_scheduled");
  // Only offer "find a nearer clinic" when we know where clinics are.
  const [{ n }] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM clinics WHERE active AND (lat IS NOT NULL OR cardinality(landmarks) > 0)`);
  if (n > 0 && !user.area) await say(db, user, "near_hint");
}

// Nearest partner clinic for her last needed services, from a shared location or a typed area/landmark.
// Coordinates are used once and never stored; only the matched area name and site are kept.
async function suggestNearest(db: Db, user: UserRow, where: { lat: number; lng: number } | { text: string }) {
  const state: State = user.state?.step ? user.state : { step: "free" };
  const [lastPass] = await db.query<{ services: string[] }>(`SELECT services FROM passes WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 1`, [user.id]);
  const services = state.lastServices?.length ? state.lastServices : lastPass?.services ?? [];
  const clinics = await db.query<ClinicPlace>(`SELECT c.id, c.name, c.area, c.hours, c.services, c.lat, c.lng, c.landmarks, c.site_id, s.name AS site FROM clinics c LEFT JOIN sites s ON s.id = c.site_id WHERE c.active`);
  let origin: { lat: number; lng: number } | null = "lat" in where ? where : null;
  let placeName: string | null = null;
  let preferId: number | undefined;
  if (!origin && "text" in where) {
    const place = matchPlace(clinics, where.text);
    if (!place) return say(db, user, "near_not_found");
    origin = place.point;
    placeName = place.name;
    preferId = place.clinicId;
  }
  const near = nearestClinics(clinics, origin, services, preferId).slice(0, 2);
  if (!near.length) return say(db, user, "near_none");
  const top = near[0];
  await db.query(`UPDATE users SET site_id = COALESCE($2, site_id), area = COALESCE($3, area) WHERE id = $1`, [user.id, top.clinic.site_id, placeName ?? top.clinic.area]);
  const lines = near.map((x) => t(user.language, "near_clinic", { clinic: x.clinic.name, area: x.clinic.area, hours: x.clinic.hours, km: x.km == null ? "?" : x.km < 1 ? "<1" : String(Math.round(x.km)) }));
  return reply(db, user, `${t(user.language, "near_intro")}\n${lines.join("\n")}`);
}

async function requestDada(db: Db, user: UserRow, text: string) {
  await shareOnRequest(db, user.id);
  await openCase(db, user, "asked_for_person", false, text);
  await setState(db, user, { step: "free" });
  return say(db, user, "dada_requested");
}

const DRAFTS: Record<string, string> = {
  danger_medical: "Please go to the clinic now and show your pass. Is someone able to go with you?",
  danger_safety: "Thank you for telling us. You are not to blame. Are you somewhere safe right now?",
  danger_selfharm: "I'm here with you. Are you safe right now? Is there someone you trust nearby?",
  asked_for_person: "Hi, I'm a Dada from Ubah. How can I help you today?",
};

export async function openCase(db: Db, user: UserRow, reason: string, urgent: boolean, summary: string) {
  const level = levelFor(reason);
  // Her own health worker gets her case; nurses still see every nurse-level case.
  const worker = await assignedWorkerId(db, user.id);
  const [c] = await db.query(
    `INSERT INTO cases (user_id, reason, urgent, summary, draft_reply, level, site_id, assigned_to, assigned_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $8::int IS NULL THEN NULL ELSE now() END) RETURNING id`,
    [user.id, reason, urgent, summary.slice(0, 500), DRAFTS[reason] ?? "", level, (user as any).site_id ?? null, worker],
  );
  await caseEvent(db, c.id, null, "opened", { reason, urgent, level, ...(worker ? { assignedTo: worker } : {}) });
  caseBus.emit("case", { id: c.id, urgent, level, kind: "opened" } satisfies CaseSignal);
  if (urgent) {
    const alert = `UBAH URGENT case #${c.id} (${reason.replace("danger_", "")}), girl ${user.anon_id}. Open: ${config.baseUrl}/staff/cases/${c.id}`;
    // Failed alerts are retried by the job queue; the case is also at the top of every inbox.
    // Her own worker AND every nurse: a danger sign never waits for one person who may be offline.
    const [own] = worker ? await db.query<{ phone: string | null }>(`SELECT phone FROM staff WHERE id = $1 AND active`, [worker]) : [];
    const phones = [...new Set([...(own?.phone ? [own.phone] : []), ...config.nurseAlertNumbers])];
    for (const phone of phones) await alertStaff(db, phone, alert);
    if (config.nurseAlertNumbers.length === 0) log.warn({ caseId: c.id }, "urgent case opened but NURSE_ALERT_NUMBERS is empty (allowed only outside production)");
  }
  return c.id as number;
}

async function handleDanger(db: Db, user: UserRow, a: Analysis, text: string) {
  const reason = `danger_${a.danger}`;
  await openCase(db, user, reason, true, text);
  await setState(db, user, { step: "free" });
  if (a.danger === "medical") {
    const services = a.topic === "pregnancy" || /pregnan/i.test(a.text) ? ["antenatal", "pregnancy_test"] : ["period_care", "counselling"];
    const pass = await issuePass(db, user.id, services, true);
    if (pass) return say(db, user, "urgent_medical", { code: pass.code, clinic: pass.clinic.name, area: pass.clinic.area });
    return say(db, user, "urgent_safety");
  }
  return say(db, user, a.danger === "safety" ? "urgent_safety" : "urgent_selfharm");
}

// ---- The day-3 check-in: closes the loop and builds each clinic's dignity score ----

export type CheckinResult = "sent" | "busy" | "skipped";

// Sends one check-in. Atomic: the check-in is claimed (sent_at set) before sending,
// so the scheduled job and the safety-net sweep can never both send it.
export async function sendCheckin(db: Db, checkinId: number): Promise<CheckinResult> {
  const [row] = await db.query(
    `SELECT c.id, c.pass_code, c.user_id, c.sent_at, u.opted_out FROM checkins c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [checkinId],
  );
  if (!row || row.sent_at || row.opted_out) return "skipped";
  const [user] = await db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [row.user_id]);
  if (!user) return "skipped";
  // Don't interrupt a check-in already in progress; try again later.
  if (String(user.state?.step ?? "").startsWith("checkin_")) return "busy";
  const claimed = await db.query(`UPDATE checkins SET sent_at = now() WHERE id = $1 AND sent_at IS NULL RETURNING id`, [row.id]);
  if (claimed.length === 0) return "skipped";
  await setState(db, user, { step: "checkin_visited", checkinId: row.id, passCode: row.pass_code });
  // Marked as a check-in: outside WhatsApp's 24-hour window it goes as the approved template or by SMS.
  await sendToUser(db, user, t(user.language, "checkin_visited", { code: row.pass_code }), null, null, { kind: "checkin", checkinCode: row.pass_code });
  return "sent";
}

// Safety net (and the simulator's "skip 3 days"): send every check-in that is due.
export async function sendDueCheckins(db: Db, now = new Date()): Promise<number> {
  const due = await db.query(
    `SELECT c.id FROM checkins c JOIN users u ON u.id = c.user_id
      WHERE c.sent_at IS NULL AND c.due_at <= $1 AND NOT u.opted_out ORDER BY c.due_at LIMIT 200`,
    [now.toISOString()],
  );
  let sent = 0;
  for (const row of due) if ((await sendCheckin(db, row.id)) === "sent") sent++;
  return sent;
}

async function handleCheckinReply(db: Db, user: UserRow, state: State, text: string) {
  const id = state.checkinId!;
  if (state.step === "checkin_visited") {
    if (text === "2") {
      await db.query(`UPDATE checkins SET visited = FALSE, completed_at = now() WHERE id = $1`, [id]);
      const [p] = await db.query(`SELECT expires_at FROM passes WHERE code = $1`, [state.passCode]);
      await setState(db, user, { step: "after_answer", lastServices: [] });
      return say(db, user, "checkin_not_yet", { code: state.passCode ?? "", expires: p ? new Date(p.expires_at).toDateString() : "" });
    }
    if (text !== "1") return say(db, user, "invalid_choice", { prompt: t(user.language, "checkin_visited", { code: state.passCode ?? "" }) });
    await db.query(`UPDATE checkins SET visited = TRUE WHERE id = $1`, [id]);
    // If the clinic already scanned the pass, we know where she went. Otherwise ask.
    const [p] = await db.query(`SELECT redeemed_clinic, services FROM passes WHERE code = $1`, [state.passCode]);
    if (p?.redeemed_clinic) {
      await db.query(`UPDATE checkins SET clinic_id = $2 WHERE id = $1`, [id, p.redeemed_clinic]);
      await setState(db, user, { ...state, step: "checkin_respect" });
      return say(db, user, "checkin_respect");
    }
    const clinics = await db.query(`SELECT id, name FROM clinics WHERE active ORDER BY id LIMIT 8`);
    await setState(db, user, { ...state, step: "checkin_clinic", clinicOptions: clinics.map((c) => c.id) });
    return reply(db, user, `Which clinic did you go to?\n${clinics.map((c, i) => `${i + 1} ${c.name}`).join("\n")}`);
  }
  if (state.step === "checkin_clinic") {
    const n = Number(text);
    const clinicId = state.clinicOptions?.[n - 1];
    if (!clinicId) return reply(db, user, "Please reply with the clinic's number.");
    await db.query(`UPDATE checkins SET clinic_id = $2 WHERE id = $1`, [id, clinicId]);
    await setState(db, user, { ...state, step: "checkin_respect" });
    return say(db, user, "checkin_respect");
  }
  // checkin_respect
  const respect = ({ "1": "yes", "2": "partly", "3": "no" } as Record<string, string>)[text];
  if (!respect) return say(db, user, "invalid_choice", { prompt: t(user.language, "checkin_respect") });
  await db.query(`UPDATE checkins SET respect = $2, completed_at = now() WHERE id = $1`, [id, respect]);
  await setState(db, user, { step: "free" });
  return say(db, user, "checkin_thanks");
}

export { hasTranslation };
