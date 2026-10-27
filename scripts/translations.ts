// The round trip with a native speaker (see src/translations/csv.ts):
//   npm run translations -- export so          → data/strings/so.csv and data/templates/so.csv
//   npm run translations -- import so          ← the same files, corrected, with checked_by filled in
//   (--strings-only or --templates-only to do one of them; --file <path> for another location)
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "../src/db.js";
import { languageConfig } from "../src/languages/index.js";
import { exportStrings, exportTemplates, importStrings, importTemplates, type ImportResult } from "../src/translations/csv.js";

const [action, lang] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const only = process.argv.includes("--strings-only") ? "strings" : process.argv.includes("--templates-only") ? "templates" : null;
const l = languageConfig(lang);
if (!["export", "import"].includes(action) || !l?.translation) {
  console.error("Usage: npm run translations -- export|import so|sw|om [--strings-only|--templates-only]");
  process.exit(1);
}
const files = { strings: l.uiStringsFile, templates: `data/templates/${l.code}.csv` };
const db = await getDb();
const show = (what: string, r: ImportResult) => {
  console.log(`${what}: ${r.saved} saved, ${r.skipped} skipped`);
  for (const p of r.problems) console.log(`  - ${p}`);
};
for (const what of ["strings", "templates"] as const) {
  if (only && only !== what) continue;
  const file = files[what];
  if (action === "export") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, what === "strings" ? await exportStrings(db, l.code) : await exportTemplates(db, l.code));
    console.log(`Wrote ${file}`);
  } else if (!existsSync(file)) console.log(`No ${file} to import`);
  else show(file, what === "strings" ? await importStrings(db, l.code, readFileSync(file, "utf8")) : await importTemplates(db, l.code, readFileSync(file, "utf8")));
}
await db.close?.();
