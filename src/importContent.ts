// Imports the starter health content (content/topics/*.md) and glossary (data/glossary.json) into
// the database as DRAFTS, so they can be reviewed and published in the studio. Safe to re-run.
//   npm run import-content
import { createDb } from "./db.js";
import { importStarterContent } from "./seed.js";

const db = await createDb();
try {
  const added = await importStarterContent(db);
  console.log(`Imported ${added} content version(s) as DRAFT. Review and publish them in the Content studio.`);
} finally {
  await db.close();
}
