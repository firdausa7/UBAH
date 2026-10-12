import type { Db } from "./db.js";
import { config } from "./config.js";
import { audit } from "./audit.js";
import { normalizePhone, verifyPassword } from "./privacy.js";
import { checkPass, redeemPass, SERVICES } from "./referrals.js";

// Clinic desks without internet check and record passes by SMS or USSD, from the phone number
// registered on their clinic-desk account, with a desk PIN:
//   SMS:  CHECK UB-7K42 1234   -> is it valid, which services
//         SEEN UB-7K42 1234    -> record that she was seen here
//   USSD: dial the Ubah code and follow the menu.
// A wrong PIN counts toward the same lockout as a wrong password.

interface DeskStaff {
  id: number;
  login: string;
  clinic_id: number;
  desk_pin_hash: string | null;
  locked_until: string | null;
  clinic_name: string;
}

export async function findDeskStaff(db: Db, phone: string): Promise<DeskStaff | null> {
  const p = normalizePhone(phone);
  if (!p) return null;
  const rows = await db.query<DeskStaff & { phone: string }>(
    `SELECT s.id, s.login, s.clinic_id, s.desk_pin_hash, s.locked_until, s.phone, c.name AS clinic_name
       FROM staff s JOIN clinics c ON c.id = s.clinic_id WHERE s.role = 'clinic' AND s.active AND c.active AND s.phone IS NOT NULL`,
  );
  return rows.find((r) => normalizePhone(r.phone) === p) ?? null;
}

const fmtDate = (d: string) => new Date(d).toISOString().slice(0, 10);

async function verifyPin(db: Db, s: DeskStaff, pin: string): Promise<"ok" | "bad" | "locked" | "no_pin"> {
  if (s.locked_until && new Date(s.locked_until) > new Date()) return "locked";
  if (!s.desk_pin_hash) return "no_pin";
  if (verifyPassword(pin, s.desk_pin_hash)) {
    await db.query(`UPDATE staff SET failed_logins = 0 WHERE id = $1`, [s.id]);
    return "ok";
  }
  const [r] = await db.query<{ locked: boolean }>(
    `UPDATE staff SET
        locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END,
        failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END
      WHERE id = $1 RETURNING (locked_until IS NOT NULL AND locked_until > now()) AS locked`,
    [s.id, config.security.loginMaxFailures, config.security.loginLockMinutes],
  );
  await audit(db, { staffId: s.id, staffLogin: s.login, action: r?.locked ? "login.locked" : "login.failed", targetType: "staff", targetId: s.id, details: { via: "desk_pin" } });
  return r?.locked ? "locked" : "bad";
}

const PIN_PROBLEM = {
  bad: "Wrong PIN.",
  locked: "Too many wrong PINs. Try again in a few minutes or ask your Ubah admin.",
  no_pin: "No desk PIN is set for this phone. Log in to Ubah and set one under Account.",
};

export async function deskAction(db: Db, s: DeskStaff, action: "check" | "seen", rawCode: string, pin: string, via: "sms" | "ussd"): Promise<string> {
  const pinResult = await verifyPin(db, s, pin);
  if (pinResult !== "ok") return PIN_PROBLEM[pinResult];
  const chk = await checkPass(db, rawCode, s.clinic_id);
  const code = chk.code ?? rawCode.toUpperCase();
  await audit(db, { staffId: s.id, staffLogin: s.login, action: "pass.check", targetType: "pass", targetId: code, details: { valid: chk.valid, via } });
  if (!chk.valid) return `${code} NOT VALID: ${chk.reason}.`;
  const services = chk.services!.map((x) => SERVICES[x] ?? x).join(", ");
  if (action === "check") {
    return `${code} VALID until ${fmtDate(chk.expiresAt!)}. Needs: ${services}.${chk.urgent ? " URGENT: see her today." : ""}${chk.alreadyRedeemed ? " Already recorded as seen." : ""} No name is needed.`;
  }
  await redeemPass(db, chk.code!, s.clinic_id);
  await audit(db, { staffId: s.id, staffLogin: s.login, action: "pass.redeem", targetType: "pass", targetId: code, details: { clinicId: s.clinic_id, via } });
  return `Recorded: ${code} seen at ${s.clinic_name}. Thank you.`;
}

const SMS_RE = /^\s*(CHECK|SEEN)\s+(UB-?[A-Z0-9]{4})\s+(\d{4,6})\s*$/i;
const DESK_HELP = "Ubah clinic desk. Send: CHECK UB-XXXX PIN to check a pass, or SEEN UB-XXXX PIN to record a visit.";

// Returns the reply for a clinic desk's SMS, or null when the sender isn't a clinic desk (a girl).
export async function handleDeskSms(db: Db, from: string, text: string): Promise<string | null> {
  const s = await findDeskStaff(db, from);
  if (!s) return null;
  const m = text.match(SMS_RE);
  if (!m) return DESK_HELP;
  return deskAction(db, s, m[1].toUpperCase() === "CHECK" ? "check" : "seen", m[2], m[3], "sms");
}

// Africa's Talking USSD: `text` is every answer so far, joined by "*". Reply "CON ..." to continue, "END ..." to finish.
// Returns null when the phone isn't a clinic desk (the girl's menu then takes over).
export async function handleDeskUssd(db: Db, phone: string, text: string): Promise<string | null> {
  const s = await findDeskStaff(db, phone);
  if (!s) return null;
  const parts = text === "" ? [] : text.split("*");
  if (parts.length === 0) return `CON Ubah clinic desk (${s.clinic_name})\n1 Check a pass\n2 Record a visit`;
  const action = parts[0] === "1" ? "check" : parts[0] === "2" ? "seen" : null;
  if (!action) return "END Please choose 1 or 2.";
  if (parts.length === 1) return "CON Enter the pass code (the 4 characters after UB-)";
  if (!/^[A-Za-z0-9]{4}$/.test(parts[1].replace(/^UB-?/i, ""))) return "END That isn't a pass code. Codes look like UB-7K42.";
  if (parts.length === 2) return "CON Enter your desk PIN";
  return `END ${await deskAction(db, s, action, `UB-${parts[1].replace(/^UB-?/i, "")}`, parts[2], "ussd")}`;
}
