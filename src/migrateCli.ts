// npm run migrate              apply pending migrations
// npm run migrate -- --status  list applied and pending migrations
// (Separate from migrate.ts so db.ts can import the runner without an import cycle.)
import { createDb } from "./db.js";
import { migrate, migrationStatus } from "./migrate.js";

const db = await createDb({ migrate: false });
try {
  if (process.argv.includes("--status")) {
    for (const s of await migrationStatus(db)) console.log(`${s.appliedAt ? "applied" : "PENDING"}  ${s.name}`);
  } else {
    const done = await migrate(db, { log: (m) => console.log(m) });
    console.log(done.length ? `Applied ${done.length} migration(s).` : "Database is up to date.");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.close();
}
