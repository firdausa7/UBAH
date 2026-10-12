import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { auditReq } from "../audit.js";
import { invalidateCaches } from "../caches.js";
import { LANGUAGES } from "../i18n.js";
import { SERVICES } from "../referrals.js";
import { csrfField, csrfToken } from "../security/csrf.js";
import { approveVersion, discardVersion, nextVersionNo, publishVersion, returnVersion, submitVersion, workingVersion, type Actor, type TransitionResult } from "../content/workflow.js";
import { requireRole, staffOf } from "./auth.js";
import { page, esc, h1, field, select, checks, textarea, many, notice, statusTag, when } from "./html.js";
import { nav } from "./nav.js";
import { readAudioUpload } from "./upload.js";

// Content studio: health answers, written by editors, approved by a named health-partner reviewer,
// then published. Only published versions reach girls in production.

export const CATEGORIES: Record<string, string> = {
  periods: "Periods",
  pregnancy: "Pregnancy",
  family_planning: "Family planning",
  sti: "Infections and HIV",
  safety: "Safety and violence",
  body: "Body and growing up",
  feelings: "Feelings",
  other: "Other",
};
const LANGS = Object.keys(LANGUAGES); // so, sw, en, om
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,59}$/;
const RESERVED = new Set(["new", "review", "versions"]);

const back = (href: string, label: string) => `<p class="noprint"><a href="${href}">← ${esc(label)}</a></p>`;
const int = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const text = (v: unknown, max: number) => String(v ?? "").trim().slice(0, max);
const listOf = (v: unknown) => String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 40);

export async function actorOf(db: Db, req: Request): Promise<Actor> {
  const [s] = await db.query(`SELECT id, name, title, organisation FROM staff WHERE id = $1`, [staffOf(req).id]);
  return s;
}

