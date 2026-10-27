// Ubah girls' space (/me): works offline for what is public, never for what is hers.
//   kept on the phone: the app itself, the words in her language, the lessons and their audio
//   never kept: her messages, her passes, anything about her (phones are shared)
// Served at /me/sw.js with scope /me (the server allows it), so it controls /me and /me/… only.

const VERSION = 'v1'
const SHELL = `ubah-me-shell-${VERSION}`
const PUBLIC = `ubah-me-public-${VERSION}`

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.add('/me')))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ubah-me-') && k !== SHELL && k !== PUBLIC).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

// Only these are ever stored. Everything else goes to the network and nowhere else.
const isPublicData = (path) => path === '/api/strings' || path === '/api/me/learn' || path.startsWith('/app/api/audio/')

async function networkFirst(request, cacheName, fallbackUrl) {
  try {
    const res = await fetch(request)
    if (res.ok) (await caches.open(cacheName)).put(fallbackUrl || request, res.clone())
    return res
  } catch {
    const hit = await caches.match(fallbackUrl || request)
    if (hit) return hit
    throw new Error('offline')
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) (await caches.open(SHELL)).put(request, res.clone())
  return res
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin) return
  if (request.mode === 'navigate' && url.pathname.startsWith('/me')) {
    event.respondWith(networkFirst(request, SHELL, '/me'))
  } else if (url.pathname.startsWith('/ui/')) {
    event.respondWith(cacheFirst(request)) // built files never change (their names do)
  } else if (isPublicData(url.pathname)) {
    event.respondWith(networkFirst(request, PUBLIC))
  }
})

// Sign out or Quick exit: drop everything, so the next person on this phone finds nothing of hers.
self.addEventListener('message', (event) => {
  if (event.data === 'forget') event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('ubah-me-')).map((k) => caches.delete(k)))))
})
