import { act, cleanup, render } from '@testing-library/react'
import axe from 'axe-core'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../src/i18n.ts'
import { SessionProvider } from './lib/session.jsx'
import Login from './pages/auth/Login.jsx'
import GirlApp from './pages/girl/GirlApp.jsx'

// The girls' screens, rendered with the real English words (as the server sends them), checked
// with axe for WCAG 2.1 A and AA: labels, names, roles, headings, landmarks, language. Colour is
// checked in lib/contrast.test.js (jsdom doesn't paint, so axe can't measure it here).

const STRING_KEYS = Object.keys(en).filter((k) => /^(web_|app_|svc_|cat_|wb_|rp_)/.test(k) || ['clinic_rating', 'translation_pending', 'answer_not_advice'].includes(k))
const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'so', name: 'Soomaali' },
]

let locked = false
let session = { role: 'girl', home: '/me', language: 'en', locked: false }
const conversation = [
  { id: 1, from: 'me', kind: 'text', text: 'When is the clinic open?' },
  { id: 2, from: 'ubah', kind: 'text', text: 'Reply with a number.', options: [{ id: '1', title: 'Clinic hours' }] },
  { id: 3, from: 'worker', kind: 'text', text: 'Hello, I am the nurse.' },
]

function respond(path) {
  if (path === '/api/auth/session') return session ? [200, session] : [401, { error: 'not_signed_in' }]
  if (path.startsWith('/api/strings')) return [200, { lang: 'en', languages: LANGUAGES, strings: Object.fromEntries(STRING_KEYS.map((k) => [k, en[k]])) }]
  if (locked && path.startsWith('/api/me')) return [423, { error: 'pin_needed' }]
  if (path === '/api/me') return [200, { anonId: 'G-TEST', language: 'en', ageBand: '15-17', languages: LANGUAGES, consents: { messages: true, voice: false } }]
  if (path.startsWith('/api/me/messages')) return [200, { messages: conversation }]
  if (path === '/api/me/wellbeing') return [200, { entries: [] }]
  if (path === '/api/me/push') return [200, { enabled: false, publicKey: null, devices: 0 }]
  if (path === '/api/me/reports') return [200, { reports: [] }]
  return [200, {}]
}

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  HTMLCanvasElement.prototype.getContext = () => null // axe probes for icon fonts; jsdom has no canvas
})
beforeEach(() => {
  locked = false
  session = { role: 'girl', home: '/me', language: 'en', locked: false }
  localStorage.clear()
  sessionStorage.clear()
  localStorage.setItem('ubah:intro-seen', '1')
  vi.stubGlobal('fetch', async (url) => {
    const [status, body] = respond(String(url).split('?')[0] === '/api/strings' ? '/api/strings' : String(url))
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function check(ui, path, waitFor) {
  const { container } = render(
    <MemoryRouter initialEntries={[path]}>
      <SessionProvider>{ui}</SessionProvider>
    </MemoryRouter>,
  )
  // Let the screen load its words and data.
  for (let i = 0; i < 20 && !container.textContent.includes(waitFor); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
  expect(container.textContent, `${path} did not finish loading`).toContain(waitFor)
  document.documentElement.lang = 'en'
  const result = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, rules: { 'color-contrast': { enabled: false } } })
  const problems = result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)
  expect(problems, path).toEqual([])
}

const girl = (
  <Routes>
    <Route path="/me/*" element={<GirlApp />} />
  </Routes>
)

describe('accessibility of the girls\' screens (axe, WCAG 2.1 AA)', () => {
  it('sign in', async () => {
    session = null
    await check(
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>,
      '/login',
      en.web_phone,
    )
  })
  it('chat', () => check(girl, '/me', 'Hello, I am the nurse.'))
  it('wellbeing', () => check(girl, '/me/wellbeing', en.wb_tab))
  it('confidential report', () => check(girl, '/me/report', en.rp_title))
  it('settings', () => check(girl, '/me/settings', en.web_language))
  it('PIN lock', async () => {
    locked = true
    await check(girl, '/me', en.app_pin_enter)
  })
})
