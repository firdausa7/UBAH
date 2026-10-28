import type { Db } from "./db.js";
import { openCase, say } from "./engine.js";
import { issuePass } from "./referrals.js";
import type { UserRow } from "./channels/outbound.js";

// "I need help now", chosen by the girl herself (USSD menu 5, or the button in her app). Always a
// person, at once: an urgent case (nurses alerted by SMS, her own worker too), an urgent message at the
// top of her worker's inbox whatever she shares, and the help message to her straight away (with an
// urgent clinic pass for a medical emergency).

export type UrgentKind = "medical" | "safety" | "selfharm";

const SERVICES: Record<UrgentKind, string[]> = {
  medical: ["antenatal", "pregnancy_test", "period_care"],
  safety: ["safety", "counselling"],
  selfharm: ["counselling"],
};

export const URGENT_KINDS = Object.keys(SERVICES) as UrgentKind[];

export async function urgentHelp(db: Db, user: UserRow, kind: UrgentKind, channel: "ussd" | "web") {
  const reason = `danger_${kind}`;
  await db.query(`INSERT INTO messages (user_id, direction, channel, kind, body, danger, urgent, urgent_reason) VALUES ($1,'in',$2,'text',$3,$4,TRUE,$5)`, [
    user.id,
    channel,
    `[${channel === "ussd" ? "USSD" : "App"} urgent help: ${reason}]`,
    kind,
    `${channel}:urgent help menu`,
  ]);
  await openCase(db, user, reason, true, `${channel === "ussd" ? "USSD" : "App"} urgent help: ${kind}`);
  if (kind === "medical") {
    const pass = await issuePass(db, user.id, SERVICES.medical, true);
    if (pass) return say(db, user, "urgent_medical", { code: pass.code, clinic: pass.clinic.name, area: pass.clinic.area });
    return say(db, user, "urgent_safety");
  }
  return say(db, user, kind === "safety" ? "urgent_safety" : "urgent_selfharm");
}
