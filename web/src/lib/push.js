import { api } from './api.js'

// "Tell me when a reply arrives" on this phone. The push carries nothing; the words of the notice are
// given to the service worker in her language.

const urlBytes = (b64) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(s, (c) => c.charCodeAt(0))
}

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

export async function currentSubscription() {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/me')
  return reg ? reg.pushManager.getSubscription() : null
}

export async function turnOnPush(publicKey, text) {
  if ((await Notification.requestPermission()) !== 'granted') return 'blocked'
  const reg = await navigator.serviceWorker.ready
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBytes(publicKey) }))
  await api.put('/me/push', { endpoint: sub.endpoint })
  reg.active?.postMessage({ type: 'push-text', ...text })
  return 'on'
}

export async function turnOffPush() {
  const sub = await currentSubscription()
  await api.del('/me/push', sub ? { endpoint: sub.endpoint } : undefined).catch(() => {})
  await sub?.unsubscribe()
}
