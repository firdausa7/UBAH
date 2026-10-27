// Language evaluation: npm run eval:languages [-- --lang so,sw] [-- --mock]
// Reads eval/audio/<lang>/ and eval/expected/<lang>.csv, writes eval/report.md. See eval/README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, mockMode } from "../src/config.js";
import { evaluateLanguage, reportMarkdown } from "../src/eval/languages.js";
import { ALL_LANGUAGES } from "../src/languages/index.js";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
};
const dir = arg("dir") ?? "eval";
const mock = process.argv.includes("--mock");
const wanted = (arg("lang") ?? "").split(",").filter(Boolean);
const langs = ALL_LANGUAGES.map((l) => l.code).filter((l) => (wanted.length ? wanted.includes(l) : existsSync(join(dir, "expected", `${l}.csv`))));

if (!langs.length) {
  console.error(`No eval/expected/<lang>.csv found in ${dir}. See eval/README.md for the format.`);
  process.exit(1);
}
if (!mock && (mockMode.stt() || mockMode.translate())) {
  console.error("Real providers aren't configured (STT_API_KEY and GOOGLE_TRANSLATE_API_KEY). Set them, or run with --mock to check the CSV and the danger lists only.");
  process.exit(1);
}

const results = [];
for (const lang of langs) {
  const csvPath = join(dir, "expected", `${lang}.csv`);
  if (!existsSync(csvPath)) {
    console.error(`Skipping ${lang}: no ${csvPath}`);
    continue;
  }
  const audioDir = join(dir, "audio", lang);
  if (!mock && (!existsSync(audioDir) || readdirSync(audioDir).length === 0)) console.error(`Warning: no recordings in ${audioDir}`);
  results.push(await evaluateLanguage(lang, readFileSync(csvPath, "utf8"), audioDir, { mock }));
}
const report = reportMarkdown(results, { at: new Date().toISOString(), mock, stt: mock ? "mock" : config.stt.model, translation: mock ? "mock" : "Google Cloud Translation" });
writeFileSync(join(dir, "report.md"), report);
console.log(report.split("\n").slice(0, 14).join("\n"));
console.log(`\nFull report: ${join(dir, "report.md")}`);
