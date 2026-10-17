/* Ubah service worker: the app opens offline, and lessons (text and audio) can be read offline.
 * Personal data (messages, passes, account) is NEVER cached: those requests always go to the network. */
"use strict";
const VERSION = "ubah-app-v3";
const SHELL = ["/app/", "/app/app.css", "/app/app.js", "/app/manifest.webmanifest", "/app/icon.svg", "/app/icon-192.png", "/app/rose.png"];
const PUBLIC_API = ["/app/api/strings", "/app/api/learn", "/app/api/audio/"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first, falling back to the cached copy; the cache is refreshed on every success.
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw new Error("offline");
  }
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || !url.pathname.startsWith("/app")) return;
  if (url.pathname.startsWith("/app/api/")) {
    if (PUBLIC_API.some((p) => url.pathname.startsWith(p))) e.respondWith(networkFirst(e.request));
    return; // personal: network only
  }
  if (e.request.mode === "navigate") {
    e.respondWith(networkFirst(new Request("/app/")).catch(() => caches.match("/app/")));
    return;
  }
  e.respondWith(networkFirst(e.request));
});
