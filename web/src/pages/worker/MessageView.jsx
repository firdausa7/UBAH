import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.js'
import { CHANNELS, when } from '../../ui/StaffShell.jsx'

const LOW_CONFIDENCE = 0.6

export default function MessageView({ id, back, onChange }) {
  const [data, setData] = useState(null)
  const [missing, setMissing] = useState(false)
  const load = useCallback(
    () =>
      api
        .get(`/worker/messages/${id}`)
        .then(setData)
        .catch(() => setMissing(true)),
    [id],
  )
  useEffect(() => {
    load().then(onChange)
  }, [load, onChange])

  if (missing)
    return (
      <div className="rounded-[28px] bg-white p-8 ring-1 ring-hair">
        <p className="mb-4">This message isn't available: she may no longer be assigned to you, or she stopped sharing.</p>
        <Link to={back} className="btn-ghost">
          Back to inbox
        </Link>
      </div>
    )
  if (!data) return <p className="text-muted">Loading…</p>
  const { message: m, girl, replies, templates } = data

  return (
    <article className="flex flex-col gap-4">
      <Link to={back} className="btn-quiet self-start lg:hidden">
        ← Inbox
      </Link>

      <header className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
        <div className="flex flex-wrap items-center gap-2 text-[14px]">
          {m.urgent && <span className="tag bg-urgent text-white">Urgent</span>}
          <span className="tag bg-soft text-plum capitalize">{m.status}</span>
          <span className="text-muted">
            {CHANNELS[m.channel] ?? m.channel} · {when(m.at)}
          </span>
        </div>
        <h2 className="mt-2 text-[34px] leading-tight">
          Girl <em>{girl.anonId}</em>
        </h2>
        <p className="text-text">Writes in {girl.languageLabel}. Your reply is sent in this language.</p>
        {m.urgent && m.urgentReason && <p className="mt-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">Why urgent: {reason(m.urgentReason)}. She was already sent the urgent help message.</p>}
      </header>

      <Warnings m={m} />

      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-[28px] bg-lavender p-6">
          <p className="eyebrow mb-2">What she said{m.chosenLanguageLabel ? ` · ${m.chosenLanguageLabel}` : ''}</p>
          {m.audioUrl && <audio controls preload="none" src={m.audioUrl} className="mb-3 w-full" aria-label="Her voice note" />}
          <p className="text-[18px] whitespace-pre-line text-plum">{m.text}</p>
        </section>
        <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
          <p className="eyebrow mb-2">In English</p>
          {m.englishSource === 'machine' && <p className="tag mb-3 bg-rose text-rose-ink">Machine translated: check the meaning</p>}
          {m.english ? <p className="text-[18px] whitespace-pre-line text-plum">{m.english}</p> : <p className="text-text">No translation. Read the original, or ask a colleague who speaks {m.chosenLanguageLabel ?? 'her language'}.</p>}
        </section>
      </div>

      <Conversation girl={girl} current={m.id} />

      {replies.length > 0 && (
        <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
          <h3 className="mb-3 font-serif text-[24px] font-semibold">Replies sent</h3>
          <ol className="flex flex-col gap-3">
            {replies.map((r) => (
              <li key={r.id} className="rounded-2xl bg-soft p-4">
                <p className="text-plum">{r.english}</p>
                <p className="mt-1 text-[15px] text-text">
                  She received: <span lang={girl.language}>{r.translated}</span>
                </p>
                <p className="mt-1 text-[13px] text-muted">
                  {r.worker} · {when(r.at)} · {r.source === 'template' ? 'reviewed template' : r.source === 'machine' ? 'machine translated' : 'English'}
                </p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <Reply id={m.id} girl={girl} templates={templates} resolved={m.status === 'resolved'} after={() => (load(), onChange())} />
    </article>
  )
}

// Her conversation (what she shares; urgent always), loaded only when opened: every look is logged.
function Conversation({ girl, current }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(false)
  async function open(e) {
    if (!e.currentTarget.open || items) return
    try {
      setItems((await api.get(`/worker/girls/${girl.id}/messages`)).messages)
    } catch {
      setError(true)
    }
  }
  const who = { girl: `Girl ${girl.anonId}`, ubah: 'Ubah (automatic answer)', worker: 'Health worker' }
  return (
    <details className="rounded-[28px] bg-white p-6 ring-1 ring-hair" onToggle={open}>
      <summary className="cursor-pointer font-serif text-[24px] font-semibold">
        Conversation <span className="font-sans text-[15px] font-normal text-muted">(last 50 messages; opening it is logged)</span>
      </summary>
      {error && <p className="mt-3 text-rose-ink">Could not load the conversation.</p>}
      {items && items.length === 0 && <p className="mt-3 text-text">Nothing she shares yet.</p>}
      {items && (
        <ol className="mt-4 flex flex-col gap-2">
          {items.map((x) => (
            <li
              key={x.id}
              className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] ${x.sender === 'girl' ? 'self-start bg-lavender' : 'self-end bg-soft'} ${x.id === current ? 'ring-2 ring-accent' : ''}`}
            >
              <span className="mb-0.5 block text-[12px] text-muted">
                {who[x.sender]} · {when(x.at)}
                {x.urgent ? ' · urgent' : ''}
              </span>
              <span className="whitespace-pre-line text-plum">{x.sender === 'worker' && x.english ? x.english : x.text}</span>
              {x.sender === 'girl' && x.english && x.english !== x.text && <span className="mt-1 block whitespace-pre-line text-text">English: {x.english}</span>}
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}

function reason(r) {
  const [source, rest] = [r.split(':')[0], r.split(':').slice(1).join(':')]
  const english = r.includes('(in the English translation)')
  const what = source === 'list' ? `danger word "${rest.split(':').slice(1).join(':').replace(' (in the English translation)', '')}"` : source === 'rule' ? 'danger phrase' : 'danger-sign model'
  return `${what}${english ? ' found in the English translation' : ''}`
}

function Warnings({ m }) {
  const items = []
  if (m.audioUnclear) items.push(['Audio unclear, please listen.', m.audioUrl ? 'Play her voice note above.' : 'She did not share her voice, so there is no recording. She was asked to try again or type.'])
  else if (m.confidence !== null && m.confidence !== undefined && m.confidence < LOW_CONFIDENCE) items.push([`Low confidence (${Math.round(m.confidence * 100)}%).`, 'The transcript may be wrong. Listen if you can.'])
  if (m.languageMismatch) items.push([`Sounded like ${m.detectedLanguageLabel}, she chose ${m.chosenLanguageLabel}.`, 'The translation used the language that was heard.'])
  if (m.translationFailed) items.push(['Not translated.', 'The translation service failed for this message.'])
  if (!items.length) return null
  return (
    <ul className="flex flex-col gap-2">
      {items.map(([a, b]) => (
        <li key={a} className="rounded-2xl bg-blush px-5 py-3 text-[15px] text-rose-ink">
          <strong className="font-medium">{a}</strong> {b}
        </li>
      ))}
    </ul>
  )
}

function Reply({ id, girl, templates, resolved, after }) {
  const [english, setEnglish] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  async function send(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const r = await api.post(`/worker/messages/${id}/reply`, { english })
      setResult(r)
      setEnglish('')
      after()
    } catch (err) {
      setError(err.code === 'translation_failed' ? 'The reply could not be translated, so nothing was sent. Please try again in a moment.' : 'The reply was not sent. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  async function resolve() {
    setBusy(true)
    try {
      await api.post(`/worker/messages/${id}/resolve`)
      after()
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
      <h3 className="mb-1 font-serif text-[26px] font-semibold">
        Reply <em className="text-accent">in English</em>
      </h3>
      <p className="mb-4 text-[15px] text-text">She receives it in {girl.languageLabel}, with your English on tap. A checked template is used when your words match one; otherwise it is machine translated.</p>
      {templates.length > 0 && (
        <div className="mb-3">
          <p className="eyebrow mb-2">Checked answers</p>
          <div className="flex flex-wrap gap-2">
            {templates.map((t) => (
              <button key={t.id} type="button" onClick={() => setEnglish(t.english)} className="rounded-full bg-lavender px-3 py-1.5 text-left text-[14px] text-plum hover:bg-mist" title={t.translated}>
                {t.english}
              </button>
            ))}
          </div>
        </div>
      )}
      <form onSubmit={send}>
        <label htmlFor="reply" className="sr-only">
          Your reply in English
        </label>
        <textarea id="reply" rows={4} maxLength={1600} className="field mb-3" value={english} onChange={(e) => setEnglish(e.target.value)} placeholder="Write your reply in English" />
        {error && (
          <p role="alert" className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">
            {error}
          </p>
        )}
        {result && (
          <p role="status" className="mb-3 rounded-2xl bg-lavender px-4 py-3 text-[15px] text-plum">
            Sent{result.source === 'template' ? ' with a checked translation' : result.source === 'machine' ? ' (machine translated)' : ''}: <span lang={girl.language}>{result.translated}</span>
          </p>
        )}
        <div className="flex flex-wrap gap-3">
          <button className="btn" disabled={busy || !english.trim()}>
            Send reply
          </button>
          {!resolved && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={resolve}>
              Mark resolved
            </button>
          )}
        </div>
      </form>
    </section>
  )
}
