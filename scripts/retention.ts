// What the retention settings would delete today (never deletes): npm run retention
import { config } from "../src/config.js";
import { getDb } from "../src/db.js";
import { retentionPlan } from "../src/retention.js";

const db = await getDb();
const p = await retentionPlan(db);
console.log(`RETENTION_MODE=${config.retention.mode}`);
console.log(p.inactiveDays ? `Accounts with no activity for ${p.inactiveDays} days (no open case): ${p.inactiveGirls}` : "RETENTION_INACTIVE_DAYS not set: no accounts would be deleted");
console.log(p.messageDays ? `Messages older than ${p.messageDays} days (no open case): ${p.oldMessages}` : "RETENTION_MESSAGE_DAYS not set: no messages would be deleted");
if (config.retention.mode !== "delete") console.log("Nothing is deleted unless RETENTION_MODE=delete.");
await db.close();
