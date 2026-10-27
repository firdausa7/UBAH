// Talks to the Ubah server. Cookies carry the session; every change carries X-Ubah: 1
// (the server refuses changes without it, so another website can't act for you).

export class ApiError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function call(method, path, body, { raw, poll } = {}) {
  const headers = { accept: 'application/json' }
  // A background check (new replies) doesn't count as her using the app, so the PIN lock still comes.
  if (poll) headers['x-ubah-poll'] = '1'
  if (method !== 'GET') headers['x-ubah'] = '1'
  let payload
  if (raw) {
    headers['content-type'] = raw.type || 'application/octet-stream'
    payload = raw
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  // Her session locked itself: the girls' space shows the PIN screen.
  if (res.status === 423 && data.error === 'pin_needed') window.dispatchEvent(new Event('ubah:locked'))
  if (!res.ok) throw new ApiError(res.status, data.error || 'server')
  return data
}

export const api = {
  get: (path) => call('GET', path),
  poll: (path) => call('GET', path, undefined, { poll: true }),
  post: (path, body) => call('POST', path, body),
  put: (path, body) => call('PUT', path, body),
  patch: (path, body) => call('PATCH', path, body),
  del: (path, body) => call('DELETE', path, body),
  upload: (path, blob) => call('POST', path, undefined, { raw: blob }),
}
