import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import type { Db } from "../db.js";
import { config } from "../config.js";
import { refreshCaches } from "../caches.js";
import { LANGUAGES, t } from "../i18n.js";
import { esc, STAGING_BANNER } from "./html.js";

// The public landing page at "/", for girls first: what Ubah is, how it works, and how to reach it,
// in lavender with the Ubah rose. Every sentence is a "land_…" string in the Translation studio
// (?lang=so|sw|om|en); untranslated sentences show in English. Contact details come from settings,
// so nothing made-up is ever shown: a channel without a number says "coming soon".

const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");
const ASSETS: Record<string, { file: string; type: string }> = {
  "rose.png": { file: "rose.png", type: "image/png" },
  "girl.jpg": { file: "girl.jpg", type: "image/jpeg" },
};
const assetCache = new Map<string, Buffer>();
const asset = (name: string) => {
  if (!assetCache.has(name)) assetCache.set(name, readFileSync(join(ASSET_DIR, ASSETS[name].file)));
  return assetCache.get(name)!;
};

const QUICK_EXIT_JS = `document.querySelectorAll("[data-quick-exit]").forEach(function (b) {
  b.addEventListener("click", function (e) { e.preventDefault(); location.replace("https://www.google.com/search?q=weather+today"); });
});`;

const CSS = `
:root{--plum:#2E1F3E;--text:#4A3F55;--muted:#5B5066;--cream:#FFF8F3;--white:#FFFFFF;--lavender:#E6DBFA;--blush:#FBE1E7;--line:#D8CAF3;--accent:#623ECC;--pink:#F7C6D0;--mist:#E2D6F6}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--cream);color:var(--plum);font:17px/1.6 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
h1,h2{font-family:"Cormorant Garamond",Georgia,serif;font-weight:600;color:var(--plum);text-wrap:balance}
a{color:var(--accent);text-underline-offset:3px}a:hover{color:var(--plum)}
a:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:3px;border-radius:4px}
.wrap{max-width:1180px;margin:0 auto;padding-inline:24px}
.exitbar{background:var(--plum);color:var(--cream);font-size:14px;padding:8px 16px;display:flex;flex-wrap:wrap;gap:10px;justify-content:center;align-items:center}
.exitbar a{color:var(--pink);font-weight:700}
header.top{display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;justify-content:space-between;padding-block:20px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none}
.brand img{height:44px;width:auto;display:block}
.brand span{font-family:"Cormorant Garamond",Georgia,serif;font-size:30px;font-weight:600;letter-spacing:3px;color:var(--plum)}
nav.main{display:flex;flex-wrap:wrap;gap:4px 26px;font-size:16px}
nav.main a{color:var(--plum);text-decoration:none;padding:10px 0}
nav.main a:hover{color:var(--accent)}
.langs{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:14px}
.langs a{color:var(--muted);text-decoration:none;min-height:32px;display:inline-flex;align-items:center}
.langs a[aria-current]{color:var(--plum);font-weight:700}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 28px;border-radius:999px;background:var(--accent);color:var(--white);text-decoration:none;font-weight:500;border:1.5px solid var(--accent)}
.btn:hover{background:var(--plum);border-color:var(--plum);color:var(--white)}
.btn.ghost{background:transparent;color:var(--accent)}
.btn.ghost:hover{background:var(--accent);color:var(--white)}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.hero{display:flex;flex-wrap:wrap;gap:56px;align-items:center;padding-block:48px 96px}
.hero > div{flex:1 1 440px;min-width:0}
.meaning{margin:0 0 14px;font-size:13px;font-weight:500;letter-spacing:3px;text-transform:uppercase;color:#4A3B6B}
h1{margin:0 0 6px;font-size:clamp(44px,6vw,64px);line-height:1.05}
.hero h2{margin:0 0 28px;font-size:clamp(28px,3.6vw,40px);line-height:1.15;font-weight:500;font-style:italic;color:var(--accent)}
.lead{margin:0 0 24px;font-size:18px;line-height:1.7;color:var(--text);max-width:560px}
.talk{margin:0 0 24px;color:var(--text)}
.talk a{font-weight:700}
.portrait img{width:100%;max-width:520px;height:clamp(360px,48vw,520px);object-fit:cover;object-position:center top;border-radius:28px;display:block;margin-left:auto}
.portrait p{margin:10px 0 0;font-size:12px;color:var(--muted);text-align:right}
section{scroll-margin-top:16px}
.center{text-align:center}
.sec{padding-block:96px}
.sec h2{margin:0 0 10px;font-size:clamp(34px,4.4vw,48px);line-height:1.1}
.sec h2 em{font-style:italic;color:var(--accent)}
.sub{margin:0 auto;font-size:18px;line-height:1.6;color:var(--text);max-width:640px}
.white{background:var(--white)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:44px;text-align:left}
.card{border-radius:24px;padding:28px}
.card.lav{background:var(--lavender)}.card.blush{background:var(--blush)}.card.plain{background:var(--white);border:1px solid var(--line)}
.card svg{width:30px;height:30px;fill:none;stroke:var(--plum);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.card h3{margin:14px 0 8px;font-size:21px;font-weight:500}
.card p{margin:0;font-size:16px;line-height:1.55;color:#3E3349}
.steps{list-style:none;margin:56px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:32px}
.steps li{display:flex;flex-direction:column;align-items:center;gap:14px;font-size:17px;font-weight:500}
.steps .num{width:64px;height:64px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-family:"Cormorant Garamond",Georgia,serif;font-size:26px;font-weight:600}
.steps li:nth-child(odd) .num{background:var(--lavender)}.steps li:nth-child(even) .num{background:var(--blush)}
.split{display:flex;flex-wrap:wrap;gap:56px;align-items:center}
.split > div{flex:1 1 440px;min-width:0}
.split .art{flex:1 1 340px;border-radius:28px}
.split p{margin:0 0 18px;font-size:18px;line-height:1.7;color:var(--text)}
.rosebox{background:var(--lavender);min-height:360px;display:flex;align-items:center;justify-content:center}
.rosebox img{width:62%;max-width:320px;height:auto;display:block}
.source{font-size:14px;color:var(--muted)}
.more{font-weight:700;text-decoration:none}
.chat{background:var(--blush);padding:36px;display:flex;flex-direction:column;gap:14px}
.chat .in{align-self:flex-end;background:var(--white);border-radius:20px 20px 4px 20px;padding:14px 18px;font-size:15px;color:var(--text)}
.chat .out{background:var(--plum);color:var(--cream);border-radius:20px 20px 20px 4px;padding:16px 18px;font-size:16px;line-height:1.5}
.chat .pass{background:var(--white);border-radius:16px;padding:14px 18px;font-size:15px}
.faq{max-width:820px;margin:0 auto}
.faq .list{display:flex;flex-direction:column;border-top:1px solid var(--line);margin-top:36px;text-align:left}
details{border-bottom:1px solid var(--line);padding:22px 4px}
summary{cursor:pointer;font-size:18px;font-weight:500;list-style-position:inside}
details p{margin:12px 0 0;font-size:16px;line-height:1.65;color:var(--text)}
footer.site{background:var(--plum);color:var(--mist);padding-block:64px 36px}
footer .cols{display:flex;flex-wrap:wrap;gap:40px;justify-content:space-between}
footer .about{flex:1 1 320px;min-width:0}
footer .about .brand span{color:var(--cream)}
footer .about p{margin:14px 0 0;max-width:380px}
footer .col{flex:0 1 240px;display:flex;flex-direction:column;gap:8px;font-size:15px}
footer .label{margin:0 0 6px;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:var(--pink)}
footer a{color:var(--mist)}footer a:hover{color:var(--white)}
footer .col p{margin:0}
footer .fine{margin:44px 0 0;font-size:13px;color:#B9AAC9;display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between}
@media (max-width:720px){.hero{padding-block:24px 64px;gap:32px}.sec{padding-block:64px}header.top{padding-block:14px}}
`;

