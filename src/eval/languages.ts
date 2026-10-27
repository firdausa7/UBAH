import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { editDistance, MIME, normalizeTranscript } from "../ai/sttEval.js";
import { mockSpeech, speechSettingsFor, transcribe } from "../providers/speech.js";
import { mockTranslation, toEnglish, type Translation } from "../providers/translation.js";
import { analyseBoth } from "../ml/models.js";
import { tokenize } from "../ml/text.js";
import { parseCsv } from "../tools/csv.js";

// Language evaluation: real voice notes through the same steps as a girl's message
// (transcription → translation into English → danger-word check), compared with what was said,
// what it meant, and whether it should have been urgent. Used to decide beta → enabled per language.
//
//   eval/audio/<lang>/<file>     the recordings (git-ignored: real voices)
//   eval/expected/<lang>.csv     file, said, meaning, should_be_urgent, consent_ref
//
// A row without a consent_ref (the signed consent form) is refused and never sent to any provider.

export interface ExpectedRow {
  file: string;
  said: string;
  meaning: string;
  urgent: boolean;
  consentRef: string;
}

export function readExpected(csv: string): { rows: ExpectedRow[]; refused: number; problems: string[] } {
  const problems: string[] = [];
  let refused = 0;
  const rows: ExpectedRow[] = [];
  parseCsv(csv).forEach((r, i) => {
    const line = i + 2;
    const urgent = String(r.should_be_urgent ?? "").toLowerCase();
    if (!r.file || !r.said) return problems.push(`line ${line}: file and said are required`);
    if (!["yes", "no", "true", "false", "1", "0"].includes(urgent)) return problems.push(`line ${line}: should_be_urgent must be yes or no`);
    if (!r.consent_ref) {
      refused++;
      return;
    }
    rows.push({ file: r.file, said: r.said, meaning: r.meaning ?? "", urgent: ["yes", "true", "1"].includes(urgent), consentRef: r.consent_ref });
  });
  return { rows, refused, problems };
}

// How much of the expected meaning the translation carries (share of its content words found).
// A rough guide only: a native speaker still reads the side-by-side table.
export function meaningCoverage(translation: string, meaning: string): number | null {
  const want = new Set(tokenize(meaning, "en"));
  if (want.size === 0) return null;
  const got = new Set(tokenize(translation, "en"));
  return [...want].filter((w) => got.has(w)).length / want.size;
}

export interface ItemResult {
  file: string;
  said: string;
  heard: string;
  heardOk: boolean;
  detected: string | null;
  confidence: number | null;
  wordErrors: number;
  words: number;
  charErrors: number;
  chars: number;
  english: string | null;
  meaning: string;
  coverage: number | null;
  shouldBeUrgent: boolean;
  wasUrgent: boolean;
  urgentWhy: string;
  error?: string;
}

export interface LanguageResult {
  language: string;
  items: ItemResult[];
  refused: number;
  problems: string[];
  wer: number;
  cer: number;
  urgency: { caught: number; missed: number; falseAlarms: number; correctNone: number };
}

export async function evaluateLanguage(language: string, csv: string, audioDir: string, opts: { mock?: boolean } = {}): Promise<LanguageResult> {
  const { rows, refused, problems } = readExpected(csv);
  const items: ItemResult[] = [];
  for (const row of rows) {
    const path = join(audioDir, row.file);
    const base = { file: row.file, said: row.said, meaning: row.meaning, shouldBeUrgent: row.urgent };
    if (!opts.mock && !existsSync(path)) {
      items.push({ ...base, heard: "", heardOk: false, detected: null, confidence: null, wordErrors: 0, words: 0, charErrors: 0, chars: 0, english: null, coverage: null, wasUrgent: false, urgentWhy: "", error: "audio file not found" });
      continue;
    }
    const audio = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const mime = MIME[extname(row.file).toLowerCase()] ?? "audio/ogg";
    // Mock: the "recording" is heard perfectly, so only the translation and danger steps are exercised.
    const tr = opts.mock ? await mockSpeech.transcribe(audio, mime, language, { mockText: row.said }, speechSettingsFor(language)) : await transcribe(audio, mime, language);
    const ref = normalizeTranscript(row.said, language);
    const hyp = normalizeTranscript(tr.text, language);
    const english: Translation | null = tr.ok ? (opts.mock ? await mockTranslation.translate(tr.text, "en", language) : await toEnglish(tr.text, language, Boolean(tr.language && tr.language !== language))) : null;
    const a = tr.ok ? analyseBoth(tr.text, language, english) : null;
    items.push({
      ...base,
      heard: tr.text,
      heardOk: tr.ok,
      detected: tr.language,
      confidence: tr.confidence,
      wordErrors: editDistance(ref.split(" ").filter(Boolean), hyp.split(" ").filter(Boolean)),
      words: ref.split(" ").filter(Boolean).length,
      charErrors: editDistance([...ref], [...hyp]),
      chars: ref.length,
      english: english?.ok ? english.text : null,
      coverage: english?.ok ? meaningCoverage(english.text, row.meaning) : null,
      wasUrgent: Boolean(a && a.danger !== "none"),
      urgentWhy: a && a.danger !== "none" ? `${a.danger} (${a.dangerSource}${a.dangerWord ? `: ${a.dangerWord.language} "${a.dangerWord.phrase}"` : ""}${a.dangerFromEnglish ? ", in the English" : ""})` : "",
    });
  }
  const sum = (f: (i: ItemResult) => number) => items.reduce((n, i) => n + f(i), 0);
  const rate = (e: number, n: number) => (n ? e / n : 0);
  return {
    language,
    items,
    refused,
    problems,
    wer: rate(sum((i) => i.wordErrors), sum((i) => i.words)),
    cer: rate(sum((i) => i.charErrors), sum((i) => i.chars)),
    urgency: {
      caught: items.filter((i) => i.shouldBeUrgent && i.wasUrgent).length,
      missed: items.filter((i) => i.shouldBeUrgent && !i.wasUrgent).length,
      falseAlarms: items.filter((i) => !i.shouldBeUrgent && i.wasUrgent).length,
      correctNone: items.filter((i) => !i.shouldBeUrgent && !i.wasUrgent).length,
    },
  };
}

