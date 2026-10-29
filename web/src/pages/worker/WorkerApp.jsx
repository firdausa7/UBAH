import { useCallback, useEffect, useState } from 'react'
import { Link, Route, Routes, useParams, useSearchParams } from 'react-router'
import { api } from '../../lib/api.js'
import { CHANNELS, StaffShell, when } from '../../ui/StaffShell.jsx'
import MessageView from './MessageView.jsx'
import { useUrgentAlerts } from './useUrgentAlerts.js'

const POLL_MS = 15000
const LANGS = [
  ['so', 'Soomaali'],
  ['sw', 'Kiswahili'],
  ['om', 'Afaan Oromoo'],
  ['en', 'English'],
]

export default function WorkerApp() {
  return (
    <StaffShell area="Health worker" home="/worker" links={[{ to: '/worker', label: 'Inbox' }]}>
      <Routes>
        <Route index element={<Desk />} />
        <Route path="m/:id" element={<Desk />} />
      </Routes>
    </StaffShell>
  )
}

// Inbox on the left, the open message on the right (one at a time on a phone).
function Desk() {
  const { id } = useParams()
  const [params, setParams] = useSearchParams()
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const filters = { language: params.get('language') || '', channel: params.get('channel') || '', status: params.get('status') || '' }
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString()

  const load = useCallback(
    () =>
      api
        .get(`/worker/inbox${qs ? `?${qs}` : ''}`)
        .then((d) => (setItems(d.messages), setError('')))
        .catch(() => setError('Could not load the inbox. It will try again.')),
    [qs],
  )
  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])

  const set = (k, v) => {
    const next = new URLSearchParams(params)
    if (v) next.set(k, v)
    else next.delete(k)
    setParams(next, { replace: true })
  }
  const urgent = items?.filter((m) => m.urgent && m.status !== 'resolved').length ?? 0
  const alerts = useUrgentAlerts(load)
  const waiting = useWaiting(load)

  return (
    <div className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[minmax(340px,420px)_1fr]">
      <section className={id ? 'hidden lg:block' : ''} aria-label="Inbox">
        <div className="mb-4 flex items-baseline justify-between">
          <h1 className="text-[36px] leading-none">
            Your <em>girls</em>
          </h1>
          {urgent > 0 && <span className="tag bg-urgent-bg text-urgent">{urgent} urgent</span>}
        </div>
        <button
          type="button"
          onClick={alerts.toggle}
          aria-pressed={alerts.enabled}
          className={`mb-4 flex w-full items-center justify-between rounded-2xl px-4 py-2.5 text-left text-[15px] ${alerts.enabled ? 'bg-lavender text-plum' : 'bg-blush text-rose-ink'}`}
        >
          <span>
            {alerts.enabled ? 'Urgent alerts are on: a sound' : 'Turn on urgent alerts: a sound'}
            {alerts.permission === 'granted' ? ' and a notification' : alerts.permission === 'denied' ? ' (notifications are blocked in this browser)' : ' and a notification'}
          </span>
          <span className="font-medium">{alerts.enabled ? 'Turn off' : 'Turn on'}</span>
        </button>
        <div className="mb-4 flex flex-wrap gap-2">
          <select aria-label="Language" className="field w-auto py-2 text-[15px]" value={filters.language} onChange={(e) => set('language', e.target.value)}>
            <option value="">All languages</option>
            {LANGS.map(([c, n]) => (
              <option key={c} value={c}>
                {n}
              </option>
            ))}
          </select>
          <select aria-label="Channel" className="field w-auto py-2 text-[15px]" value={filters.channel} onChange={(e) => set('channel', e.target.value)}>
            <option value="">All channels</option>
            {['web', 'whatsapp', 'sms'].map((c) => (
              <option key={c} value={c}>
                {CHANNELS[c]}
              </option>
            ))}
          </select>
          <div className="flex rounded-full bg-white p-1 ring-1 ring-hair" role="group" aria-label="Status">
            {[
              ['', 'All'],
              ['new', 'New'],
              ['open', 'Open'],
              ['resolved', 'Resolved'],
            ].map(([v, l]) => (
              <button key={l} type="button" aria-pressed={filters.status === v} onClick={() => set('status', v)} className={`rounded-full px-3 py-1 text-[14px] ${filters.status === v ? 'bg-plum text-cream' : 'text-text hover:bg-soft'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {error && <p className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">{error}</p>}
        <Waiting {...waiting} />
        {items === null ? (
          <p className="text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <div className="rounded-3xl bg-lavender p-6 text-plum">Nothing here. Messages from the girls assigned to you appear here, urgent ones first.</div>
        ) : (
          <ol className="flex flex-col gap-2">
            {items.map((m) => (
              <li key={m.id}>
                <InboxItem m={m} active={String(m.id) === id} keep={qs} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className={id ? '' : 'hidden lg:block'}>
        {id ? (
          <MessageView key={id} id={id} back={`/worker${qs ? `?${qs}` : ''}`} onChange={load} />
        ) : (
          <div className="flex h-full min-h-80 flex-col items-center justify-center rounded-[28px] bg-white p-10 text-center ring-1 ring-hair">
            <img src="/assets/rose.png" alt="" className="mb-4 h-14 w-auto opacity-80" />
            <p className="max-w-sm text-text">Open a message to listen, read the English, and reply. She receives your reply in her own language.</p>
          </div>
        )}
      </section>
    </div>
  )
}

// Girls with no worker who asked for a person (or have an open case). Taking one makes her yours.
function useWaiting(onTaken) {
  const [list, setList] = useState([])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(0)
  const load = useCallback(() => api.get('/worker/waiting').then((d) => setList(d.waiting)).catch(() => {}), [])
  useEffect(() => {
    load()
    const t = setInterval(load, POLL_MS)
    return () => clearInterval(t)
  }, [load])
  const take = async (w) => {
    setBusy(w.caseId)
    setNote('')
    try {
      await api.post(`/worker/waiting/${w.caseId}/take`)
      setNote(`Girl ${w.girl.anonId} is now yours. Her messages appear below.`)
      onTaken()
    } catch (e) {
      setNote(e.code === 'taken' ? `Someone else took girl ${w.girl.anonId} first.` : 'That did not work. Please try again.')
    } finally {
      setBusy(0)
      load()
    }
  }
  return { list, note, busy, take }
}

function Waiting({ list, note, busy, take }) {
  if (!list.length && !note) return null
  return (
    <section aria-label="Waiting for a Dada" className="mb-5 rounded-3xl bg-soft p-4 ring-1 ring-hair">
      <h2 className="mb-1 text-[24px] leading-tight">
        Waiting for <em>a Dada</em>
      </h2>
      <p className="mb-3 text-[14px] text-muted">These girls asked for a person and have no Dada yet. Take one and she becomes yours.</p>
      {note && (
        <p role="status" className="mb-3 rounded-2xl bg-lavender px-4 py-2 text-[15px] text-plum">
          {note}
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {list.map((w) => (
          <li key={w.caseId} className={`rounded-2xl p-3 ring-1 ${w.urgent ? 'bg-blush ring-rose' : 'bg-white ring-hair'}`}>
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
              {w.urgent && <span className="tag bg-urgent text-white">Urgent</span>}
              <span className="font-medium text-plum">Girl {w.girl.anonId}</span>
              {w.girl.minor && <span className="tag bg-rose text-rose-ink">Under 18</span>}
              <span className="text-muted">
                {w.girl.languageLabel} · {CHANNELS[w.girl.channel] ?? w.girl.channel}
              </span>
              <span className="ml-auto text-muted">{when(w.since)}</span>
            </div>
            <p className="text-[15px] text-plum">{w.reason}</p>
            <p className="mb-2 line-clamp-2 text-[15px] text-text">{w.summary ?? 'She keeps her messages private.'}</p>
            <button type="button" className="btn min-h-11 px-5 text-[15px]" disabled={busy === w.caseId} onClick={() => take(w)}>
              {busy === w.caseId ? 'Taking…' : `Take girl ${w.girl.anonId}`}
            </button>
          </li>
        ))}
      </ol>
    </section>
  )
}

function InboxItem({ m, active, keep }) {
  return (
    <Link
      to={`/worker/m/${m.id}${keep ? `?${keep}` : ''}`}
      aria-current={active ? 'true' : undefined}
      className={`block rounded-3xl p-4 no-underline ring-1 transition-colors ${active ? 'bg-lavender ring-accent' : m.urgent && m.status !== 'resolved' ? 'bg-blush ring-rose hover:ring-urgent' : 'bg-white ring-hair hover:ring-accent'}`}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px]">
        {m.urgent && <span className="tag bg-urgent text-white">Urgent</span>}
        <span className="font-medium text-plum">Girl {m.girl.anonId}</span>
        {m.girl.minor && <span className="tag bg-rose text-rose-ink">Under 18</span>}
        <span className="text-muted">
          {m.girl.languageLabel} · {CHANNELS[m.channel] ?? m.channel}
        </span>
        <span className="ml-auto text-muted">{when(m.at)}</span>
      </div>
      <p className="line-clamp-2 text-[16px] text-plum">{m.english ?? m.text}</p>
      <div className="mt-2 flex flex-wrap gap-1.5 text-[12px]">
        {m.status === 'new' && <span className="tag bg-accent text-white">New</span>}
        {m.status === 'resolved' && <span className="tag bg-soft text-muted">Resolved</span>}
        {m.kind === 'voice' && <span className="tag bg-soft text-plum">Voice</span>}
        {m.audioUnclear && <span className="tag bg-rose text-rose-ink">Audio unclear</span>}
        {m.languageMismatch && <span className="tag bg-soft text-plum">Language differs</span>}
        {m.translationFailed && <span className="tag bg-rose text-rose-ink">Not translated</span>}
      </div>
    </Link>
  )
}
