import { Router } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { refreshCaches } from "../caches.js";
import { LANGUAGES, t } from "../i18n.js";
import { esc, STAGING_BANNER } from "./html.js";

// The public landing page at "/": the Ubah story (ubah is Somali for "flower"), how the closed loop
// works, how to reach Ubah, and the privacy promise. Every sentence is a "land_…" string in the
// Translation studio (?lang=so|sw|om|en); untranslated sentences show in English. Contact details come
// from settings, so nothing made-up is ever shown: a channel without a number says "coming soon".

// A simple flower: six coral petals around a navy centre, on a stem.
export const FLOWER_SVG = (size: number, label = "") => `<svg width="${size}" height="${size}" viewBox="0 0 120 120" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>
<path d="M60 70 C60 90 58 104 56 116" stroke="#2F6B4F" stroke-width="4" fill="none" stroke-linecap="round"/>
<path d="M58 98 C46 92 40 84 40 78 C50 80 56 88 58 98 Z" fill="#2F6B4F"/>
<g transform="translate(60 46)">
${[0, 60, 120, 180, 240, 300].map((a) => `<ellipse cx="0" cy="-20" rx="11" ry="20" fill="#C8462B" opacity="0.92" transform="rotate(${a})"/>`).join("")}
<circle r="10" fill="#151D2C"/><circle r="4" fill="#F7C873"/>
</g></svg>`;

const QUICK_EXIT_JS = `document.querySelectorAll("[data-quick-exit]").forEach(function (b) {
  b.addEventListener("click", function (e) { e.preventDefault(); location.replace("https://www.google.com/search?q=weather+today"); });
});`;

