import { config } from "../config.js";
// Minimal server-rendered pages: fast on slow connections and cheap phones.
// Visual language: DM Sans, an italic-semibold word inside plain headings, small eyebrow labels,
// soft cards with thin borders, pill buttons, plum ink with Ubah's lavender and purple accent, matching the landing page.

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Heading with one emphasised word: h("Partner", "dashboard") -> <em>Partner</em> dashboard
export function h1(em: string, rest: string, eyebrow = ""): string {
  return `${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1><em>${esc(em)}</em> ${esc(rest)}</h1>`;
}

const CSS = `
:root{--ink:#2E1F3E;--text:#4A3F55;--muted:#5B5066;--line:#ECE2F5;--line2:#D8CAF3;--bg:#FFF8F3;--card:#fff;--soft:#F5EEF9;
--accent:#6C4ACF;--accent-ink:#fff;--accent-soft:#E6DBFA;--ok:#3B2370;--okbg:#E6DBFA;--warn:#8E1340;--warnbg:#F7C6D0;
--pink:#FBE1E7;--pinkink:#6B2A55}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-underline-offset:3px}
header.top{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
header.top .brand{font-weight:700;font-size:22px;color:var(--accent);letter-spacing:-.5px;text-decoration:none}
header.top nav{display:flex;flex-wrap:wrap;gap:6px 18px;align-items:center;font-size:15px}
header.top nav a{text-decoration:none;color:var(--muted)}header.top nav a:hover{color:var(--ink)}
main{max-width:1120px;margin:0 auto;padding:32px 20px 56px}
.eyebrow{font-size:13px;color:var(--muted);margin-bottom:6px;letter-spacing:.2px}
h1{font-weight:400;font-size:clamp(28px,4vw,40px);line-height:1.15;color:var(--ink);margin:0 0 14px;letter-spacing:-.5px}
h1 em,h2 em,.stat em{font-style:italic;font-weight:600}
h2{font-weight:400;font-size:21px;color:var(--ink);margin:0 0 10px}
.lead{max-width:640px;color:var(--muted);margin:0 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.grid{display:flex;flex-wrap:wrap;gap:16px;margin-bottom:16px}.grid>.card{flex:1 1 230px;margin:0}
.stat{font-size:clamp(30px,4vw,38px);line-height:1.1;color:var(--ink);font-weight:400}
.muted{color:var(--muted);font-size:14px}
.tag{display:inline-block;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:600;background:var(--soft);color:var(--ink)}
.tag.urgent{background:var(--warnbg);color:var(--warn)}.tag.ok{background:var(--okbg);color:var(--ok)}
button,.btn{min-height:44px;padding:0 22px;border-radius:999px;border:1px solid var(--ink);background:var(--ink);color:#fff;font:inherit;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px}
button.accent,.btn.accent{background:var(--accent);border-color:var(--accent)}
button.secondary,.btn.secondary{background:#fff;color:var(--ink)}
button:focus-visible,.btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
input,textarea,select{font:inherit;color:var(--ink);padding:12px 14px;border:1px solid var(--line2);border-radius:12px;width:100%;background:#fff}
label{display:block;font-weight:600;color:var(--ink);margin:12px 0 6px;font-size:15px}
label.inline{display:flex;gap:8px;align-items:center;font-weight:400;margin:6px 0}label.inline input{width:auto}
table{width:100%;border-collapse:collapse;font-size:15px}th,td{text-align:left;padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:13px;font-weight:500;color:var(--muted)}.scroll{overflow-x:auto}
.bubble{padding:10px 14px;border-radius:16px;margin:8px 0;max-width:85%;white-space:pre-wrap;font-size:15px}
.in{background:var(--soft);margin-left:auto;border-bottom-right-radius:4px}.out{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
.bar{height:8px;border-radius:4px;background:var(--soft)}.bar>span{display:block;height:8px;border-radius:4px;background:var(--ink)}
.row{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.between{justify-content:space-between}
.notice{background:var(--soft);padding:12px 16px;border-radius:12px;margin-bottom:16px;font-size:15px}
.pills a{min-height:38px;padding:0 16px;font-size:14px}
.tag.draft{background:var(--soft)}.tag.in_review{background:var(--pink);color:var(--pinkink)}.tag.approved{background:#fff;color:var(--accent);border:1px solid var(--accent)}
.tag.published{background:var(--okbg);color:var(--ok)}.tag.archived{background:#fff;color:var(--muted);border:1px solid var(--line)}
.tag.paid{background:var(--okbg);color:var(--ok)}.tag.failed,.tag.cancelled{background:var(--warnbg);color:var(--warn)}.tag.processing{background:var(--pink);color:var(--pinkink)}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 16px}
.checks{display:flex;flex-wrap:wrap;gap:4px 16px}.checks label{font-weight:400}
.cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.timeline{list-style:none;padding:0;margin:0}.timeline li{padding:8px 0;border-bottom:1px solid var(--line);font-size:15px}
.timeline time{display:block;color:var(--muted);font-size:13px}
.ok-notice{background:var(--okbg);color:var(--ok)}
details summary{cursor:pointer;color:var(--ink);font-weight:600;min-height:44px;display:flex;align-items:center}
button.small,.btn.small{min-height:36px;padding:0 14px;font-size:14px}
button.danger{background:#fff;color:var(--warn);border-color:var(--warn)}
.live{position:sticky;top:0;z-index:5}
code{background:var(--soft);padding:2px 6px;border-radius:6px;font-size:14px}
svg.chart text{font:12px "DM Sans",system-ui,sans-serif;fill:var(--muted)}
@media print{header.top,.noprint{display:none}main{padding:0}.card{break-inside:avoid}}
`;

