import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { tokenize } from "../ml/text.js";

// Ubah answers ONLY from health content in the database, written in the Content studio and
// approved by a named health-partner reviewer. In production only Published versions are served.
// (Outside production, ALLOW_DRAFT_CONTENT=true also serves the newest unpublished version, for testing.)
// The markdown files in content/topics/ are only a starting point: they are imported as DRAFTS.

export interface ContentItem {
  id: string; // topic id
  versionId: number;
  topic: string; // category
  title: string;
  status: "draft" | "in_review" | "approved" | "published";
  language: string;
  services: string[];
  keywords: string[];
  sources: string;
  body: string;
  audioMediaId: number | null; // recorded voice answer, if any
  audience: "all" | "adults"; // adults: only for girls who said they are 18 or older
}

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = process.env.CONTENT_DIR ?? join(here, "../../content/topics");

interface ParsedFile {
  id: string;
  topic: string;
  title: string;
  language: string;
  services: string[];
  keywords: string[];
  sources: string;
  body: string;
}

export function parseContentFile(file: string, text: string): ParsedFile {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`Content file ${file} is missing its --- header`);
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const list = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!meta.id || !meta.topic) throw new Error(`Content file ${file} needs id and topic`);
  return {
    id: meta.id,
    topic: meta.topic,
    title: meta.title ?? meta.id,
    language: meta.language ?? "en",
    services: list(meta.services),
    keywords: list(meta.keywords),
    sources: meta.sources ?? "",
    body: m[2].trim(),
  };
}

// Imports content files that aren't in the database yet, always as DRAFT (status in the file is ignored:
// approval only happens in the studio, by a named reviewer). Returns the number of versions added.
export async function importContentFiles(db: Db, dir = CONTENT_DIR, authorId: number | null = null): Promise<number> {
  if (!existsSync(dir)) return 0;
  let added = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md")).sort()) {
    const c = parseContentFile(f, readFileSync(join(dir, f), "utf8"));
    await db.query(`INSERT INTO content_topics (id, category, services, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [c.id, c.topic, c.services, authorId]);
    const [exists] = await db.query(`SELECT 1 FROM content_versions WHERE topic_id = $1 AND language = $2`, [c.id, c.language]);
    if (exists) continue;
    await db.query(
      `INSERT INTO content_versions (topic_id, language, version, title, body, keywords, sources, status, author_id) VALUES ($1,$2,1,$3,$4,$5,$6,'draft',$7)`,
      [c.id, c.language, c.title, c.body, c.keywords, c.sources, authorId],
    );
    added++;
  }
  return added;
}

// What girls can be sent right now.
export async function loadServingContent(db: Db, allowDraft = config.allowDraftContent): Promise<ContentItem[]> {
  const rows = await db.query(
    `SELECT DISTINCT ON (v.topic_id, v.language)
            v.id, v.topic_id, v.language, v.title, v.body, v.keywords, v.sources, v.status, v.audio_media_id, t.category, t.services, t.audience
       FROM content_versions v JOIN content_topics t ON t.id = v.topic_id
      WHERE NOT t.archived AND v.status IN (${allowDraft ? "'published','approved','in_review','draft'" : "'published'"})
      ORDER BY v.topic_id, v.language, (v.status = 'published') DESC, v.version DESC`,
  );
  return rows.map((r) => ({
    id: r.topic_id,
    versionId: r.id,
    topic: r.category,
    title: r.title,
    status: r.status,
    language: r.language,
    services: r.services ?? [],
    keywords: r.keywords ?? [],
    sources: r.sources,
    body: r.body,
    audioMediaId: r.audio_media_id ?? null,
    audience: r.audience === "adults" ? "adults" : "all",
  }));
}

// In-memory copy, refreshed by refreshCaches() (src/caches.ts).
let serving: ContentItem[] = [];
// Word statistics come from the whole English topic library (any status), so that scores stay
// stable while only a few topics are published. Answers still come only from `serving`.
let librarySource: ContentItem[] = [];
export function setServingContent(items: ContentItem[], library: ContentItem[] = items) {
  serving = items;
  librarySource = library;
}
export const servingContent = () => serving;

// Pick the girl's language version when it exists, else English (and say so).
export function localize(item: ContentItem, lang: string): { item: ContentItem; translated: boolean } {
  if (lang === item.language) return { item, translated: true };
  const alt = serving.find((c) => c.id === item.id && c.language === lang);
  return alt ? { item: alt, translated: true } : { item, translated: lang === "en" };
}

// BM25 search over title + keywords + body, with a boost when the predicted topic matches.
export interface Hit {
  item: ContentItem;
  score: number;
}

// A topic marked for adults goes only to a girl who said she is 18 or older.
export const forHer = (item: Pick<ContentItem, "audience">, ageBand: string | null | undefined) => item.audience !== "adults" || ageBand === "18_plus";

export function search(query: string, opts: { topic?: string; limit?: number; lang?: string; english?: string | null; ageBand?: string | null } = {}): Hit[] {
  // Her language's published versions and the English ones, each matched in its own language.
  // English content is matched against the English translation of her message, never against her
  // own words read as English (the Somali "way" is not the English "way"). No translation: no match.
  const lang = opts.lang ?? "en";
  const langs = [...new Set([lang, "en"])];
  const docs = serving.filter((c) => langs.includes(c.language) && forHer(c, opts.ageBand));
  const toksOf = (d: ContentItem) => tokenize(`${d.title} ${d.keywords.join(" ")} ${d.keywords.join(" ")} ${d.body}`, d.language);
  const docTokens = docs.map(toksOf);
  const englishQuery = lang === "en" ? query : (opts.english ?? "");
  const qByLang = new Map(langs.map((l) => [l, tokenize(l === "en" ? englishQuery : query, l)]));
  if ([...qByLang.values()].every((q) => q.length === 0)) return [];
  // Collection statistics over the whole library in every language (each document tokenized in its
  // own language), so scores stay stable while only a few topics are published in a language.
  const libDocs = (librarySource.length >= docs.length ? librarySource : docs).map(toksOf);
  const df = new Map<string, number>();
  for (const toks of libDocs) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = libDocs.length;
  const avg = libDocs.reduce((a, t) => a + t.length, 0) / Math.max(N, 1);
  const k1 = 1.2,
    b = 0.75;
  const hits = docs.map((item, i) => {
    const toks = docTokens[i];
    const q = qByLang.get(item.language) ?? [];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of new Set(q)) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const n = Math.min(df.get(t) ?? 1, N);
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * toks.length) / avg)));
    }
    if (score > 0 && opts.topic && item.topic === opts.topic) score *= 1.5;
    return { item, score };
  });
  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}
