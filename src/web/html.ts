// Minimal server-rendered pages: fast on slow connections and cheap phones.
// Visual language: DM Sans, an italic-semibold word inside plain headings, small eyebrow labels,
// soft cards with thin borders, pill buttons, navy ink with Ubah's coral accent.

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Heading with one emphasised word: h("Partner", "dashboard") -> <em>Partner</em> dashboard
export function h1(em: string, rest: string, eyebrow = ""): string {
  return `${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1><em>${esc(em)}</em> ${esc(rest)}</h1>`;
}

const CSS = `
:root{--ink:#151D2C;--text:#2F3F52;--muted:#5B6575;--line:#ECE8E3;--line2:#C4C5E0;--bg:#F7F6F4;--card:#fff;--soft:#F3F0EE;
--accent:#C8462B;--accent-ink:#fff;--accent-soft:#FBE9E3;--ok:#1E5B3A;--okbg:#E2F1E8;--warn:#9A3412;--warnbg:#FBE9E3}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-underline-offset:3px}
header.top{background:#fff;border-bottom:1px solid var(--line);padding:14px 20px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between}
header.top .brand{font-weight:700;font-size:22px;color:var(--ink);letter-spacing:-.5px;text-decoration:none}
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
button:focus-visible,.btn:focus-visible,a:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--line2);outline-offset:2px}
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
`;

export function page(title: string, body: string, nav = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · Ubah</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,600&display=swap" rel="stylesheet">
<style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="/staff">ubah</a><nav>${nav}</nav></header><main>${body}</main></body></html>`;
}
