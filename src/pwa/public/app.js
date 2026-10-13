/* Ubah girls' app. Plain JavaScript, no framework, so it loads fast on 3G and old phones.
 * Privacy: no name or phone number. The device holds a random secret (encrypted with her PIN when one
 * is set); the conversation lives on the server, never stored on the phone. Quick exit on every screen. */
"use strict";

const KEY = { token: "ubah.t", lockedToken: "ubah.tenc", lang: "ubah.lang" };
const S = { token: null, lang: null, strings: {}, languages: {}, msgs: [], lastId: 0, outbox: [], services: new Set(), recording: null, poll: null };

// ---------- small helpers ----------
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: works for this visit only */
    }
  },
  del(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

function tr(key, vars) {
  let s = S.strings[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

// Builds DOM nodes; text always goes in as text, never as HTML.
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, opts = {}) {
  const headers = { ...opts.headers };
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(`/app/api${path}`, { method: opts.method || "GET", headers, body: opts.body });
  if (res.status === 401 && S.token) {
    // The session was wiped (or never existed here): start fresh.
    S.token = null;
    store.del(KEY.token);
    store.del(KEY.lockedToken);
    await ensureSession();
    return api(path, opts);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// ---------- PIN lock (the device secret is encrypted with a key derived from the PIN) ----------
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function pinKey(pin, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function lockToken(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await pinKey(pin, salt), enc.encode(S.token));
  store.set(KEY.lockedToken, JSON.stringify({ salt: b64(salt), iv: b64(iv), data: b64(data) }));
  store.del(KEY.token);
}
async function unlockToken(pin) {
  const rec = JSON.parse(store.get(KEY.lockedToken));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(rec.iv) }, await pinKey(pin, unb64(rec.salt)), unb64(rec.data));
  return new TextDecoder().decode(plain);
}
const hasPin = () => Boolean(store.get(KEY.lockedToken));

// ---------- session, strings ----------
async function ensureSession() {
  if (S.token) return;
  const plain = store.get(KEY.token);
  if (plain) {
    S.token = plain;
    return;
  }
  if (hasPin()) return; // locked: wait for the PIN
  const { token } = await api("/session", { method: "POST" });
  S.token = token;
  store.set(KEY.token, token);
}

async function loadStrings(lang) {
  const r = await api(`/strings?lang=${encodeURIComponent(lang || "en")}`);
  S.strings = r.strings;
  S.languages = r.languages;
  S.staging = r.stage === "staging";
  document.documentElement.lang = r.lang;
}

// ---------- quick exit ----------
function quickExit() {
  S.token = null;
  S.msgs = [];
  document.getElementById("app").textContent = "";
  // Replace this page in history so Back doesn't return to Ubah.
  location.replace("https://www.google.com/search?q=weather+today");
}

// ---------- layout ----------
const VIEWS = ["home", "ask", "care", "passes", "learn", "account"];
const route = () => (VIEWS.includes(location.hash.slice(2)) ? location.hash.slice(2) : "home");
const go = (v) => {
  location.hash = `#/${v}`;
};

function header(locked) {
  return h(
    "header",
    null,
    h("div", { class: "brand" }, "ubah"),
    h(
      "div",
      { style: "display:flex;gap:8px" },
      locked ? null : h("button", { class: "secondary exit", onclick: () => go("account") }, tr("app_nav_account")),
      h("button", { class: "exit", onclick: quickExit, "aria-label": tr("app_quick_exit") }, tr("app_quick_exit")),
    ),
  );
}

function tabs(current) {
  const items = [
    ["home", "app_nav_home"],
    ["ask", "app_nav_ask"],
    ["care", "app_nav_care"],
    ["passes", "app_nav_passes"],
    ["learn", "app_nav_learn"],
  ];
  return h("nav", { class: "tabs", "aria-label": "Ubah" }, items.map(([v, k]) => h("button", { onclick: () => go(v), "aria-current": current === v ? "page" : null }, tr(k))));
}

function mount(view, ...content) {
  const root = document.getElementById("app");
  root.textContent = "";
  if (S.staging) root.append(h("div", { class: "offline", role: "status" }, "TEST VERSION — not for real health questions."));
  if (!navigator.onLine) root.append(h("div", { class: "offline", role: "status" }, tr("app_offline")));
  root.append(header(), h("section", { class: "view" }, content), tabs(view));
}

// ---------- screens ----------
function viewLanguage() {
  const root = document.getElementById("app");
  root.textContent = "";
  root.append(
    header(),
    h(
      "section",
      { class: "view" },
      h("h1", null, tr("app_choose_language")),
      Object.entries(S.languages).map(([code, name]) =>
        h(
          "button",
          {
            class: "tile",
            onclick: async () => {
              await api("/me", { method: "PATCH", json: { language: code } });
              S.lang = code;
              store.set(KEY.lang, code);
              await loadStrings(code);
              go("home");
              render();
            },
          },
          h("b", null, name),
        ),
      ),
    ),
  );
}

function viewHome() {
  mount(
    "home",
    h("h1", null, h("em", null, "Salaan."), " ", tr("app_greeting")),
    h("p", { class: "muted" }, tr("app_tagline")),
    h("button", { class: "tile accent", onclick: () => go("ask") }, h("b", null, tr("app_home_ask")), h("span", null, tr("app_home_ask_sub"))),
    h("button", { class: "tile", onclick: () => go("care") }, h("b", null, tr("app_home_care")), h("span", { class: "muted" }, tr("app_home_care_sub"))),
    h("button", { class: "tile", onclick: () => go("learn") }, h("b", null, tr("app_home_learn")), h("span", { class: "muted" }, tr("app_home_learn_sub"))),
    h("p", { class: "note" }, tr("app_privacy")),
  );
}

async function refreshMessages() {
  const r = await api(`/messages?after=${S.lastId}`);
  addMessages(r.messages);
}
function addMessages(list) {
  for (const m of list) {
    if (m.id > S.lastId) {
      S.msgs.push(m);
      S.lastId = m.id;
    }
  }
}

async function sendText(text) {
  if (!navigator.onLine) {
    S.outbox.push(text); // kept in memory only, sent when back online
    S.msgs.push({ id: 0, from: "me", text, pending: true });
    return viewAsk();
  }
  S.msgs.push({ id: 0, from: "me", text, pending: true });
  viewAsk();
  try {
    const r = await api("/messages", { method: "POST", json: { text, after: S.lastId } });
    S.msgs = S.msgs.filter((m) => !m.pending);
    addMessages(r.messages);
  } catch {
    S.msgs = S.msgs.filter((m) => !m.pending);
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_error") });
  }
  if (route() === "ask") viewAsk();
}

async function toggleRecording() {
  if (S.recording) return S.recording.stop();
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_voice_unsupported") });
    return viewAsk();
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    S.msgs.push({ id: 0, from: "ubah", text: tr("app_voice_unsupported") });
    return viewAsk();
  }
  const rec = new MediaRecorder(stream);
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    S.recording = null;
    const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
    viewAsk();
    try {
      const r = await api(`/voice?after=${S.lastId}`, { method: "POST", body: blob, headers: { "content-type": blob.type.split(";")[0] } });
      addMessages(r.messages);
    } catch {
      S.msgs.push({ id: 0, from: "ubah", text: tr("app_error") });
    }
    viewAsk();
  };
  S.recording = rec;
  rec.start();
  viewAsk();
  setTimeout(() => rec.state === "recording" && rec.stop(), 60000); // at most one minute
}

