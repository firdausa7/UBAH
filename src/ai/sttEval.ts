// Measures speech-to-text accuracy on a consented test set.
//   npm run eval:stt -- --manifest data/stt-eval/manifest.jsonl
//
// The manifest is JSON lines, one recording per line:
//   {"audio":"clips/001.ogg","text":"what she actually said","language":"so","consent":true,"consent_ref":"FORM-0012"}
// Every recording must have documented consent (consent:true AND a consent_ref pointing to the signed
// form); anything else is refused and not sent to any model. data/stt-eval/ is git-ignored: recordings
// of voices are personal data and never go into the repository.
//
// Reports word error rate (WER) and character error rate (CER) per language and overall, using
// whatever STT_BASE_URL / STT_MODEL is configured, and writes report JSON + Markdown next to the manifest.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface EvalItem {
  audio: string;
  text: string;
  language: string;
  consent: boolean;
  consent_ref?: string;
}

const MIME: Record<string, string> = { ".ogg": "audio/ogg", ".opus": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".webm": "audio/webm", ".amr": "audio/amr" };

export function normalizeTranscript(s: string, lang: string): string {
  return s
    .toLowerCase()
    .normalize("NFKC")
    .replace(lang === "so" || lang === "om" ? /[^\p{L}\p{N}\s']/gu : /[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Levenshtein distance over any sequence.
export function editDistance<T>(a: T[], b: T[]): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

export interface EvalResult {
  model: string;
  at: string;
  refused: number;
  failed: number;
  languages: Record<string, { clips: number; words: number; wer: number; cer: number }>;
  overall: { clips: number; words: number; wer: number; cer: number };
}

export function readManifest(path: string): { items: EvalItem[]; refused: number } {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const items: EvalItem[] = [];
  let refused = 0;
  for (const l of lines) {
    const it = JSON.parse(l) as EvalItem;
    if (it.consent !== true || !it.consent_ref || !it.audio || typeof it.text !== "string" || !it.language) {
      refused++;
      continue;
    }
    items.push(it);
  }
  return { items, refused };
}

type Transcriber = (audio: Buffer, mime: string, lang: string) => Promise<{ text: string; ok: boolean }>;

export async function evaluate(items: EvalItem[], baseDir: string, transcribeFn: Transcriber, model: string, refused = 0): Promise<EvalResult> {
  const acc: Record<string, { clips: number; words: number; wordErr: number; chars: number; charErr: number }> = {};
  let failed = 0;
  for (const it of items) {
    const file = resolve(baseDir, it.audio);
    if (!file.startsWith(resolve(baseDir)) || !existsSync(file)) {
      failed++;
      continue;
    }
    const out = await transcribeFn(readFileSync(file), MIME[extname(file).toLowerCase()] ?? "audio/ogg", it.language);
    const ref = normalizeTranscript(it.text, it.language);
    const hyp = out.ok ? normalizeTranscript(out.text, it.language) : "";
    if (!out.ok) failed++;
    const a = (acc[it.language] ??= { clips: 0, words: 0, wordErr: 0, chars: 0, charErr: 0 });
    const rw = ref.split(" ").filter(Boolean);
    a.clips++;
    a.words += rw.length;
    a.wordErr += editDistance(rw, hyp.split(" ").filter(Boolean));
    a.chars += ref.replace(/ /g, "").length;
    a.charErr += editDistance([...ref.replace(/ /g, "")], [...hyp.replace(/ /g, "")]);
  }
  const rate = (e: number, n: number) => (n ? e / n : 0);
  const languages = Object.fromEntries(Object.entries(acc).map(([l, a]) => [l, { clips: a.clips, words: a.words, wer: rate(a.wordErr, a.words), cer: rate(a.charErr, a.chars) }]));
  const tot = Object.values(acc).reduce((t, a) => ({ clips: t.clips + a.clips, words: t.words + a.words, wordErr: t.wordErr + a.wordErr, chars: t.chars + a.chars, charErr: t.charErr + a.charErr }), { clips: 0, words: 0, wordErr: 0, chars: 0, charErr: 0 });
  return { model, at: new Date().toISOString(), refused, failed, languages, overall: { clips: tot.clips, words: tot.words, wer: rate(tot.wordErr, tot.words), cer: rate(tot.charErr, tot.chars) } };
}

export function reportMarkdown(r: EvalResult): string {
  const p = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `# Speech-to-text evaluation`,
    ``,
    `Model: \`${r.model}\` · ${r.at}`,
    ``,
    `| Language | Clips | Words | WER | CER |`,
    `|---|---|---|---|---|`,
    ...Object.entries(r.languages).map(([l, x]) => `| ${l} | ${x.clips} | ${x.words} | ${p(x.wer)} | ${p(x.cer)} |`),
    `| **All** | ${r.overall.clips} | ${r.overall.words} | ${p(r.overall.wer)} | ${p(r.overall.cer)} |`,
    ``,
    `Refused (no documented consent): ${r.refused}. Failed to transcribe: ${r.failed}.`,
    `Lower is better. WER above ~30% means voice notes will often be misunderstood: keep "type your message" prominent.`,
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf("--manifest");
  const manifest = i > 0 ? process.argv[i + 1] : "data/stt-eval/manifest.jsonl";
  if (!existsSync(manifest)) {
    console.error(`No manifest at ${manifest}. See the comment at the top of src/ai/sttEval.ts.`);
    process.exit(1);
  }
  const { config, mockMode } = await import("../config.js");
  if (mockMode.stt()) {
    console.error("No speech-to-text endpoint is configured (STT_BASE_URL / STT_API_KEY). See README → Voice.");
    process.exit(1);
  }
  const { transcribe } = await import("./stt.js");
  const { items, refused } = readManifest(manifest);
  const result = await evaluate(items, dirname(resolve(manifest)), (a, m, l) => transcribe(a, m, l), config.stt.model, refused);
  const stamp = result.at.slice(0, 19).replace(/[:T]/g, "-");
  writeFileSync(join(dirname(manifest), `report-${stamp}.json`), JSON.stringify(result, null, 2));
  writeFileSync(join(dirname(manifest), `report-${stamp}.md`), reportMarkdown(result));
  console.log(reportMarkdown(result));
}
