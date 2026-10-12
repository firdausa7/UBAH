import { Router } from "express";
import type { Db } from "../db.js";
import { handleIncoming, sendDueCheckins } from "../engine.js";
import { hashPhone } from "../privacy.js";
import { page, esc, h1 } from "./html.js";

// Chat as a girl from a browser, without WhatsApp or a phone. For demos and testing only.

export function simulatorRouter(db: Db): Router {
  const r = Router();

  r.get("/", (req, res) => {
    const phone = String(req.query.phone ?? "0700000001");
    res.send(
      page(
        "Simulator",
        `${h1("Try", "Ubah as a girl would", "Simulator")}<p class="lead">Chat as she would on WhatsApp or SMS. Uses a fake number; nothing is sent to a real phone.</p>
<div class="card"><form id="who" class="row"><label for="phone" style="margin:0">Fake phone number</label><input id="phone" name="phone" value="${esc(phone)}" style="max-width:220px"><button class="secondary">Switch</button></form></div>
<div class="card" style="max-width:520px"><div id="thread" style="min-height:360px;max-height:60vh;overflow:auto"></div>
<form id="send" class="row" style="margin-top:10px"><input id="text" placeholder="Type a message" autocomplete="off" style="flex:1">
<label class="inline" style="margin:0"><input type="checkbox" id="asvoice"> as voice note</label><button class="accent">Send</button></form>
<div class="row" style="margin-top:10px"><button class="secondary" id="skip" type="button">Skip 3 days (send check-ins)</button></div></div>
<script>
const thread=document.getElementById('thread');const phone=${JSON.stringify(phone)};
function add(t,cls){const d=document.createElement('div');d.className='bubble '+cls;d.textContent=t;thread.appendChild(d);thread.scrollTop=thread.scrollHeight}
async function load(){const r=await fetch('/simulator/history?phone='+encodeURIComponent(phone));const j=await r.json();thread.innerHTML='';j.forEach(m=>add((m.kind==='voice'?'[voice note] ':'')+m.body,m.direction==='in'?'in':'out'))}
document.getElementById('send').onsubmit=async e=>{e.preventDefault();const i=document.getElementById('text');const t=i.value.trim();if(!t)return;i.value='';
await fetch('/simulator/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone,text:t,voice:document.getElementById('asvoice').checked})});load()};
document.getElementById('skip').onclick=async()=>{await fetch('/simulator/skip',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone})});load()};
load();
</script>`,
        `<a href="/staff/login">Staff login</a>`,
      ),
    );
  });

  r.get("/history", async (req, res) => {
    const rows = await db.query(
      `SELECT m.direction, m.kind, m.body FROM messages m JOIN users u ON u.id = m.user_id WHERE u.phone_hash = $1 ORDER BY m.id`,
      [hashPhone(String(req.query.phone ?? ""))],
    );
    res.json(rows);
  });

  r.post("/send", async (req, res) => {
    const { phone, text, voice } = req.body ?? {};
    if (!phone || !text) return res.status(400).json({ error: "phone and text required" });
    await handleIncoming(db, voice ? { channel: "simulator", from: phone, voice: { audio: Buffer.from("simulated"), mimeType: "audio/ogg", mockText: text } } : { channel: "simulator", from: phone, text });
    res.json({ ok: true });
  });

  // Pretend 3 days have passed: makes this girl's check-ins due, then sends them.
  r.post("/skip", async (req, res) => {
    await db.query(`UPDATE checkins SET due_at = now() - interval '1 minute' WHERE sent_at IS NULL AND user_id IN (SELECT id FROM users WHERE phone_hash = $1)`, [hashPhone(String(req.body?.phone ?? ""))]);
    const n = await sendDueCheckins(db);
    res.json({ sent: n });
  });

  return r;
}