// Set by the cache refresh: true while any demo data exists (or DEMO_MODE is on).
let demoBanner = false;
export const setDemoBanner = (on: boolean) => {
  demoBanner = on;
};
const DEMO_BANNER = `<div role="status" style="background:#8E1340;color:#fff;text-align:center;padding:8px 16px;font-weight:700">DEMO DATA — every girl, case and number on these pages is made up, for presentations only.</div>`;

export const STAGING_BANNER = `<div role="status" style="background:#4A2E8C;color:#fff;text-align:center;padding:8px 16px;font-weight:700">TEST VERSION — not for real girls or real health questions.</div>`;

export function page(title: string, body: string, nav = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Ubah</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
${config.stage === "staging" ? STAGING_BANNER : ""}${demoBanner ? DEMO_BANNER : ""}<header class="top"><a class="brand" href="/staff">ubah</a><nav>${nav}</nav></header><main>${body}</main></body></html>`;
}

// ---- Small form helpers (values are always escaped) ----

export function field(label: string, name: string, value: unknown = "", opts: { type?: string; required?: boolean; hint?: string; attrs?: string } = {}) {
  const id = `f-${name}`;
  return `<div><label for="${id}">${esc(label)}</label><input id="${id}" name="${esc(name)}" type="${opts.type ?? "text"}" value="${esc(value)}"${opts.required ? " required" : ""}${opts.attrs ? ` ${opts.attrs}` : ""}>${opts.hint ? `<div class="muted">${esc(opts.hint)}</div>` : ""}</div>`;
}

export function textarea(label: string, name: string, value: unknown = "", opts: { rows?: number; required?: boolean; hint?: string } = {}) {
  const id = `f-${name}`;
  return `<div><label for="${id}">${esc(label)}</label><textarea id="${id}" name="${esc(name)}" rows="${opts.rows ?? 4}"${opts.required ? " required" : ""}>${esc(value)}</textarea>${opts.hint ? `<div class="muted">${esc(opts.hint)}</div>` : ""}</div>`;
}

export function select(label: string, name: string, options: Array<[string, string]>, selected: unknown = "", opts: { required?: boolean; blank?: string } = {}) {
  const id = `f-${name}`;
  const blank = opts.blank != null ? `<option value="">${esc(opts.blank)}</option>` : "";
  return `<div><label for="${id}">${esc(label)}</label><select id="${id}" name="${esc(name)}"${opts.required ? " required" : ""}>${blank}${options
    .map(([v, l]) => `<option value="${esc(v)}"${String(selected) === v ? " selected" : ""}>${esc(l)}</option>`)
    .join("")}</select></div>`;
}

export function checks(legend: string, name: string, options: Array<[string, string]>, selected: string[] = []) {
  return `<fieldset style="border:0;padding:0;margin:12px 0 0"><legend style="font-weight:600;color:var(--ink);font-size:15px;margin-bottom:6px">${esc(legend)}</legend><div class="checks">${options
    .map(([v, l]) => `<label class="inline"><input type="checkbox" name="${esc(name)}" value="${esc(v)}"${selected.includes(v) ? " checked" : ""}> ${esc(l)}</label>`)
    .join("")}</div></fieldset>`;
}

// Body values that may arrive once (string) or many times (array).
export const many = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v == null || v === "" ? [] : [String(v)]);

// Messages shown after a redirect, chosen by key so nothing from the URL is ever echoed.
const NOTICES: Record<string, string> = {
  saved: "Saved.",
  created: "Created.",
  deactivated: "Deactivated.",
  reactivated: "Reactivated.",
  submitted: "Sent for review.",
  approved: "Approved.",
  returned: "Sent back to the author with your note.",
  published: "Published. Girls receive this version from now on.",
  uploaded: "Recording uploaded.",
  claimed: "You are now handling this case.",
  assigned: "Case assigned.",
  unassigned: "Case is back in the shared queue.",
  noted: "Note added.",
  escalated: "Escalated to the nurse on call. They have been alerted.",
  handled: "Marked as handled.",
  reopened: "Case reopened.",
  sent: "Message sent.",
  "2fa-reset": "Two-step login reset. They set it up again at their next login.",
  approved_batch: "Payouts approved.",
  paying: "Payments sent to M-Pesa. Results arrive in a few minutes.",
  retried: "Payout queued again.",
  marked_paid: "Payout recorded as paid.",
  cancelled: "Payout cancelled.",
};
const ERRORS: Record<string, string> = {
  invalid: "Some details were missing or not valid. Please check and try again.",
  exists: "That already exists.",
  self: "You can't do that to your own account.",
  own_work: "You can't approve your own work: another reviewer must approve it.",
  state: "That can't be done in its current state (someone may have changed it). Reload and try again.",
  placeholders: "The translation must keep every {placeholder} from the English text, exactly as written.",
  file: "Upload an audio file (ogg, mp3, m4a, wav or webm) of at most 5 MB.",
  no_phone: "This Dada has no valid phone number for M-Pesa. Add one on her staff page first.",
  recall: "Not promoted: the new danger-sign model would miss more girls in at least one danger class than the live one.",
};
export function notice(query: Record<string, unknown>): string {
  const ok = NOTICES[String(query.done ?? "")];
  const err = ERRORS[String(query.error ?? "")];
  return (ok ? `<div class="notice ok-notice" role="status">${esc(ok)}</div>` : "") + (err ? `<div class="notice" role="alert">${esc(err)}</div>` : "");
}

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  in_review: "In review",
  approved: "Approved",
  published: "Published",
  archived: "Archived",
};
export const statusTag = (s: string) => `<span class="tag ${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

export const when = (d: string | Date | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");
