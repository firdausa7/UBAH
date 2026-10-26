import { en } from "./en.js";
import { om } from "./om.js";
import { so } from "./so.js";
import { sw } from "./sw.js";
import type { LanguageConfig } from "./types.js";

export type { LanguageConfig, LanguageStatus } from "./types.js";

export const FALLBACK = "en";

// Menu order (matches the numbered language menu girls see).
export const ALL_LANGUAGES: readonly LanguageConfig[] = [so, sw, en, om];

const byCode = new Map(ALL_LANGUAGES.map((l) => [l.code, l]));

export function languageConfig(code: string | null | undefined): LanguageConfig | undefined {
  return code ? byCode.get(code) : undefined;
}

// Languages a girl can choose (enabled and beta). A disabled language is never shown.
export function girlLanguages(): LanguageConfig[] {
  return ALL_LANGUAGES.filter((l) => l.status !== "disabled");
}

// The language to use for her: her own if it is still offered, else English.
export function resolveLanguage(code: string | null | undefined): string {
  const l = languageConfig(code);
  return l && l.status !== "disabled" ? l.code : FALLBACK;
}

// "Beta" for workers only; girls never see it.
export function workerLabel(code: string | null | undefined): string {
  const l = languageConfig(code);
  if (!l) return code ?? "?";
  return l.status === "beta" ? `${l.name} (Beta)` : l.name;
}

export function validateConfigs(list: readonly LanguageConfig[] = ALL_LANGUAGES): string[] {
  const problems: string[] = [];
  const codes = new Set<string>();
  for (const l of list) {
    if (codes.has(l.code)) problems.push(`${l.code}: listed twice`);
    codes.add(l.code);
    if (!["enabled", "beta", "disabled"].includes(l.status)) problems.push(`${l.code}: unknown status ${l.status}`);
    if (!l.name.trim()) problems.push(`${l.code}: no display name`);
    if (!l.dangerWordsFile) problems.push(`${l.code}: no danger-word list`);
    if (l.code !== FALLBACK && !l.translation) problems.push(`${l.code}: no translation set`);
  }
  if (!codes.has(FALLBACK)) problems.push(`${FALLBACK}: the fallback language is missing`);
  return problems;
}
