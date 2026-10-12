import { Router, type Request } from "express";
import type { Db } from "../db.js";
import { auditReq } from "../audit.js";
import { invalidateCaches } from "../caches.js";
import { en, LANGUAGES, TRANSLATION_LANGUAGES } from "../i18n.js";
import { csrfField } from "../security/csrf.js";
import { approveVersion, discardVersion, nextVersionNo, placeholdersOf, publishVersion, returnVersion, submitVersion, workingVersion, type TransitionResult } from "../content/workflow.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, field, select, textarea, notice, statusTag, when } from "./html.js";
import { nav } from "./nav.js";
import { actorOf, CATEGORIES } from "./content.js";

// Translation studio (every string in src/i18n.ts) and Glossary studio (coded words).
// Translations follow the same review workflow as health content.

const LANGS = TRANSLATION_LANGUAGES as readonly string[];
const back = (href: string, label: string) => `<p class="noprint"><a href="${href}">← ${esc(label)}</a></p>`;
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);

export function stringsRouter(db: Db): Router {
  const r = Router();
  const viewers = requireRole(db, ["admin", "reviewer", "editor"]);
  const writers = requireRole(db, ["admin", "editor"]);
  const reviewers = requireRole(db, ["reviewer"]);

  // ============ Translations ============

  r.get("/translations", viewers, async (req, res) => {
    const lang = LANGS.includes(String(req.query.lang)) ? String(req.query.lang) : LANGS[0];
    const show = ["missing", "review"].includes(String(req.query.show)) ? String(req.query.show) : "all";
    const rows = await db.query(`SELECT key, status, version, text FROM string_versions WHERE language = $1 AND status <> 'archived' ORDER BY version`, [lang]);
    const keys = Object.keys(en);
    const done = keys.filter((k) => rows.some((x) => x.key === k && x.status === "published")).length;
    const list = keys
      .map((k) => {
        const vs = rows.filter((x) => x.key === k);
        const pub = vs.find((x) => x.status === "published");
        const work = vs.filter((x) => x.status !== "published").at(-1);
        if (show === "missing" && pub) return "";
        if (show === "review" && work?.status !== "in_review") return "";
        return `<tr><td><a href="/staff/translations/${esc(k)}/${lang}"><code>${esc(k)}</code></a></td><td style="white-space:pre-wrap;max-width:340px">${esc(en[k])}</td>
<td style="white-space:pre-wrap;max-width:340px">${pub ? esc(pub.text) : `<span class="muted">Not translated: girls see English</span>`}</td><td>${work ? `${statusTag(work.status)} v${work.version}` : ""}</td></tr>`;
      })
      .join("");
    res.send(
      page(
        "Translations",
        `${back("/staff/content", "Content studio")}${h1("Translation", "studio", "Everything Ubah says")}${notice(req.query)}
<p class="lead">Native speakers translate each message; a reviewer who speaks the language approves it; then it is published. Keep every {placeholder} exactly as in English.</p>
<div class="row pills" style="margin-bottom:10px">${LANGS.map((l) => `<a class="btn ${l === lang ? "" : "secondary"}" href="?lang=${l}">${esc(LANGUAGES[l])}</a>`).join("")}</div>
<div class="row pills" style="margin-bottom:16px">${[["all", "All"], ["missing", "Not yet published"], ["review", "In review"]].map(([v, l]) => `<a class="btn ${show === v ? "" : "secondary"}" href="?lang=${lang}&show=${v}">${l}</a>`).join("")}<span class="muted">${done} of ${keys.length} published in ${esc(LANGUAGES[lang])}</span></div>
<div class="card"><div class="scroll"><table><thead><tr><th>Key</th><th>English</th><th>Published ${esc(LANGUAGES[lang])}</th><th>Working on</th></tr></thead><tbody>${list || `<tr><td colspan="4">Nothing here.</td></tr>`}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  const stringPage = async (req: Request, key: string, lang: string, error = "") => {
    const me = staffOf(req);
    const versions = await db.query(
      `SELECT v.*, a.name AS author FROM string_versions v LEFT JOIN staff a ON a.id = v.author_id WHERE key = $1 AND language = $2 ORDER BY version DESC`,
      [key, lang],
    );
    const pub = versions.find((v) => v.status === "published");
    const work = versions.find((v) => ["draft", "in_review", "approved"].includes(v.status));
    const writer = me.role === "admin" || me.role === "editor";
    const act = (id: number, action: string, label: string, cls = "secondary") =>
      `<form method="post" action="/staff/translations/versions/${id}/${action}" style="display:inline">${csrfField(req)}<button class="${cls}">${esc(label)}</button></form>`;
    let workBlock = "";
    if (work) {
      const actions: string[] = [];
      if (work.status === "draft" && writer) actions.push(act(work.id, "submit", "Send for review", "accent"), act(work.id, "discard", "Discard draft"));
      if (work.status === "in_review" && me.role === "reviewer") {
        actions.push(
          work.author_id === me.id ? `<span class="muted">You wrote this, so another reviewer must approve it.</span>` : act(work.id, "approve", "Approve", "accent"),
          `<form method="post" action="/staff/translations/versions/${work.id}/return" class="card" style="margin:12px 0 0">${csrfField(req)}${textarea("Send back with a note", "note", "", { rows: 2, required: true })}<p><button class="secondary">Send back</button></p></form>`,
        );
      }
      if (work.status === "approved" && writer) actions.push(act(work.id, "publish", "Publish", "accent"));
      workBlock = `<div class="card"><p>${statusTag(work.status)} v${work.version} by ${esc(work.author ?? "—")}${work.reviewer_name ? ` · approved by ${esc(work.reviewer_name)}` : ""}</p>${work.review_note ? `<div class="notice">Reviewer's note: ${esc(work.review_note)}</div>` : ""}
<p style="white-space:pre-wrap;font-size:17px">${esc(work.text)}</p><div class="row">${actions.join("")}</div></div>`;
    }
    const form =
      writer && (!work || work.status === "draft")
        ? `<form method="post" action="/staff/translations/${esc(key)}/${lang}" class="card">${csrfField(req)}${textarea(`${LANGUAGES[lang]} translation`, "text", work?.text ?? pub?.text ?? "", { rows: 5, required: true, hint: `Keep these exactly: ${placeholdersOf(en[key]).join(" ") || "(none)"}` })}
<p class="row"><button class="accent" name="step" value="save">Save draft</button><button class="secondary" name="step" value="submit">Save and send for review</button></p></form>`
        : "";
    return page(
      `${key} · ${LANGUAGES[lang]}`,
      `${back(`/staff/translations?lang=${lang}`, "Translations")}${h1(key, `· ${LANGUAGES[lang]}`, "Translation")}${notice(req.query)}${error ? `<div class="notice" role="alert">${esc(error)}</div>` : ""}
<div class="cols"><div class="card" style="margin:0"><div class="eyebrow">English</div><p style="white-space:pre-wrap;font-size:17px">${esc(en[key])}</p></div>
<div class="card" style="margin:0"><div class="eyebrow">Published ${esc(LANGUAGES[lang])}</div>${pub ? `<p style="white-space:pre-wrap;font-size:17px">${esc(pub.text)}</p><p class="muted">v${pub.version} · approved by ${esc(pub.reviewer_name ?? "—")} · ${when(pub.published_at)}</p>` : `<p class="muted">Not published yet: girls see the English text.</p>`}</div></div>
${workBlock}${form}
<div class="card"><h2>History</h2><ul class="timeline">${versions.map((v) => `<li>${statusTag(v.status)} v${v.version} by ${esc(v.author ?? "—")}<time>${when(v.created_at)}${v.reviewer_name ? ` · reviewed by ${esc(v.reviewer_name)}` : ""}</time></li>`).join("") || "<li class=muted>No versions yet.</li>"}</ul></div>`,
      nav(req),
    );
  };

  const validKey = (req: Request) => {
    const key = String(req.params.key);
    const lang = String(req.params.lang);
    return key in en && LANGS.includes(lang) ? { key, lang } : null;
  };

  r.get("/translations/:key/:lang", viewers, async (req, res) => {
    const k = validKey(req);
    if (!k) return res.status(404).send(page("Not found", "Not found.", nav(req)));
    res.send(await stringPage(req, k.key, k.lang));
  });

  r.post("/translations/:key/:lang", writers, async (req, res) => {
    const k = validKey(req);
    if (!k) return res.status(404).send("Not found");
    const value = text(req.body.text, 2000);
    if (!value) return res.send(await stringPage(req, k.key, k.lang, "The translation can't be empty."));
    // Every {placeholder} must survive translation, or the message breaks.
    if (placeholdersOf(value).join() !== placeholdersOf(en[k.key]).join()) {
      return res.send(await stringPage(req, k.key, k.lang, `Keep every placeholder exactly as in English: ${placeholdersOf(en[k.key]).join(" ") || "(none)"}`));
    }
    const work = await workingVersion(db, "string_versions", k.key, k.lang);
    if (work && work.status !== "draft") return res.redirect(`/staff/translations/${k.key}/${k.lang}?error=state`);
    const me = staffOf(req).id;
    let id: number;
    if (work) {
      await db.query(`UPDATE string_versions SET text = $2, author_id = $3 WHERE id = $1 AND status = 'draft'`, [work.id, value, me]);
      id = work.id;
    } else {
      const [row] = await db.query<{ id: number }>(`INSERT INTO string_versions (key, language, version, text, author_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [
        k.key,
        k.lang,
        await nextVersionNo(db, "string_versions", k.key, k.lang),
        value,
        me,
      ]);
      id = row.id;
    }
    await auditReq(db, req, { action: "translation.save_draft", targetType: "string_version", targetId: id, details: { key: k.key, lang: k.lang } });
    if (req.body.step === "submit") {
      await submitVersion(db, "string_versions", id);
      await auditReq(db, req, { action: "translation.submit", targetType: "string_version", targetId: id });
      return res.redirect(`/staff/translations/${k.key}/${k.lang}?done=submitted`);
    }
    res.redirect(`/staff/translations/${k.key}/${k.lang}?done=saved`);
  });

  const transition = (action: string, roles: typeof writers, run: (id: number, req: Request) => Promise<TransitionResult>) =>
    r.post(`/translations/versions/:id/${action}`, roles, async (req, res) => {
      const id = Number(req.params.id);
      const [v] = Number.isInteger(id) ? await db.query(`SELECT key, language FROM string_versions WHERE id = $1`, [id]) : [];
      if (!v) return res.status(404).send("Not found");
      const result = await run(id, req);
      const to = `/staff/translations/${v.key}/${v.language}`;
      if (result !== "ok") return res.redirect(`${to}?error=${result}`);
      await auditReq(db, req, { action: `translation.${action}`, targetType: "string_version", targetId: id });
      if (action === "publish") invalidateCaches();
      res.redirect(`${to}?done=${{ submit: "submitted", approve: "approved", return: "returned", publish: "published", discard: "saved" }[action]}`);
    });
  transition("submit", writers, (id) => submitVersion(db, "string_versions", id));
  transition("discard", writers, (id) => discardVersion(db, "string_versions", id));
  transition("approve", reviewers, async (id, req) => approveVersion(db, "string_versions", id, await actorOf(db, req)));
  transition("return", reviewers, async (id, req) => {
    const note = text(req.body.note, 2000);
    return note ? returnVersion(db, "string_versions", id, await actorOf(db, req), note) : "state";
  });
  transition("publish", writers, async (id, req) => publishVersion(db, "string_versions", id, await actorOf(db, req)));

  // ============ Glossary ============

  r.get("/glossary", viewers, async (req, res) => {
    const me = staffOf(req);
    const lang = String(req.query.lang ?? "") in LANGUAGES ? String(req.query.lang) : "";
    const rows = await db.query(
      `SELECT g.*, v.name AS verifier FROM glossary_terms g LEFT JOIN staff v ON v.id = g.verified_by WHERE ($1 = '' OR g.language = $1) ORDER BY g.active DESC, g.language, lower(g.term)`,
      [lang],
    );
    const canEdit = me.role === "admin" || me.role === "editor";
    const canVerify = me.role === "admin" || me.role === "reviewer";
    const topics = Object.entries(CATEGORIES);
    const list = rows
      .map((g) => {
        const btn = (action: string, label: string, cls = "secondary") => `<button class="${cls} small" name="action" value="${action}">${label}</button>`;
        return `<details class="card" style="margin:0 0 10px${g.active ? "" : ";opacity:.55"}"><summary><span><strong>${esc(g.term)}</strong> → ${esc(g.means)} <span class="muted">· ${esc(LANGUAGES[g.language] ?? g.language)} · ${esc(CATEGORIES[g.topic] ?? g.topic)}</span> ${g.verified ? `<span class="tag ok">Verified by ${esc(g.verifier ?? "—")}</span>` : `<span class="tag">Not verified</span>`}${g.active ? "" : " (removed)"}</span></summary>
<form method="post" action="/staff/glossary/${g.id}">${csrfField(req)}${canEdit ? `<div class="fields">${field("Word or phrase", "term", g.term, { required: true })}${field("Plain meaning", "means", g.means, { required: true })}${select("Language", "language", Object.entries(LANGUAGES), g.language)}${select("Topic", "topic", topics, g.topic)}${field("Notes (where it was heard, by whom)", "notes", g.notes)}</div>` : g.notes ? `<p class="muted">${esc(g.notes)}</p>` : ""}
<div class="row">${canEdit ? btn("save", "Save", "") : ""}${canVerify ? (g.verified ? btn("unverify", "Mark not verified") : btn("verify", "Verify: confirmed in community sessions")) : ""}${canEdit ? (g.active ? btn("remove", "Remove", "danger") : btn("restore", "Restore")) : ""}</div></form></details>`;
      })
      .join("");
    res.send(
      page(
        "Glossary",
        `${back("/staff/content", "Content studio")}${h1("Glossary", "of coded words", "What girls really say")}${notice(req.query)}
<p class="lead">Euphemisms and coded words, mapped to their plain meaning so Ubah doesn't miss a concern. Collect them in community sessions; a reviewer verifies each one. Editing a term clears its verification.</p>
<div class="row pills" style="margin-bottom:16px"><a class="btn ${lang ? "secondary" : ""}" href="/staff/glossary">All languages</a>${Object.entries(LANGUAGES).map(([l, n]) => `<a class="btn ${l === lang ? "" : "secondary"}" href="?lang=${l}">${esc(n)}</a>`).join("")}</div>
${list || `<div class="card muted">No terms yet.</div>`}
${canEdit ? `<form method="post" action="/staff/glossary" class="card">${csrfField(req)}<h2>Add a term</h2><div class="fields">${field("Word or phrase", "term", "", { required: true })}${field("Plain meaning", "means", "", { required: true })}${select("Language", "language", Object.entries(LANGUAGES), lang || "so")}${select("Topic", "topic", topics, "periods")}${field("Notes (where it was heard, by whom)", "notes", "")}</div><p><button class="accent">Add term</button></p></form>` : ""}`,
        nav(req),
      ),
    );
  });

  const readTerm = (req: Request) => {
    const term = text(req.body.term, 80).toLowerCase();
    const means = text(req.body.means, 200);
    const language = String(req.body.language ?? "");
    const topic = String(req.body.topic ?? "");
    if (!term || !means || !(language in LANGUAGES) || !(topic in CATEGORIES)) return null;
    return { term, means, language, topic, notes: text(req.body.notes, 500) };
  };

  r.post("/glossary", writers, async (req, res) => {
    const g = readTerm(req);
    if (!g) return res.redirect("/staff/glossary?error=invalid");
    const rows = await db.query<{ id: number }>(
      `INSERT INTO glossary_terms (term, language, means, topic, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
      [g.term, g.language, g.means, g.topic, g.notes, staffOf(req).id],
    );
    if (!rows.length) return res.redirect("/staff/glossary?error=exists");
    invalidateCaches();
    await auditReq(db, req, { action: "glossary.add", targetType: "glossary", targetId: rows[0].id });
    res.redirect(`/staff/glossary?lang=${g.language}&done=created`);
  });

  r.post("/glossary/:id", viewers, async (req, res) => {
    const id = Number(req.params.id);
    const [g] = Number.isInteger(id) ? await db.query(`SELECT id, language FROM glossary_terms WHERE id = $1`, [id]) : [];
    if (!g) return res.status(404).send("Not found");
    const me = staffOf(req);
    const action = String(req.body.action ?? "");
    const canEdit = me.role === "admin" || me.role === "editor";
    const canVerify = me.role === "admin" || me.role === "reviewer";
    if (action === "save" && canEdit) {
      const b = readTerm(req);
      if (!b) return res.redirect("/staff/glossary?error=invalid");
      try {
        await db.query(`UPDATE glossary_terms SET term=$2, means=$3, language=$4, topic=$5, notes=$6, verified=FALSE, verified_by=NULL, verified_at=NULL WHERE id=$1`, [g.id, b.term, b.means, b.language, b.topic, b.notes]);
      } catch {
        return res.redirect("/staff/glossary?error=exists");
      }
    } else if (action === "verify" && canVerify) await db.query(`UPDATE glossary_terms SET verified = TRUE, verified_by = $2, verified_at = now() WHERE id = $1`, [g.id, me.id]);
    else if (action === "unverify" && canVerify) await db.query(`UPDATE glossary_terms SET verified = FALSE, verified_by = NULL, verified_at = NULL WHERE id = $1`, [g.id]);
    else if ((action === "remove" || action === "restore") && canEdit) await db.query(`UPDATE glossary_terms SET active = $2 WHERE id = $1`, [g.id, action === "restore"]);
    else return res.status(403).send(page("Not allowed", "You can't do that.", nav(req)));
    invalidateCaches();
    await auditReq(db, req, { action: `glossary.${action}`, targetType: "glossary", targetId: g.id });
    res.redirect(`/staff/glossary?lang=${g.language}&done=saved`);
  });

  return r;
}
