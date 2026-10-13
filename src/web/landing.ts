import { Router } from "express";
import { config } from "../config.js";
import { esc } from "./html.js";

// The public landing page at "/": the Ubah story (ubah is Somali for "flower"), how the closed loop
// works, how to reach Ubah, and the privacy promise. Contact details come from settings, so nothing
// made-up is ever shown: a channel without a number says "coming soon".

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

function channelCards(): string {
  const p = config.public;
  const cards: Array<[string, string, string | null]> = [
    ["SMS", "Send <strong>HI</strong> to", p.smsNumber],
    ["WhatsApp", "Message", p.whatsappNumber],
    ["Any phone (USSD)", "Dial", p.ussdCode],
  ];
  return cards
    .map(
      ([name, verb, value]) => `<div class="channel"><div class="eyebrow">${name}</div>${
        value ? `<p>${verb} <strong class="big">${esc(value)}</strong></p>` : `<p class="muted">Coming soon</p>`
      }</div>`,
    )
    .join("");
}

export function landingPage(): string {
  const anyChannel = Boolean(config.public.smsNumber || config.public.whatsappNumber || config.public.ussdCode);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubah · private health help for girls</title>
<meta name="description" content="Ubah — Somali for 'flower' — gives girls and young women in northern Kenya private answers about their health, a referral pass to a partner clinic, and checks they were cared for with respect.">
<meta name="referrer" content="no-referrer">
<link rel="icon" href="/app/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;0,9..40,700;1,9..40,600&display=swap" rel="stylesheet">
<style>
:root{--ink:#151D2C;--text:#2F3F52;--muted:#5B6575;--line:#ECE8E3;--bg:#F7F6F4;--soft:#F3F0EE;--accent:#C8462B;--leaf:#2F6B4F}
*{box-sizing:border-box}
body{margin:0;font:17px/1.55 "DM Sans",system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text);background:var(--bg);-webkit-font-smoothing:antialiased}
a{color:var(--ink);text-underline-offset:3px}
header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;padding:12px 20px;background:rgba(247,246,244,.94);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;font-weight:700;font-size:24px;color:var(--accent);text-decoration:none;letter-spacing:-.5px}
.exit{min-height:44px;padding:0 16px;border-radius:999px;border:2px solid var(--ink);background:#fff;color:var(--ink);font:inherit;font-weight:700;font-size:15px;text-decoration:none;display:inline-flex;align-items:center}
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
@media (max-width:720px){.hero{grid-template-columns:1fr}.hero svg{max-width:200px;order:-1}section{padding:40px 0}}
</style></head><body>
<header><a class="brand" href="/">${FLOWER_SVG(30)}ubah</a><a class="exit" href="https://www.google.com/search?q=weather+today" data-quick-exit rel="noreferrer">Quick exit</a></header>
<main>

<section class="hero">
<div>
<p class="meaning"><em>Ubah</em> (oo-BAH) means <strong>flower</strong> in Somali.</p>
<h1><em>Private</em> health help, and care that's checked.</h1>
<p class="lead">Ubah gives girls and young women in northern Kenya private answers about their bodies and health — by voice note, chat, SMS or a basic phone — sends them to a trusted clinic with a free pass, and checks that they were seen and treated with respect.</p>
<div class="btns"><a class="btn accent" href="/app/">Open the Ubah app</a><a class="btn secondary" href="#reach">Other ways to reach Ubah</a></div>
</div>
${FLOWER_SVG(320, "A coral flower, Ubah's symbol")}
</section>

<section aria-labelledby="story">
<div class="eyebrow">Our story</div>
<h2 id="story"><em>Why</em> a flower?</h2>
<div class="story">
<p>A flower grows when it gets what it needs at the right time: water, light, and a safe place to put down roots. Girls are the same. With the right information, care that respects them, and somewhere safe to ask, they grow up healthy and strong.</p>
<p>For many refugee and pastoralist girls, that care is hard to reach. Help is in a language they don't read, questions feel too private to ask out loud, and after a referral no one checks whether they were actually helped — or how they were treated.</p>
<p>Ubah is built to tend that whole journey: an answer in her own language, a referral to a clinic she can trust, and a gentle check-in afterwards. Every check-in helps clinics become places where more girls can grow.</p>
</div>
</section>

<section aria-labelledby="how">
<div class="eyebrow">How it works</div>
<h2 id="how"><em>One</em> closed loop</h2>
<ol class="loop">
<li><h3>Ask privately</h3><p>A girl asks in Somali, Kiswahili, Afaan Oromoo or English — by voice note or text. Answers come only from information checked by health partners.</p></li>
<li><h3>Get a pass</h3><p>If she needs care, she gets a free referral pass for a verified, youth-friendly partner clinic. She shows the code at the desk — no need to explain again.</p></li>
<li><h3>A person when it matters</h3><p>Danger signs — heavy bleeding, violence, thoughts of self-harm — go straight to a trained Dada or nurse, never to a machine alone.</p></li>
<li class="key"><h3>We check back</h3><p>Three days later, Ubah asks: did you go, and were you treated with respect? Her anonymous answer becomes each clinic's dignity score.</p></li>
</ol>
</section>

<section aria-labelledby="reach" id="reach">
<div class="eyebrow">Reach Ubah</div>
<h2><em>Any</em> phone works</h2>
<p class="muted">${anyChannel ? "Free and private. No name, no account." : "Ubah is being tested. These ways to reach Ubah open soon."}</p>
<div class="channels">${channelCards()}<div class="channel"><div class="eyebrow">Smartphone</div><p><a href="/app/"><strong>Open the Ubah app</strong></a> — add it to your home screen.</p></div></div>
</section>

<section aria-labelledby="privacy">
<div class="eyebrow">Our promise</div>
<h2 id="privacy"><em>Your</em> privacy comes first</h2>
<ul class="promise">
<li>We never ask your name. Staff see a short code, not who you are.</li>
<li>Your phone number is scrambled and locked away.</li>
<li>Clinics see only your pass code and the help you need.</li>
<li>Send <strong>STOP</strong> to stop messages, <strong>DELETE</strong> to erase your chats.</li>
<li>Lock the app with a PIN. <strong>Quick exit</strong> leaves at once.</li>
<li>Clinic scores only show when five or more girls have answered.</li>
</ul>
</section>

<section aria-labelledby="partners">
<div class="eyebrow">For partners</div>
<h2 id="partners"><em>Grow</em> it with us</h2>
<div class="partners">
<div class="card"><h3>Clinics</h3><p>Become a verified Ubah partner clinic: receive girls with a clear referral pass, and see — privately — how girls rate the respect they were shown.</p></div>
<div class="card"><h3>Health and protection partners</h3><p>Review and approve Ubah's health answers, agree safe referral pathways, and receive anonymous reports on what girls need.</p></div>
<div class="card"><h3>Ubah team</h3><p>Dadas, nurses, clinic desks and partners sign in here.</p><p><a class="btn secondary" href="/staff/login">Staff login</a></p></div>
</div>
</section>
</main>
<footer><span>Ubah is open source and built by HPI-SOLUTIONS KE LIMITED, Nairobi, Kenya.${config.public.contactEmail ? ` Contact: <a href="mailto:${esc(config.public.contactEmail)}">${esc(config.public.contactEmail)}</a>` : ""}</span><span>If you are in danger now, go to the nearest clinic or a person you trust.</span></footer>
<script src="/landing.js" defer></script>
</body></html>`;
}

export function landingRouter(): Router {
  const r = Router();
  r.get("/", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("html").send(landingPage());
  });
  r.get("/landing.js", (_req, res) => {
    res.type("application/javascript").setHeader("Cache-Control", "public, max-age=3600");
    res.send(QUICK_EXIT_JS);
  });
  return r;
}
