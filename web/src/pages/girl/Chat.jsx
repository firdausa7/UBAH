import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api.js'
import { enqueue, flushQueue, messageId, queued } from '../../lib/offline.js'
import { useStrings } from '../../lib/strings.jsx'

const POLL_MS = 8000
const MAX_SECONDS = 90 // keeps a note under the server's 2 MB limit

export default function Chat() {
  const { t } = useStrings()
  const [messages, setMessages] = useState([])
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [waiting, setWaiting] = useState(queued)
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  const last = messages.at(-1)?.id ?? 0
  const lastRef = useRef(0)
  useEffect(() => {
    lastRef.current = last
  }, [last])
  const end = useRef(null)

  const merge = useCallback((fresh) => {
    if (!fresh?.length) return
    setMessages((cur) => {
      const seen = new Set(cur.map((m) => m.id))
      return [...cur, ...fresh.filter((m) => !seen.has(m.id))]
    })
  }, [])

  // Messages typed offline go out, in order, as soon as she is back.
  const flush = useCallback(async () => {
    const left = await flushQueue(async (m) => merge((await api.post(`/me/messages?after=${lastRef.current}`, { text: m.text, id: m.id })).messages))
    setWaiting(left)
  }, [merge])

  useEffect(() => {
    const on = () => (setOnline(true), flush())
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => (window.removeEventListener('online', on), window.removeEventListener('offline', off))
  }, [flush])

  // New replies arrive while she has the page open (her health worker may answer any time).
  useEffect(() => {
    let live = true
    const pull = () =>
      api
        .poll(`/me/messages?after=${lastRef.current}`)
        .then((d) => {
          if (!live) return
          setOnline(true)
          merge(d.messages)
          if (queued().length) flush()
        })
        .catch((e) => live && !(e instanceof ApiError) && setOnline(false))
        .finally(() => live && setLoaded(true))
    pull()
    const id = setInterval(pull, POLL_MS)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [merge, flush])

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  async function send(fn) {
    setBusy(true)
    setError('')
    try {
      merge((await fn()).messages)
      return true
    } catch {
      setError(t('web_error'))
      return false
    } finally {
      setBusy(false)
    }
  }

  // Typed, tapped (a menu button, an example, "Talk to a person"): all the same message to Ubah.
  async function sendMessage(body) {
    if (!body) return true
    const id = messageId()
    if (!online) {
      enqueue(body, id)
      setWaiting(queued())
      return true
    }
    setBusy(true)
    setError('')
    try {
      merge((await api.post(`/me/messages?after=${last}`, { text: body, id })).messages)
      return true
    } catch (err) {
      if (err instanceof ApiError) {
        setError(t('web_error'))
        return false
      }
      // The connection dropped: keep it for later, with the same id (it may have arrived already).
      enqueue(body, id)
      setWaiting(queued())
      setOnline(false)
      return true
    } finally {
      setBusy(false)
    }
  }

  async function sendText(e) {
    e.preventDefault()
    if (await sendMessage(text.trim())) setText('')
  }

  // Only the newest message's menu can be tapped: older menus no longer apply.
  const lastUbah = [...messages].reverse().find((m) => m.from !== 'me')

  return (
    <>
      <main className="flex-1 px-4 pb-6" aria-live="polite">
        {loaded && messages.length === 0 && (
          <section className="mt-6 rounded-[28px] bg-lavender p-7">
            <h1 className="mb-3 text-[34px] leading-tight">{t('web_chat_title')}</h1>
            <p className="mb-5 text-text">{t('web_chat_empty')}</p>
            <p className="mb-2 text-[15px] font-medium text-plum">{t('app_ask_examples')}</p>
            <div className="flex flex-col gap-2">
              {['app_ex_1', 'app_ex_2', 'app_ex_3', 'app_ex_4'].map((k) => (
                <button key={k} type="button" disabled={busy} onClick={() => sendMessage(t(k))} className="rounded-2xl bg-white px-4 py-3 text-left text-[16px] text-plum ring-1 ring-hair hover:ring-accent">
                  {t(k)}
                </button>
              ))}
            </div>
          </section>
        )}
        <ol className="mt-4 flex flex-col gap-3">
          {messages.map((m) => (
            <Bubble key={m.id} m={m} onOption={m === lastUbah ? (id) => sendMessage(id) : null} busy={busy} />
          ))}
        </ol>
        {waiting.length > 0 && (
          <ol className="mt-3 flex flex-col gap-3" aria-label={t('app_offline')}>
            {waiting.map((w, i) => (
              <li key={i} className="max-w-[85%] self-end rounded-[20px_20px_4px_20px] bg-white/60 px-4 py-3 text-[16px] text-muted border border-dashed border-line">
                {w.text}
              </li>
            ))}
          </ol>
        )}
        <div ref={end} />
      </main>

      <footer className="sticky bottom-14 border-t border-hair bg-cream/95 px-4 pt-4 pb-4 backdrop-blur">
        {!online && (
          <p role="status" className="mb-3 rounded-2xl bg-lavender px-4 py-2 text-[15px] text-plum">
            {t('app_offline')}
          </p>
        )}
        {error && (
          <p role="alert" className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">
            {error}
          </p>
        )}
        {typing ? (
          <form onSubmit={sendText} className="flex items-end gap-2">
            <label className="sr-only" htmlFor="msg">
              {t('web_type_placeholder')}
            </label>
            <textarea id="msg" rows={2} maxLength={1000} className="field min-h-12 flex-1 resize-none" placeholder={t('web_type_placeholder')} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
            <button className="btn px-5" disabled={busy || !text.trim()}>
              {busy ? t('web_sending') : t('web_send')}
            </button>
          </form>
        ) : (
          <Recorder busy={busy || !online} onAudio={(blob) => send(() => api.upload(`/me/voice?after=${last}`, blob, messageId()))} />
        )}
        <p className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
          <button type="button" className="text-[15px] font-medium text-accent underline underline-offset-4" onClick={() => setTyping(!typing)}>
            {typing ? t('web_record') : t('web_type')}
          </button>
          {/* DADA: the word every channel understands, in every language. */}
          <button type="button" disabled={busy} className="text-[15px] font-medium text-accent underline underline-offset-4" title={t('app_talk_person_sub')} onClick={() => sendMessage('DADA')}>
            {t('app_talk_person')}
          </button>
        </p>
      </footer>
    </>
  )
}

function Bubble({ m, onOption, busy }) {
  const { t } = useStrings()
  const [english, setEnglish] = useState(false)
  if (m.from === 'me')
    return (
      <li className="max-w-[85%] self-end rounded-[20px_20px_4px_20px] bg-white px-4 py-3 text-[16px] text-text ring-1 ring-hair">
        {m.kind === 'voice' && <span className="mb-0.5 block text-[13px] text-muted">{t('web_voice_note')}</span>}
        <span className="whitespace-pre-line">{m.text}</span>
      </li>
    )
  if (m.from === 'worker' || m.from === 'protection')
    return (
      <li className="max-w-[88%] self-start rounded-[20px_20px_20px_4px] bg-blush px-4 py-3 text-[16px] text-plum">
        <span className="mb-1 block text-[13px] font-medium text-rose-ink">{m.from === 'protection' ? t('rp_from') : t('web_from_worker')}</span>
        <span className="whitespace-pre-line" lang={english ? 'en' : undefined}>
          {english && m.english ? m.english : m.text}
        </span>
        {m.audio && <audio controls preload="none" src={m.audio} className="mt-2 w-full" aria-label={t('web_from_worker')} />}
        {m.english && (
          <button type="button" className="mt-2 block text-[14px] font-medium text-accent underline underline-offset-4" onClick={() => setEnglish(!english)} aria-pressed={english}>
            {english ? t('web_hide_english') : t('web_show_english')}
          </button>
        )}
      </li>
    )
  return (
    <li className="flex max-w-[88%] flex-col gap-2 self-start">
      {m.text && <span className="rounded-[20px_20px_20px_4px] bg-plum px-4 py-3 text-[16px] leading-relaxed whitespace-pre-line text-cream">{m.text}</span>}
      {m.options?.length > 0 && (
        <span className="flex flex-col gap-1.5">
          {m.options.map((o) => (
            <button
              key={o.id}
              type="button"
              disabled={!onOption || busy}
              onClick={() => onOption?.(o.id)}
              className="rounded-2xl bg-white px-4 py-2.5 text-left text-[16px] text-plum ring-1 ring-line hover:ring-accent disabled:text-muted disabled:ring-hair"
            >
              {o.title}
            </button>
          ))}
        </span>
      )}
    </li>
  )
}

// One big button: tap to talk, tap again to send.
function Recorder({ busy, onAudio }) {
  const { t } = useStrings()
  const [state, setState] = useState('idle') // idle | recording
  const [seconds, setSeconds] = useState(0)
  const [problem, setProblem] = useState('')
  const rec = useRef(null)
  const timer = useRef(null)
  const supported = typeof window !== 'undefined' && 'MediaRecorder' in window && navigator.mediaDevices?.getUserMedia

  function stopTimer() {
    clearInterval(timer.current)
    timer.current = null
  }

  async function start() {
    setProblem('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((x) => MediaRecorder.isTypeSupported?.(x))
      const r = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 24000 } : undefined)
      const chunks = []
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop())
        stopTimer()
        setState('idle')
        const blob = new Blob(chunks, { type: (r.mimeType || 'audio/webm').split(';')[0] })
        if (blob.size) onAudio(blob)
      }
      rec.current = r
      r.start()
      setSeconds(0)
      setState('recording')
      timer.current = setInterval(
        () =>
          setSeconds((s) => {
            if (s + 1 >= MAX_SECONDS) rec.current?.stop()
            return s + 1
          }),
        1000,
      )
    } catch {
      setProblem(t('web_mic_blocked'))
    }
  }

  useEffect(() => () => stopTimer(), [])

  if (!supported) return <p className="text-center text-[15px] text-muted">{t('app_voice_unsupported')}</p>

  const recording = state === 'recording'
  return (
    <div className="flex flex-col items-center gap-2">
      {problem && (
        <p role="alert" className="text-center text-[15px] text-rose-ink">
          {problem}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => (recording ? rec.current?.stop() : start())}
        aria-pressed={recording}
        className={`relative flex h-24 w-24 items-center justify-center rounded-full text-white transition-colors disabled:opacity-60 ${recording ? 'bg-plum' : 'bg-accent hover:bg-plum'}`}
      >
        {recording && <span className="absolute inset-0 animate-ping rounded-full bg-rose/60" aria-hidden="true" />}
        <svg viewBox="0 0 24 24" className="relative h-10 w-10 fill-none stroke-white stroke-[1.8] [stroke-linecap:round]" aria-hidden="true">
          {recording ? <rect x="7" y="7" width="10" height="10" rx="2" className="fill-white" /> : <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>}
        </svg>
        <span className="sr-only">{recording ? t('web_recording') : t('web_record')}</span>
      </button>
      <p className="text-[15px] font-medium text-plum" aria-hidden="true">
        {busy ? t('web_sending') : recording ? `${t('web_recording')} · ${seconds}s` : t('web_record')}
      </p>
    </div>
  )
}
