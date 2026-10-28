import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

// My wellbeing: a private mood check-in and notes, and a way to reach a person.
// Only she sees her entries; nothing here is sent to staff. If what she writes sounds serious, or her
// mood has been very low, Ubah offers HER a person now. "I need help now" is always a person at once.
const FACES = ['😞', '🙁', '😐', '🙂', '😊']

export default function Wellbeing() {
  const { t, lang } = useStrings()
  const navigate = useNavigate()
  const [entries, setEntries] = useState(null)
  const [mood, setMood] = useState(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [offer, setOffer] = useState(null) // 'low' | 'urgent'
  const [saved, setSaved] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [helpSent, setHelpSent] = useState(false)

  const load = () => api.get('/me/wellbeing').then((d) => setEntries(d.entries)).catch(() => setEntries([]))
  useEffect(() => {
    load()
  }, [])

  async function save(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api.post('/me/wellbeing', { mood, note: note.trim() || undefined })
      setOffer(r.support)
      setSaved(true)
      setMood(null)
      setNote('')
      load()
    } finally {
      setBusy(false)
    }
  }

  async function talk() {
    await api.post('/me/messages', { text: 'DADA' })
    navigate('/me')
  }

  async function helpNow(kind) {
    setBusy(true)
    try {
      await api.post('/me/urgent', { kind })
      setHelpSent(true)
    } finally {
      setBusy(false)
    }
  }

  const date = (d) => new Date(d).toLocaleDateString(lang, { day: 'numeric', month: 'short' })

  return (
    <main className="flex flex-col gap-5 px-4 pt-2 pb-28">
      <h1 className="text-[34px] leading-tight">{t('wb_title')}</h1>

      <form onSubmit={save} className="rounded-[28px] bg-lavender p-6">
        <fieldset>
          <legend className="mb-3 font-medium text-plum">{t('wb_mood_q')}</legend>
          <div className="grid grid-cols-5 gap-1.5">
            {[1, 2, 3, 4, 5].map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mood === m}
                aria-label={t(`wb_mood_${m}`)}
                onClick={() => setMood(mood === m ? null : m)}
                className={`flex flex-col items-center gap-1 rounded-2xl py-2 text-[12px] ${mood === m ? 'bg-white text-plum ring-2 ring-accent' : 'text-text hover:bg-white/60'}`}
              >
                <span className="text-[28px] leading-none" aria-hidden="true">
                  {FACES[m - 1]}
                </span>
                {t(`wb_mood_${m}`)}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="mt-4 block">
          <span className="label">{t('wb_note')}</span>
          <textarea rows={3} maxLength={4000} className="field resize-none" value={note} onChange={(e) => (setNote(e.target.value), setSaved(false))} />
        </label>
        <p className="mt-2 text-[14px] text-text">{t('wb_private')}</p>
        <button className="btn mt-4 w-full" disabled={busy || (!mood && !note.trim())}>
          {saved ? t('wb_saved') : t('wb_save')}
        </button>
      </form>

      {offer && (
        <section role="alert" className={`rounded-[28px] p-6 ${offer === 'urgent' ? 'bg-rose text-rose-ink' : 'bg-blush text-rose-ink'}`}>
          <p className="mb-4">{offer === 'urgent' ? t('wb_urgent') : t('wb_low')}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn" onClick={talk}>
              {t('wb_talk')}
            </button>
            {offer === 'urgent' && (
              <button type="button" className="btn-ghost bg-white" onClick={() => setHelpOpen(true)}>
                {t('wb_help_now')}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
        <h2 className="mb-2 text-[28px] leading-tight">{t('wb_support')}</h2>
        <p className="mb-4 text-[15px] text-text">{t('wb_not_therapy')}</p>
        <div className="flex flex-col gap-2">
          <button type="button" className="btn" onClick={talk}>
            {t('wb_talk')}
          </button>
          <button type="button" className="btn-ghost" aria-expanded={helpOpen} onClick={() => setHelpOpen(!helpOpen)}>
            {t('wb_help_now')}
          </button>
          <Link to="/me/report" className="btn-quiet justify-center">
            {t('rp_open')}
          </Link>
        </div>
        {helpOpen && !helpSent && (
          <div className="mt-3 flex flex-col gap-2" role="group" aria-label={t('wb_help_now')}>
            {['medical', 'safety', 'selfharm'].map((k) => (
              <button key={k} type="button" disabled={busy} onClick={() => helpNow(k)} className="rounded-2xl bg-blush px-4 py-3 text-left font-medium text-rose-ink hover:ring-2 hover:ring-rose">
                {t(`wb_help_${k}`)}
              </button>
            ))}
          </div>
        )}
        {helpSent && (
          <p role="status" className="mt-3 rounded-2xl bg-lavender px-4 py-3 text-plum">
            {t('wb_help_sent')}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-[26px] leading-tight">{t('wb_journal')}</h2>
        {entries?.length === 0 && <p className="text-text">{t('wb_journal_empty')}</p>}
        <ul className="flex flex-col gap-2">
          {(entries ?? []).map((e) => (
            <li key={e.id} className="rounded-3xl bg-white p-4 ring-1 ring-hair">
              <div className="mb-1 flex items-center justify-between text-[14px] text-muted">
                <span>
                  {date(e.at)}
                  {e.mood ? ` · ${FACES[e.mood - 1]} ${t(`wb_mood_${e.mood}`)}` : ''}
                </span>
                <button type="button" className="text-accent underline underline-offset-4" onClick={async () => (await api.del(`/me/wellbeing/${e.id}`), load())}>
                  {t('wb_delete')}
                </button>
              </div>
              {e.note && <p className="whitespace-pre-line text-plum">{e.note}</p>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
