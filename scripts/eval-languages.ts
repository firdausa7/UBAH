// Language evaluation: npm run eval:languages [-- --lang so,sw] [-- --mock] [-- --provider mms | so=openai,om=mms]
// --provider compares speech-to-text providers on the same recordings: each run writes its own report.
// Reads eval/audio/<lang>/ and eval/expected/<lang>.csv, writes eval/report.md. See eval/README.md.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, mockMode, STT_PROVIDERS } from "../src/config.js";
import { speechProviderFor, speechSettingsFor } from "../src/providers/speech.js";
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
// --provider mms (every language) or so=openai,om=mms: for this run only.
const providerArg = arg("provider");
if (providerArg) {
  for (const part of providerArg.split(",")) {
    const [a, b] = part.includes("=") ? part.split("=") : [null, part];
    if (!(STT_PROVIDERS as readonly string[]).includes(b)) {
      console.error(`Unknown provider ${b}: use ${STT_PROVIDERS.join(", ")}`);
      process.exit(1);
    }
    for (const l of a ? [a] : langs) config.stt.perLanguage[l] = { ...config.stt.perLanguage[l], provider: b as (typeof STT_PROVIDERS)[number] };
  }
}
if (!mock) {
  const unset = langs.filter((l) => speechProviderFor(l).name === "mock");
  if (unset.length || mockMode.translate()) {
    console.error(
      [
        unset.length ? `No real speech-to-text for: ${unset.map((l) => `${l} (${speechSettingsFor(l).provider}: ${speechSettingsFor(l).provider === "mms" ? `set STT_${l.toUpperCase()}_BASE_URL` : "set STT_API_KEY"})`).join(", ")}.` : "",
        mockMode.translate() ? "No translation key: set GOOGLE_TRANSLATE_API_KEY." : "",
        "Or run with --mock to check the CSV and the danger lists only.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    process.exit(1);
  }
}

const results = [];
for (const lang of langs) {
  const csvPath = join(dir, "expected", `${lang}.csv`);
  if (!existsSync(csvPath)) {
    console.error(`Skipping ${lang}: no ${csvPath} (copy eval/example/so.csv there to start)`);
    continue;
  }
  const audioDir = join(dir, "audio", lang);
  if (!mock && (!existsSync(audioDir) || readdirSync(audioDir).length === 0)) console.error(`Warning: no recordings in ${audioDir}`);
  results.push(await evaluateLanguage(lang, readFileSync(csvPath, "utf8"), audioDir, { mock }));
}
if (!results.length) {
  console.error(`Nothing to evaluate. Create ${join(dir, "expected", "<lang>.csv")} (start from eval/example/so.csv) and put the recordings in ${join(dir, "audio", "<lang>")}/. See eval/README.md.`);
  process.exit(1);
}
const describe = (l: string) => {
  const s = speechSettingsFor(l);
  return `${l} ${s.provider}${s.provider === "mock" ? "" : ` ${s.model}${s.provider === "mms" ? ` (${s.language})` : ""}`}`;
};
const report = reportMarkdown(results, { at: new Date().toISOString(), mock, stt: mock ? "mock" : langs.map(describe).join(", "), translation: mock ? "mock" : "Google Cloud Translation" });
const out = join(dir, providerArg ? `report-${providerArg.replace(/[^a-z=,]/g, "").replace(/[=,]/g, "-")}.md` : "report.md");
writeFileSync(out, report);
console.log(report.split("\n").slice(0, 14).join("\n"));
console.log(`\nFull report: ${out}`);
