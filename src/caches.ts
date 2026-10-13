import type { Db } from "./db.js";
import { config } from "./config.js";
import { loadServingContent, setServingContent } from "./content/content.js";
import { setTranslations, TRANSLATION_LANGUAGES } from "./i18n.js";
import { setGlossary, type GlossaryEntry } from "./ml/glossary.js";
import { setActiveModels } from "./ml/models.js";
import { loadActiveModels } from "./ml/registry.js";
import { hasDemoData } from "./demo.js";
import { setDemoBanner } from "./web/html.js";

// Health content, translated strings and the glossary live in the database but are read on every
// message, so each app instance keeps a copy and refreshes it every 30 seconds (or at once after
// a publish on this instance). Other instances pick up a publish within 30 seconds.

const MAX_AGE_MS = 30_000;
let loadedAt = 0;
let loadedFor: Db | null = null;
let loading: Promise<void> | null = null;

export async function loadStrings(db: Db, allowDraft = config.allowDraftContent) {
  const rows = await db.query<{ key: string; language: string; text: string }>(
    `SELECT DISTINCT ON (key, language) key, language, text FROM string_versions
      WHERE language = ANY($1) AND status IN (${allowDraft ? "'published','approved','in_review','draft'" : "'published'"})
      ORDER BY key, language, (status = 'published') DESC, version DESC`,
    [TRANSLATION_LANGUAGES as unknown as string[]],
  );
  const out: Record<string, Record<string, string>> = {};
  for (const r of rows) (out[r.language] ??= {})[r.key] = r.text;
  return out;
}

export async function loadGlossary(db: Db): Promise<GlossaryEntry[]> {
  return db.query<GlossaryEntry>(`SELECT term, language, means, topic, verified FROM glossary_terms WHERE active ORDER BY id`);
}

export async function refreshCaches(db: Db, opts: { force?: boolean } = {}): Promise<void> {
  if (!opts.force && loadedFor === db && Date.now() - loadedAt < MAX_AGE_MS) return;
  if (loading && !opts.force) return loading;
  loading = (async () => {
    const [content, library, strings, glossary, models] = await Promise.all([loadServingContent(db), loadServingContent(db, true), loadStrings(db), loadGlossary(db), loadActiveModels(db)]);
    setServingContent(content, library);
    setActiveModels(models);
    setDemoBanner(config.demoMode || (await hasDemoData(db)));
    setTranslations(strings);
    setGlossary(glossary);
    loadedAt = Date.now();
    loadedFor = db;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const invalidateCaches = () => {
  loadedAt = 0;
};
