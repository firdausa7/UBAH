import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_LANGUAGES } from "../languages/index.js";
import { stemSo, words } from "./text.js";

// Danger-word lists (data/danger/<lang>.txt), plain files that nurses and translators edit.
// Any match is URGENT. Every message is checked against every list, because girls mix languages.

export type DangerLabel = "medical" | "safety" | "selfharm";
const LABELS: readonly string[] = ["medical", "safety", "selfharm"];

export interface DangerPhrase {
  label: DangerLabel;
  language: string;
  phrase: string; // as written in the file
  pattern: RegExp[]; // one per word
}

export interface DangerMatch {
  label: DangerLabel;
  language: string;
  phrase: string;
}

const here = dirname(fileURLToPath(import.meta.url));
export const DANGER_DIR = process.env.DANGER_DIR ?? join(here, "../../data/danger");

// The same clean-up for the list and the message, so they compare like with like.
function tokens(text: string, lang: string): string[] {
  const ws = words(text, true);
  return lang === "so" ? ws.map(stemSo) : ws;
}

function wordPattern(word: string, lang: string): RegExp {
  const w = word.includes("*") ? word : tokens(word, lang)[0] ?? word;
  return new RegExp(`^${w.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\p{L}*")}$`, "u");
}

export function parseDangerList(source: string, language: string): DangerPhrase[] {
  const out: DangerPhrase[] = [];
  let label: DangerLabel | null = null;
  source.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const heading = line.match(/^\[(\w+)\]$/);
    if (heading) {
      if (!LABELS.includes(heading[1])) throw new Error(`${language} danger list, line ${i + 1}: unknown heading [${heading[1]}]`);
      label = heading[1] as DangerLabel;
      return;
    }
    if (!label) throw new Error(`${language} danger list, line ${i + 1}: "${line}" is above the first [heading]`);
    // Keep "*" while splitting into words; drop words the message clean-up would drop too.
    const ws = line.toLowerCase().split(/\s+/).filter((w) => w.includes("*") || tokens(w, language).length > 0);
    if (ws.length === 0) return;
    out.push({ label, language, phrase: line, pattern: ws.map((w) => wordPattern(w, language)) });
  });
  return out;
}

let lists: Record<string, DangerPhrase[]> | null = null;

export function loadDangerLists(dir = DANGER_DIR): Record<string, DangerPhrase[]> {
  const out: Record<string, DangerPhrase[]> = {};
  // A missing or broken list throws: a silently empty list would miss urgent messages.
  for (const l of ALL_LANGUAGES) out[l.code] = parseDangerList(readFileSync(join(dir, l.dangerWordsFile), "utf8"), l.code);
  return out;
}

export function dangerLists(): Record<string, DangerPhrase[]> {
  if (!lists) lists = loadDangerLists();
  return lists;
}

export function reloadDangerLists() {
  lists = null;
}

function matchesAt(toks: string[], raw: string[], at: number, p: DangerPhrase): boolean {
  return p.pattern.every((re, k) => at + k < toks.length && (re.test(toks[at + k]) || re.test(raw[at + k])));
}

// Every list match in the text (medical first, then safety, then self-harm, as listed).
export function findDangerWords(text: string, only?: string[]): DangerMatch[] {
  const found: DangerMatch[] = [];
  for (const [lang, phrases] of Object.entries(dangerLists())) {
    if (only && !only.includes(lang)) continue;
    const raw = words(text, true);
    const toks = tokens(text, lang);
    for (const p of phrases) {
      for (let i = 0; i < toks.length; i++) {
        if (matchesAt(toks, raw, i, p)) {
          found.push({ label: p.label, language: lang, phrase: p.phrase });
          break;
        }
      }
    }
  }
  return found;
}

// The most serious match, if any: self-harm, then safety, then medical (as in analyse()).
export function worstDanger(matches: DangerMatch[]): DangerMatch | null {
  for (const l of ["selfharm", "safety", "medical"] as const) {
    const m = matches.find((x) => x.label === l);
    if (m) return m;
  }
  return null;
}
