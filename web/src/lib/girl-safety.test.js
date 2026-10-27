import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api.js'
import { enqueue, flushQueue, forgetEverything, queued, rememberGirl } from './offline.js'
import { quickExit } from '../ui/QuickExit.jsx'

const network = () => new TypeError('Failed to fetch')

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
})
afterEach(() => vi.unstubAllGlobals())

describe('messages typed offline', () => {
  it('go out in order when she is back', async () => {
    enqueue('first')
    enqueue('second')
    const sent = []
    expect(await flushQueue(async (t) => sent.push(t), () => false)).toEqual([])
    expect(sent).toEqual(['first', 'second'])
  })

  it('are kept when still offline, or when her session locked meanwhile (PIN needed)', async () => {
    for (const error of [network(), new ApiError(423, 'pin_needed'), new ApiError(429, 'rate'), new ApiError(500, 'server')]) {
      sessionStorage.clear()
      enqueue('a question')
      enqueue('another')
      const left = await flushQueue(async () => Promise.reject(error))
      expect(left, String(error.code ?? error.message)).toEqual(['a question', 'another'])
    }
  })

  it('drop only a message the server refuses for good, and carry on with the rest', async () => {
    enqueue('refused')
    enqueue('fine')
    const sent = []
    const left = await flushQueue(
      async (t) => (t === 'refused' ? Promise.reject(new ApiError(400, 'empty')) : sent.push(t)),
    )
    expect(left).toEqual([])
    expect(sent).toEqual(['fine'])
  })

  it('live only in this tab, never in the phone storage', () => {
    enqueue('private')
    expect(sessionStorage.getItem('ubah:queue')).toContain('private')
    expect(JSON.stringify({ ...localStorage })).not.toContain('private')
  })
})

describe('Quick exit', () => {
  it('locks her session on the server, forgets everything on the phone, and leaves at once', () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', fetchSpy)
    const replace = vi.fn()
    vi.stubGlobal('location', { ...window.location, replace })
    enqueue('typed offline')
    rememberGirl()
    localStorage.setItem('ubah:lang', 'so')
    localStorage.setItem('ubah:intro-seen', '1')

    quickExit()

    expect(fetchSpy).toHaveBeenCalledWith('/api/auth/girl/lock', expect.objectContaining({ method: 'POST', keepalive: true, headers: { 'x-ubah': '1' } }))
    expect(queued()).toEqual([])
    expect(localStorage.length).toBe(0)
    expect(replace).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/www\.google\.com\//))
  })

  it('Sign out forgets the same things', () => {
    enqueue('x')
    rememberGirl()
    localStorage.setItem('ubah:lang', 'sw')
    forgetEverything()
    expect(sessionStorage.length + localStorage.length).toBe(0)
  })
})

describe('the server says her PIN is needed', () => {
  it('shows the lock screen (ubah:locked) and fails the request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'pin_needed' }), { status: 423 })))
    const locked = vi.fn()
    window.addEventListener('ubah:locked', locked)
    await expect(api.get('/me')).rejects.toMatchObject({ status: 423, code: 'pin_needed' })
    expect(locked).toHaveBeenCalledTimes(1)
    window.removeEventListener('ubah:locked', locked)
  })

  it('the background check for replies says so, so it never keeps her session open', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"messages":[]}'))
    vi.stubGlobal('fetch', fetchSpy)
    await api.poll('/me/messages?after=1')
    expect(fetchSpy.mock.calls[0][1].headers['x-ubah-poll']).toBe('1')
    await api.get('/me')
    expect(fetchSpy.mock.calls[1][1].headers['x-ubah-poll']).toBeUndefined()
  })

  it('every change carries the X-Ubah header the server requires', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    await api.post('/me/messages', { text: 'hi' })
    await api.del('/me')
    for (const call of fetchSpy.mock.calls) expect(call[1].headers['x-ubah']).toBe('1')
  })
})