export function contentRouter(db: Db): Router {
  const r = Router();
  const viewers = requireRole(db, ["admin", "reviewer", "editor"]);
  const writers = requireRole(db, ["admin", "editor"]);
  const reviewers = requireRole(db, ["reviewer"]);

  // ---- Topic list ----
  r.get("/content", viewers, async (req, res) => {
    const me = staffOf(req);
    const topics = await db.query(`SELECT * FROM content_topics ORDER BY archived, category, id`);
    const versions = await db.query(`SELECT topic_id, language, status, version FROM content_versions WHERE status <> 'archived' ORDER BY version`);
    const cell = (topicId: string, lang: string) => {
      const vs = versions.filter((v) => v.topic_id === topicId && v.language === lang);
      const pub = vs.find((v) => v.status === "published");
      const work = vs.filter((v) => v.status !== "published").at(-1);
      if (!pub && !work) return `<span class="muted">—</span>`;
      return [pub ? `${statusTag("published")} <span class="muted">v${pub.version}</span>` : "", work ? `${statusTag(work.status)} <span class="muted">v${work.version}</span>` : ""].filter(Boolean).join("<br>");
    };
    const [{ n: inReview }] = await db.query(
      `SELECT ((SELECT count(*) FROM content_versions WHERE status = 'in_review' AND author_id IS DISTINCT FROM $1) + (SELECT count(*) FROM string_versions WHERE status = 'in_review' AND author_id IS DISTINCT FROM $1))::int AS n`,
      [me.id],
    );
    const rows = topics
      .map(
        (t) => `<tr${t.archived ? ' style="opacity:.55"' : ""}><td><a href="/staff/content/${esc(t.id)}"><strong>${esc(t.id)}</strong></a><div class="muted">${esc(CATEGORIES[t.category] ?? t.category)}${t.archived ? " · archived" : ""}</div></td>${LANGS.map((l) => `<td>${cell(t.id, l)}</td>`).join("")}</tr>`,
      )
      .join("");
    res.send(
      page(
        "Content",
        `<div class="row between">${h1("Content", "studio", "Health answers")}<div class="row">${me.role !== "reviewer" ? `<a class="btn accent" href="/staff/content/new">New topic</a>` : ""}</div></div>${notice(req.query)}
<p class="lead">Every answer Ubah sends comes from here. A version reaches girls only after a named health-partner reviewer approves it and it is published.${config.allowDraftContent ? " <strong>This server also serves unpublished drafts (ALLOW_DRAFT_CONTENT=true) — never in a pilot.</strong>" : ""}</p>
<div class="row pills" style="margin-bottom:16px"><a class="btn ${inReview ? "accent" : "secondary"}" href="/staff/content/review">Review queue · ${inReview}</a><a class="btn secondary" href="/staff/translations">Translations</a><a class="btn secondary" href="/staff/glossary">Glossary</a></div>
<div class="card"><div class="scroll"><table><thead><tr><th>Topic</th>${LANGS.map((l) => `<th>${esc(LANGUAGES[l])}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="5">No topics yet.</td></tr>`}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  // ---- Review queue (content and translations) ----
  r.get("/content/review", viewers, async (req, res) => {
    const me = staffOf(req);
    const content = await db.query(
      `SELECT v.id, v.topic_id, v.language, v.version, v.title, v.submitted_at, a.name AS author, v.author_id FROM content_versions v LEFT JOIN staff a ON a.id = v.author_id WHERE v.status = 'in_review' ORDER BY v.submitted_at`,
    );
    const strings = await db.query(
      `SELECT v.id, v.key, v.language, v.version, v.text, v.submitted_at, a.name AS author, v.author_id FROM string_versions v LEFT JOIN staff a ON a.id = v.author_id WHERE v.status = 'in_review' ORDER BY v.submitted_at`,
    );
    const mine = (id: number | null) => (id === me.id ? ` <span class="tag">yours</span>` : "");
    res.send(
      page(
        "Review queue",
        `${back("/staff/content", "Content studio")}${h1("Review", "queue", "Waiting for a health-partner reviewer")}
<div class="card"><h2>Health content</h2>${
          content.length
            ? `<ul class="timeline">${content.map((v) => `<li><a href="/staff/content/versions/${v.id}">${esc(v.topic_id)} · ${esc(LANGUAGES[v.language] ?? v.language)} · v${v.version}: ${esc(v.title)}</a>${mine(v.author_id)}<time>by ${esc(v.author ?? "import")} · sent ${when(v.submitted_at)}</time></li>`).join("")}</ul>`
            : `<p class="muted">Nothing waiting.</p>`
        }</div>
<div class="card"><h2>Translations</h2>${
          strings.length
            ? `<ul class="timeline">${strings.map((v) => `<li><a href="/staff/translations/${esc(v.key)}/${esc(v.language)}">${esc(v.key)} · ${esc(LANGUAGES[v.language] ?? v.language)} · v${v.version}</a>${mine(v.author_id)}<time>by ${esc(v.author ?? "—")} · sent ${when(v.submitted_at)}</time></li>`).join("")}</ul>`
            : `<p class="muted">Nothing waiting.</p>`
        }</div>`,
        nav(req),
      ),
    );
  });

  // ---- New topic ----
  r.get("/content/new", writers, (req, res) => {
    res.send(
      page(
        "New topic",
        `${back("/staff/content", "Content studio")}${h1("New", "topic", "Content studio")}${notice(req.query)}
<form method="post" action="/staff/content" class="card">${csrfField(req)}<div class="fields">
${field("Topic id", "id", "", { required: true, hint: "Short, lower-case, with dashes, e.g. periods-pain", attrs: 'autocapitalize="none" pattern="[a-z0-9][a-z0-9-]{2,59}"' })}
${select("Category", "category", Object.entries(CATEGORIES), "", { required: true })}</div>
${checks("Clinic services this topic can refer to", "services", Object.entries(SERVICES))}
<h2 style="margin-top:18px">English draft</h2>${versionFields({})}
<p><button class="accent">Create topic as a draft</button></p></form>`,
        nav(req),
      ),
    );
  });

  r.post("/content", writers, async (req, res) => {
    const id = text(req.body.id, 60).toLowerCase();
    const category = String(req.body.category ?? "");
    const v = readVersion(req);
    if (!SLUG_RE.test(id) || RESERVED.has(id) || !(category in CATEGORIES) || !v) return res.redirect("/staff/content/new?error=invalid");
    const services = many(req.body.services).filter((s) => s in SERVICES);
    const me = staffOf(req).id;
    const created = await db.query(`INSERT INTO content_topics (id, category, services, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id`, [id, category, services, me]);
    if (!created.length) return res.redirect("/staff/content/new?error=exists");
    await db.query(`INSERT INTO content_versions (topic_id, language, version, title, body, keywords, sources, author_id) VALUES ($1,'en',1,$2,$3,$4,$5,$6)`, [
      id,
      v.title,
      v.body,
      v.keywords,
      v.sources,
      me,
    ]);
    await auditReq(db, req, { action: "content.create", targetType: "content", targetId: id });
    res.redirect(`/staff/content/${id}?done=created`);
  });

  // ---- One topic: every language side by side ----
  r.get("/content/:topic", viewers, async (req, res) => {
    const [t] = await db.query(`SELECT * FROM content_topics WHERE id = $1`, [String(req.params.topic)]);
    if (!t) return res.status(404).send(page("Not found", "Topic not found.", nav(req)));
    const me = staffOf(req);
    const versions = await db.query(
      `SELECT v.*, a.name AS author, p.name AS publisher FROM content_versions v LEFT JOIN staff a ON a.id = v.author_id LEFT JOIN staff p ON p.id = v.published_by
        WHERE v.topic_id = $1 ORDER BY v.language, v.version DESC`,
      [t.id],
    );
    const canWrite = me.role === "admin" || me.role === "editor";
    const column = (lang: string) => {
      const vs = versions.filter((v) => v.language === lang);
      const pub = vs.find((v) => v.status === "published");
      const work = vs.find((v) => ["draft", "in_review", "approved"].includes(v.status));
      return `<div class="card" style="margin:0"><div class="eyebrow">${esc(LANGUAGES[lang])}</div>
${pub ? `<h2>${esc(pub.title)}</h2><p style="white-space:pre-wrap">${esc(pub.body)}</p>${pub.audio_media_id ? `<audio controls preload="none" src="/staff/media/${pub.audio_media_id}" style="width:100%"></audio>` : ""}
<p class="muted">${statusTag("published")} v${pub.version} · approved by ${esc(pub.reviewer_name ?? "—")} · published ${when(pub.published_at)}</p>` : `<p class="muted">Nothing published in ${esc(LANGUAGES[lang])} yet.${lang !== "en" ? " Girls get the English answer with a note." : ""}</p>`}
${work ? `<hr style="border:0;border-top:1px solid var(--line)"><p>${statusTag(work.status)} <a href="/staff/content/versions/${work.id}">v${work.version}: ${esc(work.title)}</a></p>${work.review_note ? `<div class="notice">Reviewer's note: ${esc(work.review_note)}</div>` : ""}` : ""}
${canWrite && !t.archived && (!work || work.status === "draft") ? `<p><a class="btn secondary small" href="/staff/content/${esc(t.id)}/${lang}/edit">${work ? "Edit draft" : pub ? "Write a new version" : lang === "en" ? "Write it" : "Translate"}</a></p>` : ""}</div>`;
    };
    const history = versions
      .map(
        (v) => `<tr><td><a href="/staff/content/versions/${v.id}">${esc(LANGUAGES[v.language] ?? v.language)} v${v.version}</a></td><td>${statusTag(v.status)}</td><td>${esc(v.author ?? "import")}</td><td>${esc(v.reviewer_name ?? "—")}</td><td class="muted">${when(v.published_at ?? v.reviewed_at ?? v.created_at)}</td></tr>`,
      )
      .join("");
    const settings = canWrite
      ? `<form method="post" action="/staff/content/${esc(t.id)}/settings" class="card">${csrfField(req)}<h2>Topic settings</h2>
${select("Category", "category", Object.entries(CATEGORIES), t.category, { required: true })}${checks("Clinic services this topic can refer to", "services", Object.entries(SERVICES), t.services)}
<label class="inline"><input type="checkbox" name="archived" value="1"${t.archived ? " checked" : ""}> Archived (never sent to girls)</label><p><button class="small">Save settings</button></p></form>`
      : "";
    res.send(
      page(
        t.id,
        `${back("/staff/content", "Content studio")}${h1(t.id, "", CATEGORIES[t.category] ?? t.category)}${notice(req.query)}
<div class="cols" style="margin-bottom:16px">${LANGS.map(column).join("")}</div>${settings}
<div class="card"><h2>Version history</h2><div class="scroll"><table><thead><tr><th>Version</th><th>Status</th><th>Author</th><th>Approved by</th><th>When</th></tr></thead><tbody>${history}</tbody></table></div></div>`,
        nav(req),
      ),
    );
  });

  r.post("/content/:topic/settings", writers, async (req, res) => {
    const category = String(req.body.category ?? "");
    if (!(category in CATEGORIES)) return res.redirect(`/staff/content/${encodeURIComponent(String(req.params.topic))}?error=invalid`);
    const done = await db.query(`UPDATE content_topics SET category = $2, services = $3, archived = $4 WHERE id = $1 RETURNING id`, [
      String(req.params.topic),
      category,
      many(req.body.services).filter((s) => s in SERVICES),
      Boolean(req.body.archived),
    ]);
    if (!done.length) return res.status(404).send("Not found");
    invalidateCaches();
    await auditReq(db, req, { action: "content.settings", targetType: "content", targetId: done[0].id, details: { archived: Boolean(req.body.archived) } });
    res.redirect(`/staff/content/${done[0].id}?done=saved`);
  });

  // ---- Write or edit a draft ----
  const editPage = async (req: Request, res: Response, error = "") => {
    const topicId = String(req.params.topic);
    const lang = String(req.params.lang);
    const [t] = await db.query(`SELECT * FROM content_topics WHERE id = $1`, [topicId]);
    if (!t || !LANGS.includes(lang)) return res.status(404).send(page("Not found", "Not found.", nav(req)));
    const work = await workingVersion(db, "content_versions", topicId, lang);
    if (work && work.status !== "draft") return res.redirect(`/staff/content/versions/${work.id}?error=state`);
    const [pub] = await db.query(`SELECT * FROM content_versions WHERE topic_id = $1 AND language = $2 AND status = 'published'`, [topicId, lang]);
    const [enRef] = lang === "en" ? [] : await db.query(`SELECT * FROM content_versions WHERE topic_id = $1 AND language = 'en' AND status IN ('published','approved','in_review','draft') ORDER BY (status='published') DESC, version DESC LIMIT 1`, [topicId]);
    const start = work ?? pub ?? (lang === "en" ? {} : { keywords: [], sources: enRef?.sources ?? "" });
    const reference = enRef
      ? `<div class="card"><div class="eyebrow">English text to translate (${statusTag(enRef.status)} v${enRef.version})</div><h2>${esc(enRef.title)}</h2><p style="white-space:pre-wrap">${esc(enRef.body)}</p><p class="muted">Keywords: ${esc(enRef.keywords.join(", "))}</p></div>`
      : "";
    res.send(
      page(
        `Edit ${topicId}`,
        `${back(`/staff/content/${topicId}`, topicId)}${h1(work ? "Edit" : "Write", `${LANGUAGES[lang]} draft`, topicId)}${error ? `<div class="notice" role="alert">${esc(error)}</div>` : ""}
<p class="lead">Use only facts from WHO or Kenya Ministry of Health guidance. Short sentences a 14-year-old understands. This is a DRAFT until a health-partner reviewer approves it.</p>${reference}
<form method="post" action="/staff/content/${esc(topicId)}/${lang}" class="card">${csrfField(req)}${versionFields(start)}
<p class="row"><button class="accent" name="step" value="save">Save draft</button><button class="secondary" name="step" value="submit">Save and send for review</button></p></form>`,
        nav(req),
      ),
    );
  };
  r.get("/content/:topic/:lang/edit", writers, (req, res) => editPage(req, res));

  r.post("/content/:topic/:lang", writers, async (req, res) => {
    const topicId = String(req.params.topic);
    const lang = String(req.params.lang);
    const [t] = await db.query(`SELECT id, archived FROM content_topics WHERE id = $1`, [topicId]);
    if (!t || !LANGS.includes(lang)) return res.status(404).send("Not found");
    const v = readVersion(req);
    if (!v) return editPage(req, res, "Title and answer text are required.");
    const me = staffOf(req).id;
    const work = await workingVersion(db, "content_versions", topicId, lang);
    if (work && work.status !== "draft") return res.redirect(`/staff/content/versions/${work.id}?error=state`);
    let id: number;
    if (work) {
      await db.query(`UPDATE content_versions SET title=$2, body=$3, keywords=$4, sources=$5, author_id=$6 WHERE id=$1 AND status='draft'`, [work.id, v.title, v.body, v.keywords, v.sources, me]);
      id = work.id;
    } else {
      const [row] = await db.query<{ id: number }>(
        `INSERT INTO content_versions (topic_id, language, version, title, body, keywords, sources, author_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [topicId, lang, await nextVersionNo(db, "content_versions", topicId, lang), v.title, v.body, v.keywords, v.sources, me],
      );
      id = row.id;
    }
    await auditReq(db, req, { action: "content.save_draft", targetType: "content_version", targetId: id, details: { topic: topicId, lang } });
    if (req.body.step === "submit") {
      await submitVersion(db, "content_versions", id);
      await auditReq(db, req, { action: "content.submit", targetType: "content_version", targetId: id });
      return res.redirect(`/staff/content/versions/${id}?done=submitted`);
    }
    res.redirect(`/staff/content/versions/${id}?done=saved`);
  });

  // ---- One version: read it, review it, publish it ----
  r.get("/content/versions/:id", viewers, async (req, res) => {
    const id = int(req.params.id);
    const [v] = id
      ? await db.query(
          `SELECT v.*, a.name AS author, p.name AS publisher FROM content_versions v LEFT JOIN staff a ON a.id = v.author_id LEFT JOIN staff p ON p.id = v.published_by WHERE v.id = $1`,
          [id],
        )
      : [];
    if (!v) return res.status(404).send(page("Not found", "Version not found.", nav(req)));
    const me = staffOf(req);
    const [current] = await db.query(`SELECT * FROM content_versions WHERE topic_id = $1 AND language = $2 AND status = 'published' AND id <> $3`, [v.topic_id, v.language, v.id]);
    const [en] = v.language === "en" ? [] : await db.query(`SELECT * FROM content_versions WHERE topic_id = $1 AND language = 'en' AND status = 'published'`, [v.topic_id]);
    const act = (action: string, label: string, cls = "secondary") => `<form method="post" action="/staff/content/versions/${v.id}/${action}" style="display:inline">${csrfField(req)}<button class="${cls}">${esc(label)}</button></form>`;
    const writer = me.role === "admin" || me.role === "editor";
    const actions: string[] = [];
    if (v.status === "draft" && writer) actions.push(`<a class="btn secondary" href="/staff/content/${esc(v.topic_id)}/${v.language}/edit">Edit</a>`, act("submit", "Send for review", "accent"), act("discard", "Discard draft"));
    if (v.status === "in_review" && me.role === "reviewer") {
      actions.push(
        v.author_id === me.id ? `<span class="muted">You wrote this version, so another reviewer must approve it.</span>` : act("approve", "Approve: this is accurate and safe", "accent"),
        `<form method="post" action="/staff/content/versions/${v.id}/return" class="card" style="margin:12px 0 0">${csrfField(req)}${textarea("Send back with a note", "note", "", { rows: 2, required: true })}<p><button class="secondary">Send back to the author</button></p></form>`,
      );
    }
    if (v.status === "approved" && writer) actions.push(act("publish", "Publish: send this to girls", "accent"));
    const audio =
      v.status === "draft" && writer
        ? `<form method="post" action="/staff/content/versions/${v.id}/audio?_csrf=${encodeURIComponent(csrfToken(req))}" enctype="multipart/form-data" class="row">${csrfField(req)}
<label for="audio" style="margin:0">Recorded voice answer (native speaker, max 5 MB)</label><input id="audio" name="audio" type="file" accept="audio/*" required style="max-width:320px"><button class="secondary small">Upload</button></form>
${v.audio_media_id ? `<form method="post" action="/staff/content/versions/${v.id}/audio/remove">${csrfField(req)}<button class="danger small">Remove recording</button></form>` : ""}`
        : "";
    const side = (title: string, x: any) => (x ? `<div class="card" style="margin:0"><div class="eyebrow">${title}</div><h2>${esc(x.title)}</h2><p style="white-space:pre-wrap">${esc(x.body)}</p></div>` : "");
    res.send(
      page(
        `${v.topic_id} v${v.version}`,
        `${back(`/staff/content/${v.topic_id}`, v.topic_id)}${h1(v.topic_id, `· ${LANGUAGES[v.language] ?? v.language} v${v.version}`, "Content version")}${notice(req.query)}
<div class="card"><p>${statusTag(v.status)} · written by ${esc(v.author ?? "import")} ${when(v.created_at)}${v.reviewer_name ? ` · ${v.status === "draft" ? "returned" : "approved"} by ${esc(v.reviewer_name)} ${when(v.reviewed_at)}` : ""}${v.published_at ? ` · published by ${esc(v.publisher ?? "—")} ${when(v.published_at)}` : ""}</p>
${v.review_note ? `<div class="notice">Reviewer's note: ${esc(v.review_note)}</div>` : ""}
<h2>${esc(v.title)}</h2><p style="white-space:pre-wrap;font-size:17px">${esc(v.body)}</p>
${v.audio_media_id ? `<audio controls preload="none" src="/staff/media/${v.audio_media_id}" style="width:100%"></audio>` : ""}
<p class="muted">Keywords: ${esc(v.keywords.join(", ") || "—")}<br>Sources: ${esc(v.sources || "—")}</p>${audio}
<div class="row" style="margin-top:12px">${actions.join("") || `<span class="muted">No actions for you on this version.</span>`}</div></div>
<div class="cols">${side("Currently published", current)}${side("Published English", en)}</div>`,
        nav(req),
      ),
    );
  });

  const transition = (action: string, roles: typeof writers, run: (id: number, req: Request) => Promise<TransitionResult>) =>
    r.post(`/content/versions/:id/${action}`, roles, async (req, res) => {
      const id = int(req.params.id);
      if (!id) return res.status(404).send("Not found");
      const result = await run(id, req);
      if (result !== "ok") return res.redirect(`/staff/content/versions/${id}?error=${result}`);
      await auditReq(db, req, { action: `content.${action}`, targetType: "content_version", targetId: id });
      if (action === "publish") invalidateCaches();
      const done = { submit: "submitted", approve: "approved", return: "returned", publish: "published", discard: "saved" }[action];
      res.redirect(`/staff/content/versions/${id}?done=${done}`);
    });
  transition("submit", writers, (id) => submitVersion(db, "content_versions", id));
  transition("discard", writers, (id) => discardVersion(db, "content_versions", id));
  transition("approve", reviewers, async (id, req) => approveVersion(db, "content_versions", id, await actorOf(db, req)));
  transition("return", reviewers, async (id, req) => {
    const note = text(req.body.note, 2000);
    return note ? returnVersion(db, "content_versions", id, await actorOf(db, req), note) : "state";
  });
  transition("publish", writers, async (id, req) => publishVersion(db, "content_versions", id, await actorOf(db, req)));

  // ---- Recorded voice answers ----
  r.post("/content/versions/:id/audio", writers, async (req, res) => {
    const id = int(req.params.id);
    const [v] = id ? await db.query(`SELECT id, status FROM content_versions WHERE id = $1`, [id]) : [];
    if (!v) {
      req.resume();
      return res.status(404).send("Not found");
    }
    if (v.status !== "draft") {
      req.resume();
      return res.redirect(`/staff/content/versions/${id}?error=state`);
    }
    const up = await readAudioUpload(req);
    if (!up) return res.redirect(`/staff/content/versions/${id}?error=file`);
    const [m] = await db.query<{ id: number }>(`INSERT INTO media (mime, bytes, size, sha256, filename, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [
      up.mime,
      up.bytes,
      up.bytes.length,
      createHash("sha256").update(up.bytes).digest("hex"),
      up.filename,
      staffOf(req).id,
    ]);
    await db.query(`UPDATE content_versions SET audio_media_id = $2 WHERE id = $1 AND status = 'draft'`, [id, m.id]);
    await auditReq(db, req, { action: "content.audio_upload", targetType: "content_version", targetId: id!, details: { mediaId: m.id, bytes: up.bytes.length } });
    res.redirect(`/staff/content/versions/${id}?done=uploaded`);
  });
  r.post("/content/versions/:id/audio/remove", writers, async (req, res) => {
    const id = int(req.params.id);
    const done = id ? await db.query(`UPDATE content_versions SET audio_media_id = NULL WHERE id = $1 AND status = 'draft' RETURNING id`, [id]) : [];
    if (!done.length) return res.redirect(`/staff/content/versions/${id}?error=state`);
    await auditReq(db, req, { action: "content.audio_remove", targetType: "content_version", targetId: id! });
    res.redirect(`/staff/content/versions/${id}?done=saved`);
  });

  r.get("/media/:id", viewers, async (req, res) => {
    const id = int(req.params.id);
    const [m] = id ? await db.query(`SELECT mime, bytes FROM media WHERE id = $1`, [id]) : [];
    if (!m) return res.status(404).send("Not found");
    res.setHeader("Content-Type", m.mime);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", "inline");
    res.send(Buffer.from(m.bytes));
  });

  return r;
}

function versionFields(v: any) {
  return `${field("Title", "title", v.title ?? "", { required: true })}${textarea("Answer (what Ubah sends)", "body", v.body ?? "", { rows: 6, required: true, hint: "At most about 3 short sentences per paragraph. No medicines or doses unless the guidance names them." })}
<div class="fields">${field("Keywords", "keywords", (v.keywords ?? []).join(", "), { hint: "Comma-separated words girls might use" })}${field("Sources", "sources", v.sources ?? "", { hint: "e.g. WHO guideline name, MoH document and page" })}</div>`;
}

function readVersion(req: Request) {
  const title = text(req.body.title, 200);
  const body = text(req.body.body, 4000);
  if (!title || !body) return null;
  return { title, body, keywords: listOf(req.body.keywords), sources: text(req.body.sources, 500) };
}
