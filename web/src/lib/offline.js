// Offline support for the girls' space. What is hers never touches the phone's storage:
// a message typed offline waits in this browser tab only (sessionStorage) and is sent when she is back.

const QUEUE = 'ubah:queue'
const GIRL = 'ubah:girl' // "this tab's phone has a signed-in girl": lets /me open offline

export function registerOffline() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('/me/sw.js', { scope: '/me' }).catch(() => {})
  if (!document.querySelector('link[rel="manifest"]')) {
    const link = document.createElement('link')
    link.rel = 'manifest'
    link.href = '/me/manifest.webmanifest'
    document.head.appendChild(link)
  }
}

const read = (store, key) => {
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}
const write = (store, key, value) => {
  try {
    if (value === null) store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    /* private mode: nothing kept */
  }
}

export const queued = () => JSON.parse(read(sessionStorage, QUEUE) || '[]')
export const enqueue = (text) => write(sessionStorage, QUEUE, JSON.stringify([...queued(), text]))
export const setQueue = (items) => write(sessionStorage, QUEUE, items.length ? JSON.stringify(items) : null)

import { ApiError } from './api.js'

// Only a 400 means the server will never take this message; anything else (offline, locked, too many
// at once, a server problem) means "try again later".
export const refusedForGood = (e) => e instanceof ApiError && e.status === 400

// Sends what waited offline, in order, keeping what can't go yet.
export async function flushQueue(send, isPermanentRefusal = refusedForGood) {
  let left = queued()
  while (left.length) {
    try {
      await send(left[0])
    } catch (e) {
      if (!isPermanentRefusal(e)) break
    }
    left = left.slice(1)
    setQueue(left)
  }
  return queued()
}

export const rememberGirl = () => write(localStorage, GIRL, '1')
export const isRememberedGirl = () => read(localStorage, GIRL) === '1'

// Sign out and Quick exit: nothing of hers, and nothing public either, stays behind.
export function forgetEverything() {
  write(sessionStorage, QUEUE, null)
  write(localStorage, GIRL, null)
  write(localStorage, 'ubah:draft', null)
  write(localStorage, 'ubah:intro-seen', null)
  write(localStorage, 'ubah:lang', null)
  try {
    navigator.serviceWorker?.controller?.postMessage('forget')
  } catch {
    /* no service worker */
  }
}
