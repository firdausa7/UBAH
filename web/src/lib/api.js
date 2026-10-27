// Talks to the Ubah server. Cookies carry the session; every change carries X-Ubah: 1
// (the server refuses changes without it, so another website can't act for you).

export class ApiError extends Error {
  constructor(status, code) {
    super(code)
    this.status = status
    this.code = code
  }
}

async function call(method, path, body, { raw } = {}) {
  const headers = { accept: 'application/json' }
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
  if (!res.ok) throw new ApiError(res.status, data.error || 'server')
  return data
}

export const api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body),
  put: (path, body) => call('PUT', path, body),
  patch: (path, body) => call('PATCH', path, body),
  del: (path) => call('DELETE', path),
  upload: (path, blob) => call('POST', path, undefined, { raw: blob }),
}