const ICONS = {
  listens: '<rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0M12 18v3"></path>',
  language: '<path d="M4 5h9M8.5 3v2M6 5c0 4 3 7 6 8M11 5c0 4-3 7-6 9"></path><path d="M13 21l4-10 4 10M14.5 17.5h5"></path>',
  talks: '<path d="M4 10v4h4l5 4V6L8 10z"></path><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"></path>',
  person: '<path d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z"></path><path d="M9 12l2 2 4-4"></path>',
};

export function landingPage(lang: string): string {
  const L = (key: string, vars: Record<string, string> = {}) => esc(t(lang, key, vars));
  const p = config.public;
  const wa = p.whatsappNumber.replace(/\D/g, "");
  const waLink = wa ? `https://wa.me/${wa}?text=${encodeURIComponent("Hi Ubah")}` : "";
  const q = `?lang=${esc(lang)}`;
  const langs = Object.entries(LANGUAGES)
    .map(([code, name]) => `<a href="/?lang=${code}" lang="${code}"${code === lang ? ' aria-current="true"' : ""}>${esc(name)}</a>`)
    .join("");
  const brand = `<a class="brand" href="/${q}"><img src="/assets/rose.png" alt="" width="59" height="44"><span>UBAH</span></a>`;
  const card = (cls: string, icon: keyof typeof ICONS, key: string) =>
    `<div class="card ${cls}"><svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg><h3>${L(`${key}_t`)}</h3><p>${L(key)}</p></div>`;
  const faq = (key: string, extra = "") => `<details><summary>${L(`land_faq_${key}_q`)}</summary><p>${L(`land_faq_${key}_a`)}${extra}</p></details>`;
  const contact = (label: string, value: string, href = "") =>
    `<p>${label}: ${value ? (href ? `<a href="${esc(href)}">${esc(value)}</a>` : `<strong>${esc(value)}</strong>`) : L("land_coming_soon")}</p>`;

  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubah · ${L("land_title_tag")}</title>
<meta name="description" content="${L("land_h2")}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#FFF8F3">
<link rel="icon" href="/assets/rose.png" type="image/png">
<link href="/ui/fonts.css" rel="stylesheet">
<style>${CSS}</style></head><body>
${config.stage === "staging" ? STAGING_BANNER : ""}<div class="exitbar"><span>${L("land_exit_q")}</span><a href="https://www.google.com/search?q=weather+today" data-quick-exit rel="noreferrer">${L("land_exit_now")}</a></div>

<header class="top wrap">${brand}
<nav class="main" aria-label="Main"><a href="#about">${L("land_nav_about")}</a><a href="#how">${L("land_nav_how")}</a><a href="#solution">${L("land_nav_solution")}</a><a href="#faq">${L("land_nav_faq")}</a></nav>
<nav class="langs" aria-label="Language">${langs}</nav>
<a class="btn" href="/me">${L("land_open")}</a></header>

<main>
<section id="top" class="hero wrap">
<div>
<p class="meaning">${L("land_meaning")}</p>
<h1>${L("land_h1")}</h1>
<h2>${L("land_h2")}</h2>
<p class="lead">${L("land_lead")}</p>
${waLink ? `<p class="talk">${L("land_talk_now")} <a href="${esc(waLink)}">${L("land_chat_whatsapp")}</a></p>` : ""}
<div class="btns"><a class="btn" href="/me">${L("land_open_app")}</a><a class="btn ghost" href="#how">${L("land_learn_more")}</a></div>
</div>
<div class="portrait"><img src="/assets/girl.jpg" alt="${L("land_girl_alt")}" width="455" height="740"><p>${L("land_girl_note")}</p></div>
</section>

<section id="ai" class="sec wrap center" aria-labelledby="meet">
<h2 id="meet">${L("land_meet_h")} <em>${L("land_meet_em")}</em></h2>
<p class="sub">${L("land_meet_lead")}</p>
<div class="cards">${card("lav", "listens", "land_listens")}${card("blush", "language", "land_language")}${card("lav", "talks", "land_talks")}${card("plain", "person", "land_person")}</div>
<p style="margin-top:36px"><a class="btn" href="/me">${L("land_ask_cta")}</a></p>
</section>

<section id="how" class="sec white" aria-labelledby="how-h"><div class="wrap center">
<h2 id="how-h">${L("land_how_h")}</h2>
<p class="sub">${L("land_how_lead")}</p>
<ol class="steps">${[1, 2, 3, 4, 5].map((n) => `<li><span class="num" aria-hidden="true">0${n}</span><span>${L(`land_step${n}`)}</span></li>`).join("")}</ol>
</div></section>

<section id="about" class="sec wrap split" aria-labelledby="solve">
<div class="art rosebox"><img src="/assets/rose.png" alt="" width="320" height="237"></div>
<div>
<h2 id="solve">${L("land_solve_h")}</h2>
<p>${L("land_solve_1")}</p>
<p>${t(lang, "land_solve_2", { count: "{count}" }).split("{count}").map(esc).join('<strong style="color:var(--plum)">180,000</strong>')} <span class="source">${L("land_solve_source")}</span></p>
<a class="more" href="#solution">${L("land_learn_more")} →</a>
</div>
</section>

<section id="solution" class="sec white" aria-labelledby="care"><div class="wrap split" style="flex-wrap:wrap-reverse">
<div>
<h2 id="care">${L("land_care_h")}</h2>
<p>${L("land_care_1")}</p>
<p>${L("land_care_2")}</p>
<a class="more" href="#faq">${L("land_learn_more")} →</a>
</div>
<div class="art chat" aria-hidden="true"><div class="in">${L("land_chat_voice")}</div><div class="out">${L("land_chat_reply")}</div><div class="pass"><strong>${L("land_chat_pass")}</strong> · ${L("land_chat_pass_sub")}</div></div>
</div></section>

<section id="faq" class="sec wrap" aria-labelledby="faq-h"><div class="faq center">
<h2 id="faq-h">${L("land_faq_h")}</h2>
<div class="list">${faq("cost")}${faq("private")}${faq("read")}${faq("phone")}${faq("dada")}${faq("partner", p.contactEmail ? ` ${L("land_faq_write")} <a href="mailto:${esc(p.contactEmail)}">${esc(p.contactEmail)}</a>.` : "")}${faq("doctor")}</div>
</div></section>
</main>

<footer class="site"><div class="wrap">
<div class="cols">
<div class="about">${brand}<p>${L("land_footer_tagline")}</p></div>
<nav class="col" aria-label="${L("land_footer_links")}"><p class="label">${L("land_footer_links")}</p><a href="#about">${L("land_nav_about")}</a><a href="#how">${L("land_nav_how")}</a><a href="#faq">${L("land_nav_faq")}</a><a href="/login">${L("land_staff_login")}</a></nav>
<div class="col"><p class="label">${L("land_footer_touch")}</p>
${contact(L("land_whatsapp"), p.whatsappNumber, waLink)}${contact(L("land_sms"), p.smsNumber)}${contact(L("land_ussd"), p.ussdCode)}
<p><a href="/me">${L("land_app")}</a></p>${p.contactEmail ? `<p><a href="mailto:${esc(p.contactEmail)}">${esc(p.contactEmail)}</a></p>` : ""}</div>
</div>
<div class="fine"><span>© ${new Date().getFullYear()} Ubah. ${L("land_footer_built")}</span><span>${L("land_footer_danger")}</span></div>
</div></footer>
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
  // The landing page's two images (the Ubah rose and the illustration). Nothing else is served here.
  r.get("/assets/:name", (req, res) => {
    const name = String(req.params.name);
    if (!Object.hasOwn(ASSETS, name)) return res.status(404).end();
    const a = ASSETS[name];
    res.type(a.type).setHeader("Cache-Control", "public, max-age=604800");
    res.send(asset(name));
  });
  return r;
}
