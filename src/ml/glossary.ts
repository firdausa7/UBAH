import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Detects coded words ("monthly visitor", "down there") and adds their plain meaning,
// so the classifiers and search understand what a girl actually means.

export interface GlossaryEntry {
  term: string;
  language: string;
  means: string;
  topic: string;
  verified: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const GLOSSARY_PATH = process.env.GLOSSARY_PATH ?? join(here, "../../data/glossary.json");

// The glossary is managed in the Glossary studio (database). The JSON file is the starting list:
// it is imported once, and is also used by the training script, which runs without a database.
export const glossaryFile = (): GlossaryEntry[] => JSON.parse(readFileSync(GLOSSARY_PATH, "utf8")).entries;

let entries: GlossaryEntry[] | null = null;
export function setGlossary(list: GlossaryEntry[]) {
  entries = list;
}
export function glossary(): GlossaryEntry[] {
  if (!entries) entries = glossaryFile();
  return entries;
}

export function expandCodedTerms(text: string): { text: string; found: GlossaryEntry[] } {
  const lower = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ")} `;
  // Longest terms first so "the visitor did not come" wins over shorter matches.
  const found = glossary()
    .slice()
    .sort((a, b) => b.term.length - a.term.length)
    .filter((e) => lower.includes(` ${e.term.toLowerCase()} `));
  if (found.length === 0) return { text, found };
  return { text: `${text} (${found.map((f) => f.means).join(", ")})`, found };
}