export function landingPage(lang: string): string {
  const L = (key: string, vars: Record<string, string> = {}) => esc(t(lang, key, vars));
  const p = config.public;
  const anyChannel = Boolean(p.smsNumber || p.whatsappNumber || p.ussdCode);
  const channel = (name: string, how: string, value: string) =>
    `<div class="channel"><div class="eyebrow">${name}</div>${value ? `<p>${how} <strong class="big">${esc(value)}</strong></p>` : `<p class="muted">${L("land_coming_soon")}</p>`}</div>`;
  const step = (n: number, key: string, highlight = false) => `<li${highlight ? ' class="key"' : ""}><h3>${L(`land_step${n}_title`)}</h3><p>${L(`land_step${n}_body`)}</p></li>`;
  const langs = Object.entries(LANGUAGES)
    .map(([code, name]) => `<a href="/?lang=${code}" lang="${code}"${code === lang ? ' aria-current="true"' : ""}>${esc(name)}</a>`)
    .join("");
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubah · ${L("land_title_tag")}</title>
<meta name="description" content="${L("land_lead")}">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="/app/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,600&display=swap" rel="stylesheet">
<style>
:root{--ink:#151D2C;--text:#2F3F52;--muted:#5B6575;--line:#ECE8E3;--bg:#F7F6F4;--soft:#F3F0EE;--accent:#C8462B;--leaf:#2F6B4F}
*{box-sizing:border-box}
body{margin:0;font:17px/1.55 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-underline-offset:3px}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 20px;background:rgba(247,246,244,.94);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:24px;color:var(--accent);text-decoration:none;letter-spacing:-.5px}
.langs{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px}.langs a{color:var(--muted);text-decoration:none;min-height:32px;display:inline-flex;align-items:center}.langs a[aria-current]{color:var(--ink);font-weight:700}
.exit{min-height:44px;padding:0 16px;border-radius:999px;border:2px solid var(--ink);background:#fff;color:var(--ink);font:inherit;font-weight:700;font-size:15px;text-decoration:none;display:inline-flex;align-items:center;white-space:nowrap}
main{max-width:1040px;margin:0 auto;padding:0 20px 64px}
section{padding:56px 0;border-bottom:1px solid var(--line)}
section:last-child{border-bottom:0}
.eyebrow{font-size:14px;color:var(--muted);letter-spacing:.2px;margin-bottom:6px}
h1{font-weight:400;font-size:clamp(36px,6vw,60px);line-height:1.05;color:var(--ink);margin:0 0 18px;letter-spacing:-1px}
h2{font-weight:400;font-size:clamp(26px,3.5vw,36px);line-height:1.15;color:var(--ink);margin:0 0 16px;letter-spacing:-.5px}
h1 em,h2 em{font-style:italic;font-weight:600}
h3{font-size:19px;color:var(--ink);margin:10px 0 6px}
.lead{font-size:20px;max-width:620px;margin:0 0 26px}
.muted{color:var(--muted)}
.hero{display:grid;grid-template-columns:1.4fr 1fr;gap:32px;align-items:center;padding-top:40px}
.hero svg{width:100%;max-width:320px;height:auto;justify-self:center}
.btns{display:flex;flex-wrap:wrap;gap:10px}
.btn{min-height:50px;padding:0 24px;border-radius:999px;border:1px solid var(--ink);background:var(--ink);color:#fff;font-weight:700;text-decoration:none;display:inline-flex;align-items:center}
.btn.accent{background:var(--accent);border-color:var(--accent)}.btn.secondary{background:#fff;color:var(--ink)}
.meaning{font-size:15px;color:var(--muted);margin:0 0 6px}
.story{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:28px}
.story p{margin:0 0 12px}
.loop{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;counter-reset:step}
.loop li{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px;counter-increment:step}
.loop li::before{content:counter(step);display:inline-flex;width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;font-weight:700;align-items:center;justify-content:center}
.loop li.key{border:2px solid var(--accent)}
.loop p{margin:0;font-size:16px}
.channels{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin:8px 0 18px}
.channel{background:#fff;border:1px solid var(--line);border-radius:18px;padding:20px}.channel p{margin:0}
.big{font-size:22px;letter-spacing:.5px}
.promise{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px 28px;padding:0;margin:0;list-style:none}
.promise li{padding-left:28px;position:relative}.promise li::before{content:"";position:absolute;left:0;top:9px;width:12px;height:12px;border-radius:50%;background:var(--leaf)}
.partners{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.card{background:#fff;border:1px solid var(--line);border-radius:18px;padding:22px}
footer{max-width:1040px;margin:0 auto;padding:28px 20px 48px;font-size:14px;color:var(--muted);display:flex;flex-wrap:wrap;gap:12px 24px;justify-content:space-between}
@media (max-width:720px){.hero{grid-template-columns:1fr}.hero svg{max-width:200px;order:-1}section{padding:40px 0}header{flex-wrap:wrap}.langs{order:3;width:100%}}
</style></head><body>
${config.stage === "staging" ? STAGING_BANNER : ""}<header><a class="brand" href="/?lang=${esc(lang)}">${FLOWER_SVG(30)}ubah</a><nav class="langs" aria-label="Language">${langs}</nav><a class="exit" href="https://www.google.com/search?q=weather+today" data-quick-exit rel="noreferrer">${L("app_quick_exit")}</a></header>
<main>

<section class="hero">
<div>
<p class="meaning">${L("land_meaning")}</p>
<h1><em>${L("land_h1_em")}</em> ${L("land_h1_rest")}</h1>
<p class="lead">${L("land_lead")}</p>
<div class="btns"><a class="btn accent" href="/app/">${L("land_open_app")}</a><a class="btn secondary" href="#reach">${L("land_other_ways")}</a></div>
</div>
${FLOWER_SVG(320, t(lang, "land_flower_alt"))}
</section>

<section aria-labelledby="story">
<div class="eyebrow">${L("land_story_eyebrow")}</div>
<h2 id="story"><em>${L("land_story_h_em")}</em> ${L("land_story_h_rest")}</h2>
<div class="story"><p>${L("land_story_1")}</p><p>${L("land_story_2")}</p><p>${L("land_story_3")}</p></div>
</section>

<section aria-labelledby="how">
<div class="eyebrow">${L("land_how_eyebrow")}</div>
<h2 id="how"><em>${L("land_how_h_em")}</em> ${L("land_how_h_rest")}</h2>
<ol class="loop">${step(1, "")}${step(2, "")}${step(3, "")}${step(4, "", true)}</ol>
</section>

<section aria-labelledby="reach" id="reach">
<div class="eyebrow">${L("land_reach_eyebrow")}</div>
<h2><em>${L("land_reach_h_em")}</em> ${L("land_reach_h_rest")}</h2>
<p class="muted">${anyChannel ? L("land_reach_live") : L("land_reach_soon")}</p>
<div class="channels">${channel("SMS", L("land_sms_how"), p.smsNumber)}${channel("WhatsApp", L("land_whatsapp_how"), p.whatsappNumber)}${channel(L("land_ussd_name"), L("land_ussd_how"), p.ussdCode)}
<div class="channel"><div class="eyebrow">${L("land_smartphone")}</div><p><a href="/app/"><strong>${L("land_open_app")}</strong></a> — ${L("land_add_home")}</p></div></div>
</section>

<section aria-labelledby="privacy">
<div class="eyebrow">${L("land_promise_eyebrow")}</div>
<h2 id="privacy"><em>${L("land_promise_h_em")}</em> ${L("land_promise_h_rest")}</h2>
<ul class="promise">${[1, 2, 3, 4, 5, 6].map((n) => `<li>${L(`land_promise_${n}`)}</li>`).join("")}</ul>
</section>

<section aria-labelledby="partners">
<div class="eyebrow">${L("land_partners_eyebrow")}</div>
<h2 id="partners"><em>${L("land_partners_h_em")}</em> ${L("land_partners_h_rest")}</h2>
<div class="partners">
<div class="card"><h3>${L("land_clinics_title")}</h3><p>${L("land_clinics_body")}</p></div>
<div class="card"><h3>${L("land_health_title")}</h3><p>${L("land_health_body")}</p></div>
<div class="card"><h3>${L("land_team_title")}</h3><p>${L("land_team_body")}</p><p><a class="btn secondary" href="/staff/login">${L("land_staff_login")}</a></p></div>
</div>
</section>
</main>
<footer><span>${L("land_footer_built")}${p.contactEmail ? ` <a href="mailto:${esc(p.contactEmail)}">${esc(p.contactEmail)}</a>` : ""}</span><span>${L("land_footer_danger")}</span></footer>
<script src="/landing.js" defer></script>
</body></html>`;
}

export function landingRouter(db: Db): Router {
  const r = Router();
  r.get("/", async (req, res) => {
    await refreshCaches(db); // published translations
    const lang = String(req.query.lang ?? "en") in LANGUAGES ? String(req.query.lang) : "en";
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(landingPage(lang));
  });
  r.get("/landing.js", (_req, res) => {
    res.type("application/javascript").setHeader("Cache-Control", "public, max-age=3600");
    res.send(QUICK_EXIT_JS);
  });
  return r;
}
