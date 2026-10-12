// npm run train                  train from data/seed (+ data/labeled), write models/*.json and reports
// npm run train -- --export      first export nurse/Dada labels from the database to data/labeled/
// npm run train -- --register    train from seed + database labels and register CANDIDATE models;
//                                promote them on the Models page (danger recall must not drop)
import { exportLabels, trainAll, TASKS } from "./train.js";

if (process.argv.includes("--register")) {
  const { createDb } = await import("../db.js");
  const { trainCandidate, activeVersion, dangerGate } = await import("./registry.js");
  const db = await createDb();
  try {
    for (const task of TASKS) {
      const c = await trainCandidate(db, task, null, "Trained from the command line");
      if (!c) {
        console.log(`${task}: not enough data`);
        continue;
      }
      const active = await activeVersion(db, task);
      console.log(`${task}: candidate v${c.version} on ${c.examples} examples, accuracy ${(c.report.accuracy * 100).toFixed(1)}%`);
      for (const [l, m] of Object.entries(c.report.perLabel)) console.log(`  ${l.padEnd(16)} precision ${(m.precision * 100).toFixed(0).padStart(3)}%  recall ${(m.recall * 100).toFixed(0).padStart(3)}%`);
      if (task === "danger") {
        const gate = dangerGate(c.report, active?.report ?? null);
        console.log(gate.ok ? "  danger recall: no drop, can be promoted" : `  BLOCKED: danger recall drops for ${gate.drops.map((d) => d.label).join(", ")}`);
      }
    }
    console.log("\nReview and promote candidates on /staff/models.");
  } finally {
    await db.close();
  }
} else {
  if (process.argv.includes("--export")) await exportLabels();
  trainAll();
  console.log("\nNote: seed-only results show the pipeline works; they are NOT evidence of real-world accuracy. Report numbers from labelled pilot data.");
}
process.exit(0);
