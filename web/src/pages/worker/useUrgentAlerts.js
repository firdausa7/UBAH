import { useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api.js'

// Urgent messages must not wait for the next look at the inbox. While /worker is open:
//   - the tab title shows "(n) Urgent" for new urgent messages;
//   - a new one plays a short tone and, if switched on, shows a browser notification.
// The notification says only "new urgent message": screens are shared, so no girl's details.
// Every nurse also gets an SMS alert; this is on top of it.

const POLL_MS = 10000
const PREF = 'ubah:worker-alerts'

function tone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const play = (freq, at) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.35)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.4)
    }
    play(660, 0)
    play(880, 0.4)
    setTimeout(() => ctx.close(), 1200)
  } catch {
    /* no sound on this browser: the title and the SMS alert still work */
  }
}

const readPref = () => {
  try {
    return localStorage.getItem(PREF) === 'on'
  } catch {
    return false
  }
}

export function useUrgentAlerts(onNew) {
  const [count, setCount] = useState(0)
  const [enabled, setEnabled] = useState(readPref)
  const seen = useRef(null)
  const onNewRef = useRef(onNew)
  useEffect(() => {
    onNewRef.current = onNew
  }, [onNew])

  useEffect(() => {
    let live = true
    const check = () =>
      api
        .get('/worker/inbox?status=new')
        .then(({ messages }) => {
          if (!live) return
          const urgent = messages.filter((m) => m.urgent)
          setCount(urgent.length)
          const fresh = seen.current ? urgent.filter((m) => !seen.current.has(m.id)) : []
          seen.current = new Set(urgent.map((m) => m.id))
          if (fresh.length) {
            if (enabled) tone()
            if (enabled && 'Notification' in window && Notification.permission === 'granted') {
              new Notification('Ubah: new urgent message', { body: 'Open Ubah to read it.', tag: 'ubah-urgent', requireInteraction: true })
            }
            onNewRef.current?.()
          }
        })
        .catch(() => {})
    check()
    const t = setInterval(check, POLL_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [enabled])

  useEffect(() => {
    const base = 'Ubah · Health worker'
    document.title = count ? `(${count}) Urgent · ${base}` : base
    return () => {
      document.title = 'Ubah'
    }
  }, [count])

  async function toggle() {
    const next = !enabled
    if (next && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission()
    if (next) tone() // also unlocks sound, which browsers allow only after a click
    try {
      localStorage.setItem(PREF, next ? 'on' : 'off')
    } catch {
      /* remembered for this visit only */
    }
    setEnabled(next)
  }

  return { count, enabled, toggle, permission: 'Notification' in window ? Notification.permission : 'unsupported' }
}
