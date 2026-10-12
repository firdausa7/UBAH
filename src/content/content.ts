import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { tokenize } from "../ml/text.js";

// Ubah answers ONLY from these content files. Each file is written from WHO / Ministry of Health
// guidance and must be approved by a health partner (status: approved) before a pilot.
// Translations live alongside as <id>.<lang>.md (e.g. periods-pain.so.md).

export interface ContentItem {
  id: string;
  topic: string;
  title: string;
  status: "draft" | "approved";
  language: string;
  services: string[];
  keywords: string[];
  sources: string;
  body: string;
  audio?: string; // optional recorded voice answer (URL), recorded by a native speaker
}

const here = dirname(fileURLToPath(import.meta.url));
export const CONTENT_DIR = process.env.CONTENT_DIR ?? join(here, "../../content/topics");

function parse(file: string, text: string): ContentItem {
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
    status: meta.status === "approved" ? "approved" : "draft",
    language: meta.language ?? "en",
    services: list(meta.services),
    keywords: list(meta.keywords),
    sources: meta.sources ?? "",
    body: m[2].trim(),
    audio: meta.audio || undefined,
  };
}

let cache: ContentItem[] | null = null;
export function loadContent(dir = CONTENT_DIR): ContentItem[] {
  if (cache && dir === CONTENT_DIR) return cache;
  const items = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parse(f, readFileSync(join(dir, f), "utf8")));
  if (dir === CONTENT_DIR) cache = items;
  return items;
}
export function clearContentCache() {
  cache = null;
}

export function usableContent(): ContentItem[] {
  return loadContent().filter((c) => c.status === "approved" || config.allowDraftContent);
}

// Pick the girl's language version when it exists, else English (and say so).
export function localize(item: ContentItem, lang: string): { item: ContentItem; translated: boolean } {
  if (lang === item.language) return { item, translated: true };
  const alt = usableContent().find((c) => c.id === item.id && c.language === lang);
  return alt ? { item: alt, translated: true } : { item, translated: lang === "en" };
}

// BM25 search over title + keywords + body, with a boost when the predicted topic matches.
export interface Hit {
  item: ContentItem;
  score: number;
}

export function search(query: string, opts: { topic?: string; limit?: number } = {}): Hit[] {
  const docs = usableContent().filter((c) => c.language === "en");
  const q = tokenize(query);
  if (q.length === 0) return [];
  const docTokens = docs.map((d) => tokenize(`${d.title} ${d.keywords.join(" ")} ${d.keywords.join(" ")} ${d.body}`));
  const N = docs.length;
  const avg = docTokens.reduce((a, t) => a + t.length, 0) / Math.max(N, 1);
  const df = new Map<string, number>();
  for (const toks of docTokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const k1 = 1.2, b = 0.75;
  const hits = docs.map((item, i) => {
    const toks = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const t of new Set(q)) {
      const f = tf.get(t) ?? 0;
      if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
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