function viewAsk() {
  const last = [...S.msgs].reverse().find((m) => m.from === "ubah");
  const thread = h(
    "div",
    { class: "thread" },
    S.msgs.filter((m) => m.text).map((m) => h("div", { class: `msg ${m.from === "me" ? "me" : "ubah"}` }, m.kind === "voice" ? "🎙 " : "", m.text, m.pending ? " …" : "")),
    last && last.options && last.options.length && last === S.msgs[S.msgs.length - 1]
      ? h("div", { class: "options" }, last.options.map((o) => h("button", { class: "secondary", onclick: () => sendText(o.id) }, o.title)))
      : null,
  );
  const input = h("input", { id: "q", placeholder: tr("app_type_question"), autocomplete: "off", "aria-label": tr("app_type_question"), maxlength: 1600 });
  const form = h(
    "form",
    {
      class: "composer",
      onsubmit: (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (v) sendText(v);
      },
    },
    input,
    h("button", { type: "submit", class: "accent round", "aria-label": tr("app_send") }, "➤"),
    h("button", { type: "button", class: `${S.recording ? "accent" : "secondary"} round`, "aria-label": S.recording ? tr("app_stop_recording") : tr("app_record"), onclick: toggleRecording }, S.recording ? "■" : "🎙"),
  );
  mount("ask", h("h1", null, h("em", null, tr("app_nav_ask")), " Ubah"), thread, form);
  window.scrollTo(0, document.body.scrollHeight);
}