const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);
const md = (s: string | null) => (s ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");

export function reportMarkdown(results: LanguageResult[], meta: { at: string; mock: boolean; stt: string; translation: string }): string {
  const out = [
    `# Language evaluation`,
    ``,
    `${meta.at} · speech-to-text: ${meta.stt} · translation: ${meta.translation}`,
    ``,
  ];
  if (meta.mock) out.push(`> **MOCK RUN.** Transcription and translation were simulated: these numbers say nothing about real accuracy. Run without --mock, with STT_API_KEY and GOOGLE_TRANSLATE_API_KEY set.`, ``);
  out.push(
    `| Language | Clips | Word errors (WER) | Character errors (CER) | Urgent caught | **Urgent missed** | False alarms |`,
    `|---|---|---|---|---|---|---|`,
    ...results.map((r) => `| ${r.language} | ${r.items.length} | ${pct(r.wer)} | ${pct(r.cer)} | ${r.urgency.caught} | **${r.urgency.missed}** | ${r.urgency.falseAlarms} |`),
    ``,
    `How to read it: a missed urgent message is the most serious result; each one needs a new danger word (data/danger/) or a closer look at the transcription. WER above about 30% means voice notes will often be misunderstood: keep the language in beta and keep "type instead" prominent.`,
    ``,
  );
  for (const r of results) {
    out.push(`## ${r.language}`, ``);
    if (r.refused) out.push(`Refused (no consent_ref, not sent to any provider): ${r.refused}.`, ``);
    if (r.problems.length) out.push(`Problems in the CSV:`, ...r.problems.map((p) => `- ${p}`), ``);
    const missed = r.items.filter((i) => i.shouldBeUrgent && !i.wasUrgent);
    if (missed.length) out.push(`### Urgent messages missed`, ``, ...missed.map((i) => `- \`${i.file}\`: said "${md(i.said)}", heard "${md(i.heard)}", English "${md(i.english)}"`), ``);
    const alarms = r.items.filter((i) => !i.shouldBeUrgent && i.wasUrgent);
    if (alarms.length) out.push(`### False alarms`, ``, ...alarms.map((i) => `- \`${i.file}\`: ${i.urgentWhy}`), ``);
    out.push(
      `### Transcription`,
      ``,
      `| File | Said | Heard | Detected | Confidence | Word errors |`,
      `|---|---|---|---|---|---|`,
      ...r.items.map((i) => `| ${md(i.file)} | ${md(i.said)} | ${i.error ? `**${i.error}**` : i.heardOk ? md(i.heard) : "**nothing heard**"} | ${i.detected ?? "–"} | ${pct(i.confidence)} | ${i.wordErrors}/${i.words} |`),
      ``,
      `### Translation (check the meaning)`,
      ``,
      `| File | English translation | Correct meaning | Meaning words found |`,
      `|---|---|---|---|`,
      ...r.items.map((i) => `| ${md(i.file)} | ${md(i.english) || "–"} | ${md(i.meaning)} | ${pct(i.coverage)} |`),
      ``,
      `### Urgency`,
      ``,
      `| File | Should be urgent | Was urgent | Why |`,
      `|---|---|---|---|`,
      ...r.items.map((i) => `| ${md(i.file)} | ${i.shouldBeUrgent ? "yes" : "no"} | ${i.wasUrgent ? "yes" : "no"}${i.shouldBeUrgent !== i.wasUrgent ? " ✗" : ""} | ${md(i.urgentWhy)} |`),
      ``,
    );
  }
  return out.join("\n");
}
