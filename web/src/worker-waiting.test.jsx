import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionProvider } from './lib/session.jsx'
import WorkerApp from './pages/worker/WorkerApp.jsx'

// /worker: girls with no Dada who asked for a person wait at the top; "Take" makes her yours.

const WAITING = {
  caseId: 7,
  reason: 'Asked for a person',
  urgent: false,
  summary: 'I need to talk to someone',
  since: new Date().toISOString(),
  girl: { id: 3, anonId: 'NYGA', language: 'en', languageLabel: 'English', channel: 'web', minor: false },
}

let takeAnswer
let waiting
const posted = []

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = () => null // axe probes for icon fonts; jsdom has no canvas
})
beforeEach(() => {
  waiting = [WAITING]
  posted.length = 0
  vi.stubGlobal('fetch', async (url, init = {}) => {
    const path = String(url)
    let status = 200
    let body = {}
    if (path === '/api/auth/session') body = { role: 'health_worker', home: '/worker', name: 'Dada Demo' }
    else if (path.startsWith('/api/worker/inbox')) body = { messages: [] }
    else if (path === '/api/worker/waiting') body = { waiting }
    else if (path === '/api/worker/waiting/7/take' && init.method === 'POST') {
      posted.push(path)
      ;[status, body] = takeAnswer
      if (status === 200) waiting = []
    }
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const settle = async (text) => {
  for (let i = 0; i < 30 && !document.body.textContent.includes(text); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
  expect(document.body.textContent).toContain(text)
}

function show() {
  return render(
    <MemoryRouter initialEntries={['/worker']}>
      <SessionProvider>
        <Routes>
          <Route path="/worker/*" element={<WorkerApp />} />
        </Routes>
      </SessionProvider>
    </MemoryRouter>,
  )
}

describe('waiting for a Dada', () => {
  it('lists her, passes axe, and Take makes her yours', async () => {
    takeAnswer = [200, { girlId: 3, caseId: 7 }]
    const { container } = show()
    await settle('Take girl NYGA')
    expect(container.textContent).toContain('I need to talk to someone')
    document.documentElement.lang = 'en'
    const result = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }, rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Take girl NYGA' }))
    await settle('Girl NYGA is now yours')
    expect(posted).toEqual(['/api/worker/waiting/7/take'])
    expect(screen.queryByRole('button', { name: 'Take girl NYGA' })).toBeNull()
  })

  it('says so when another worker took her first', async () => {
    takeAnswer = [409, { error: 'taken' }]
    show()
    await settle('Take girl NYGA')
    fireEvent.click(screen.getByRole('button', { name: 'Take girl NYGA' }))
    await settle('Someone else took girl NYGA first.')
  })

  it('shows nothing when no girl is waiting', async () => {
    waiting = []
    const { container } = show()
    await settle('Your girls')
    expect(container.textContent).not.toContain('Waiting for')
  })
})
