import { useCallback, useEffect, useState } from 'react'

// Two parts in one prototype store:
// - girl: what lives on her phone (chat, passes, PIN). "Wipe my history" clears it.
// - partner: anonymous records the service keeps (questions by topic, referrals,
//   check-ins, Dada cases). No name or phone number is ever stored.
const KEY = 'ubah:v1'

const emptyGirl = { lang: 'so', pin: null, messages: [], passes: [] }
const emptyPartner = { questions: [], referrals: [], cases: [] }

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}')
    return {
      girl: { ...emptyGirl, ...raw.girl },
      partner: { ...emptyPartner, ...raw.partner },
    }
  } catch {
    return { girl: emptyGirl, partner: emptyPartner }
  }
}

export function useStore() {
  const [state, setState] = useState(load)

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // Private mode or blocked storage: the app still works for this session.
    }
  }, [state])

  // Another tab (e.g. the Dada inbox) changed the store: pick up its version.
  useEffect(() => {
    const on = (e) => e.key === KEY && setState(load())
    window.addEventListener('storage', on)
    return () => window.removeEventListener('storage', on)
  }, [])

  const setGirl = useCallback(
    (fn) => setState((s) => ({ ...s, girl: { ...s.girl, ...fn(s.girl) } })),
    [],
  )
  const setPartner = useCallback(
    (fn) => setState((s) => ({ ...s, partner: { ...s.partner, ...fn(s.partner) } })),
    [],
  )
  const wipeGirl = useCallback(
    () => setState((s) => ({ ...s, girl: { ...emptyGirl, lang: s.girl.lang } })),
    [],
  )

  return { ...state, setGirl, setPartner, wipeGirl }
}

export const uid = () => Math.random().toString(36).slice(2, 10)

export function anonId() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
  return `${letters[Math.floor(Math.random() * letters.length)]}${String(Math.floor(Math.random() * 100)).padStart(2, '0')}`
}

export function timeAgo(ts) {
  const min = Math.round((Date.now() - ts) / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}