async function viewCare() {
  const services = [...S.services];
  const r = await api(`/clinics?services=${encodeURIComponent(services.join(","))}`);
  const toggle = (s) => {
    if (S.services.has(s)) S.services.delete(s);
    else S.services.add(s);
    viewCare();
  };
  const clinic = (c, i) =>
    h(
      "div",
      { class: "card" },
      h("div", { style: "display:flex;justify-content:space-between;gap:8px" }, h("h2", null, c.name), c.verified ? h("span", { class: "tag" }, tr("app_verified")) : null),
      h("div", { class: "muted" }, [c.area, c.site, c.hours].filter(Boolean).join(" · ")),
      h("div", { class: "muted" }, c.services.map((s) => tr(`svc_${s}`)).join(", ")),
      h("div", { class: "muted" }, c.rating ? tr("app_rating", { yes: c.rating.respectful, total: c.rating.total }) : tr("app_no_rating")),
      i === 0
        ? h(
            "button",
            {
              class: "accent",
              disabled: !services.length,
              onclick: async () => {
                const p = await api("/passes", { method: "POST", json: { services } });
                await refreshMessages();
                go(p.code ? "passes" : "ask");
              },
            },
            services.length ? tr("app_get_pass") : tr("app_pick_first"),
          )
        : null,
    );
  mount(
    "care",
    h("h1", null, h("em", null, tr("app_nav_care"))),
    h("p", { class: "muted" }, tr("app_care_pick")),
    h("div", { class: "chips", role: "group" }, r.services.map((s) => h("button", { class: "chip", "aria-pressed": S.services.has(s) ? "true" : "false", onclick: () => toggle(s) }, tr(`svc_${s}`)))),
    r.clinics.length ? r.clinics.map(clinic) : h("p", { class: "note" }, tr("app_no_clinics")),
  );
}

async function viewPasses() {
  const r = await api("/passes");
  mount(
    "passes",
    h("h1", null, h("em", null, tr("app_nav_passes"))),
    r.passes.length
      ? r.passes.map((p) =>
          h(
            "div",
            { class: p.valid ? "pass" : "card" },
            h("span", { class: "muted" }, p.valid ? tr("app_pass_show") : p.redeemed ? tr("app_pass_used") : ""),
            h("span", { class: "code" }, p.code),
            h("span", null, [p.clinic, p.area].filter(Boolean).join(", ")),
            h("span", { class: "muted" }, p.services.map((s) => tr(`svc_${s}`)).join(", ")),
            h("span", { class: "muted" }, tr("app_pass_valid", { date: new Date(p.expiresAt).toLocaleDateString() })),
          ),
        )
      : h("p", { class: "note" }, tr("app_passes_empty")),
  );
}

async function viewLearn() {
  let r;
  try {
    r = await api(`/learn?lang=${encodeURIComponent(S.lang || "en")}`);
  } catch {
    r = { lessons: [] };
  }
  mount(
    "learn",
    h("h1", null, h("em", null, tr("app_nav_learn"))),
    r.lessons.length
      ? r.lessons.map((l) =>
          h(
            "article",
            { class: "card" },
            h("div", { class: "muted" }, tr(`cat_${l.category}`)),
            h("h2", null, l.title),
            h("p", { style: "margin:0;white-space:pre-wrap" }, l.body),
            l.translated ? null : h("p", { class: "muted" }, tr("translation_pending")),
            l.audio ? h("audio", { controls: true, preload: "none", src: l.audio }) : null,
          ),
        )
      : h("p", { class: "note" }, tr("app_learn_empty")),
  );
}

function pinPad(title, onDone, error) {
  let entry = "";
  const dots = h("div", { class: "dots", "aria-label": `0/6` });
  const paint = () => {
    dots.textContent = "";
    for (let i = 0; i < Math.max(4, entry.length); i++) dots.append(h("span", { class: i < entry.length ? "on" : "" }));
  };
  const press = (d) => {
    if (entry.length < 6) entry += d;
    paint();
  };
  paint();
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => h("button", { onclick: () => press(d) }, d));
  return h(
    "section",
    { class: "view", style: "align-items:center;justify-content:center" },
    h("h1", null, title),
    dots,
    error ? h("p", { class: "tag warn", role: "alert" }, error) : null,
    h(
      "div",
      { class: "keypad" },
      keys,
      h("button", { onclick: () => ((entry = entry.slice(0, -1)), paint()), "aria-label": "Delete" }, "⌫"),
      h("button", { onclick: () => press("0") }, "0"),
      h("button", { class: "accent", onclick: () => entry.length >= 4 && onDone(entry), "aria-label": "OK" }, "✓"),
    ),
  );
}

