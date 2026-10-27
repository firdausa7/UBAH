/* The old Ubah app (/app) is retired: the girls' space is now /me.
 * Phones that installed the old app still run its service worker. This version replaces it the next
 * time the phone is online: it deletes everything the old app stored, removes itself, and opens /me. */
"use strict";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("ubah-app-")).map((k) => caches.delete(k)));
      await self.registration.unregister();
      const pages = await self.clients.matchAll({ type: "window" });
      for (const page of pages) page.navigate("/me").catch(() => {});
    })(),
  );
});
