// npm run demo            load 8 weeks of made-up activity, all labelled [DEMO] (refused in production)
// npm run demo -- --wipe  remove every demo record
import { createDb } from "./db.js";
import { loadDemo, wipeDemo } from "./demo.js";
import { config } from "./config.js";

if (config.production && config.stage !== "staging") {
  console.error("Demo data is never loaded in production.");
  process.exit(1);
}
const db = await createDb();
try {
  if (process.argv.includes("--wipe")) {
    await wipeDemo(db);
    console.log("All demo data removed.");
  } else {
    const r = await loadDemo(db);
    console.log(`Loaded demo data: ${r.girls} made-up girls, ${r.cases} cases, ${r.passes} passes over 8 weeks. Every record is labelled [DEMO].`);
    console.log("Staff pages show a DEMO DATA banner until you run: npm run demo -- --wipe");
  }
} finally {
  await db.close();
}