function viewLock(error) {
  const root = document.getElementById("app");
  root.textContent = "";
  root.append(
    header(true),
    pinPad(tr("app_pin_enter"), async (pin) => {
      try {
        S.token = await unlockToken(pin);
        start();
      } catch {
        viewLock(tr("app_pin_wrong"));
      }
    }, error),
  );
}

function viewAccount(message) {
  mount(
    "account",
    h("h1", null, h("em", null, tr("app_nav_account"))),
    message ? h("p", { class: "tag", role: "status" }, message) : null,
    h("div", { class: "card" }, h("h2", null, tr("app_language")), h("div", { class: "chips" }, Object.entries(S.languages).map(([code, name]) =>
      h("button", { class: "chip", "aria-pressed": S.lang === code ? "true" : "false", onclick: async () => {
        await api("/me", { method: "PATCH", json: { language: code } });
        S.lang = code;
        store.set(KEY.lang, code);
        await loadStrings(code);
        viewAccount(tr("app_saved"));
      } }, name)))),
    h(
      "div",
      { class: "card" },
      hasPin()
        ? h("button", { class: "secondary", onclick: () => {
            store.set(KEY.token, S.token);
            store.del(KEY.lockedToken);
            viewAccount(tr("app_saved"));
          } }, tr("app_pin_remove"))
        : h("button", { class: "secondary", onclick: () => {
            const root = document.getElementById("app");
            root.textContent = "";
            root.append(header(), pinPad(tr("app_pin_new"), async (pin) => {
              await lockToken(pin);
              viewAccount(tr("app_saved"));
            }));
          } }, tr("app_pin_set")),
      h("button", { class: "secondary", onclick: () => {
        const root = document.getElementById("app");
        root.textContent = "";
        root.append(header(), h("section", { class: "view" }, h("p", { class: "note" }, tr("app_wipe_confirm")),
          h("button", { class: "accent", onclick: async () => {
            await api("/me", { method: "DELETE" });
            S.token = null;
            S.msgs = [];
            S.lastId = 0;
            store.del(KEY.token);
            store.del(KEY.lockedToken);
            await ensureSession();
            go("home");
            render();
          } }, tr("app_wipe_yes")),
          h("button", { class: "secondary", onclick: () => viewAccount() }, tr("app_cancel"))));
      } }, tr("app_wipe")),
    ),
  );
}

// ---------- router ----------
async function render() {
  clearInterval(S.poll);
  if (!S.lang) return viewLanguage();
  const v = route();
  try {
    if (v === "ask") {
      await refreshMessages();
      viewAsk();
      // New messages from a Dada or nurse arrive while she has the chat open.
      S.poll = setInterval(async () => {
        const before = S.lastId;
        await refreshMessages().catch(() => {});
        if (S.lastId !== before && route() === "ask" && !S.recording) viewAsk();
      }, 10000);
    } else if (v === "care") await viewCare();
    else if (v === "passes") await viewPasses();
    else if (v === "learn") await viewLearn();
    else if (v === "account") viewAccount();
    else viewHome();
  } catch {
    mount(v, h("p", { class: "note" }, navigator.onLine ? tr("app_error") : tr("app_offline")));
  }
}

async function start() {
  try {
    await ensureSession();
    if (!S.token) {
      // Locked: the app's words aren't personal, so load them before asking for the PIN.
      await loadStrings(store.get(KEY.lang) || "en").catch(() => {});
      return viewLock();
    }
    const me = await api("/me");
    S.lang = me.language || null;
    await loadStrings(S.lang || store.get(KEY.lang) || "en");
    render();
  } catch {
    // Offline on first open: show what can work without the network.
    await loadStrings(store.get(KEY.lang) || "en").catch(() => {});
    S.lang = S.lang || store.get(KEY.lang) || "en";
    render();
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("online", async () => {
  const queued = S.outbox.splice(0);
  S.msgs = S.msgs.filter((m) => !m.pending);
  for (const text of queued) await sendText(text);
  render();
});
window.addEventListener("offline", render);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" }).catch(() => {});
start();
