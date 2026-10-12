// Trains Ubah's own models and writes an honest accuracy report.
//   npm run train                 -> seed data + any exported labels
//   npm run train -- --export     -> first export nurse/Dada labels from the database
//
// Data files (JSON lines: {"text","label","source","language"}):
//   data/seed/<task>.jsonl      small English starter set, clearly marked "seed"
//   data/labeled/<task>.jsonl   real, anonymous pilot messages labelled by nurses and Dadas
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { crossValidate, train, type Example } from "./classifier.js";
import { MODELS_DIR } from "./models.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? join(here, "../../data");

function readJsonl(path: string): Example[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export async function exportLabels() {
  const { getDb } = await import("../db.js");
  const db = await getDb();
  mkdirSync(join(DATA_DIR, "labeled"), { recursive: true });
  for (const task of ["danger", "topic"]) {
    // Majority label per message across labellers.
    const rows = await db.query<{ body: string; label: string; language: string | null }>(
      `SELECT m.body, l.label, u.language
         FROM labels l JOIN messages m ON m.id = l.message_id JOIN users u ON u.id = m.user_id
        WHERE l.task = $1
        GROUP BY m.id, m.body, l.label, u.language
        ORDER BY m.id`,
      [task],
    );
    const lines = rows.map((r) => JSON.stringify({ text: r.body, label: r.label, source: "labeled", language: r.language ?? "unknown" }));
    writeFileSync(join(DATA_DIR, "labeled", `${task}.jsonl`), lines.join("\n") + (lines.length ? "\n" : ""));
    console.log(`exported ${lines.length} ${task} labels`);
  }
}

export function trainAll(log = console.log) {
  mkdirSync(MODELS_DIR, { recursive: true });
  const reports: Record<string, unknown> = {};
  for (const task of ["danger", "topic"] as const) {
    const data = [...readJsonl(join(DATA_DIR, "seed", `${task}.jsonl`)), ...readJsonl(join(DATA_DIR, "labeled", `${task}.jsonl`))];
    if (data.length === 0) {
      log(`no data for ${task}, skipping`);
      continue;
    }
    // Danger uses equal priors so rare-but-serious classes are not drowned out.
    const opts = { uniformPrior: task === "danger" };
    const report = crossValidate(task, data, 5, opts);
    const model = train(task, data, opts);
    writeFileSync(join(MODELS_DIR, `${task}.json`), JSON.stringify(model));
    writeFileSync(join(MODELS_DIR, `${task}.report.json`), JSON.stringify(report, null, 2));
    reports[task] = report;
    log(`\n${task}: ${data.length} examples ${JSON.stringify(report.sources)} | 5-fold accuracy ${(report.accuracy * 100).toFixed(1)}%`);
    for (const [l, m] of Object.entries(report.perLabel)) {
      log(`  ${l.padEnd(16)} precision ${(m.precision * 100).toFixed(0).padStart(3)}%  recall ${(m.recall * 100).toFixed(0).padStart(3)}%  (n=${m.support})`);
    }
  }
  return reports;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--export")) await exportLabels();
  trainAll();
  console.log("\nNote: seed-only results show the pipeline works; they are NOT evidence of real-world accuracy. Report numbers from labelled pilot data.");
  process.exit(0);
}
