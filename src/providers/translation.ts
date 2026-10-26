import { config, mockMode } from "../config.js";
import { log } from "../log.js";
import { FALLBACK, languageConfig } from "../languages/index.js";

// Translation of girls' messages (into English, for her health worker) and of workers' replies
// (into her language), behind one interface:
//   google  Google Cloud Translation (Basic, v2) with an API key (GOOGLE_TRANSLATE_API_KEY)
//   mock    no network: development and tests. It marks the text instead of translating it.
// Translation is for understanding only: it never writes health advice. The original is always kept.

export interface Translation {
  ok: boolean;
  text: string; // the translation; the original text when ok is false
  detected: string | null; // the source language the provider detected, if it said
  provider: "google" | "mock" | "none";
}

export interface TranslationProvider {
  name: "google" | "mock";
  translate(text: string, to: string, from: string | null): Promise<Translation>;
}

export const mockTranslation: TranslationProvider = {
  name: "mock",
  async translate(text, to, from) {
    return { ok: true, text: `[${from ?? "auto"}→${to}] ${text}`, detected: from, provider: "mock" };
  },
};

export const googleTranslation: TranslationProvider = {
  name: "google",
  async translate(text, to, from) {
    try {
      const res = await fetch(`${config.translate.baseUrl}/language/translate/v2?key=${encodeURIComponent(config.translate.apiKey)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q: [text], target: to, format: "text", ...(from ? { source: from } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Translate HTTP ${res.status}`);
      const json: any = await res.json();
      const t = json?.data?.translations?.[0];
      const out = String(t?.translatedText ?? "").trim();
      if (!out) throw new Error("empty translation");
      return { ok: true, text: out, detected: t?.detectedSourceLanguage ? String(t.detectedSourceLanguage).toLowerCase() : from, provider: "google" };
    } catch (err) {
      // The message is never lost: the caller keeps the original and shows that it wasn't translated.
      log.warn({ err: (err as Error).message }, "translation failed");
      return { ok: false, text, detected: null, provider: "google" };
    }
  },
};

// Tests can swap in a provider (e.g. a small dictionary) to check what happens with real translations.
let override: TranslationProvider | null = null;
export function useTranslationProvider(p: TranslationProvider | null) {
  override = p;
}

export function translationProvider(): TranslationProvider {
  if (override) return override;
  return mockMode.translate() ? mockTranslation : googleTranslation;
}

const providerCode = (lang: string) => languageConfig(lang)?.translation?.code ?? lang;

// Into English, for her health worker. `from` is her chosen language as a hint; with mixed languages
// in one message the provider is left to detect, and the whole text is translated: nothing is dropped.
export async function toEnglish(text: string, from: string | null, mixed = false): Promise<Translation> {
  if (!text.trim()) return { ok: true, text, detected: from, provider: "none" };
  if (from === FALLBACK && !mixed) return { ok: true, text, detected: FALLBACK, provider: "none" };
  return translationProvider().translate(text, FALLBACK, mixed || !from ? null : providerCode(from));
}

// From English into her language. English needs no translation step.
export async function fromEnglish(text: string, to: string | null): Promise<Translation> {
  const target = to ?? FALLBACK;
  if (target === FALLBACK || !languageConfig(target)?.translation) return { ok: true, text, detected: FALLBACK, provider: "none" };
  return translationProvider().translate(text, providerCode(target), FALLBACK);
}
