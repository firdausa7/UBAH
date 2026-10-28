import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

// A confidential report. Only "what happened" is needed; she may skip everything else.
// The honest note about confidentiality is shown before she sends it.
const CATS = ['harassment', 'abuse', 'exploitation', 'online', 'other']
const WHO = ['family', 'partner', 'school', 'stranger', 'online', 'other', 'not_said']
const WHEN = ['now', 'days', 'weeks', 'longer', 'not_said']

function Choices({ legend, options, value, onChange, prefix, t }) {
  return (
    <fieldset className="mb-5">
      <legend className="label">{legend}</legend>
      <div className="flex flex-col gap-1.5">
        {options.map((o) => (
          <button
            key={String(o)}
            type="button"
            aria-pressed={value === o}
            onClick={() => onChange(value === o ? null : o)}
            className={`min-h-11 rounded-2xl border px-4 py-2 text-left text-[15px] ${value === o ? 'border-accent bg-lavender font-medium text-plum' : 'border-line bg-white text-text hover:border-accent'}`}
          >
            {t(`${prefix}${o}`)}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export default function Report() {
  const { t } = useStrings()
  const [category, setCategory] = useState(null)
  const [inDanger, setInDanger] = useState(null)
  const [who, setWho] = useState(null)
  const [happened, setHappened] = useState(null)
  const [description, setDescription] = useState('')
  const [contactOk, setContactOk] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')
  const [mine, setMine] = useState([])

  useEffect(() => {
    api
      .get('/me/reports')
      .then((d) => setMine(d.reports))
      .catch(() => {})
  }, [done])

  async function send(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/me/report', { category, inDanger: inDanger === true, who, happened, description: description.trim() || undefined, contactOk: contactOk === true })
      setDone(true)
    } catch {
      setError(t('web_error'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex flex-col gap-5 px-4 pt-2 pb-28">
      <Link to="/me/wellbeing" className="btn-quiet self-start">
        ← {t('web_back')}
      </Link>
      <h1 className="text-[34px] leading-tight">{t('rp_title')}</h1>
      {done ? (
        <p role="status" className="rounded-[28px] bg-lavender p-6 text-plum">
          {t('rp_received')}
        </p>
      ) : (
        <form onSubmit={send} className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
          <p className="mb-5 text-text">{t('rp_intro')}</p>
          <Choices legend={t('rp_what')} options={CATS} value={category} onChange={setCategory} prefix="rp_cat_" t={t} />
          <Choices legend={t('rp_danger')} options={[true, false]} value={inDanger} onChange={setInDanger} prefix="" t={(k) => (k === 'true' ? t('rp_yes') : t('rp_no'))} />
          <Choices legend={t('rp_who')} options={WHO} value={who} onChange={setWho} prefix="rp_who_" t={t} />
          <Choices legend={t('rp_when')} options={WHEN} value={happened} onChange={setHappened} prefix="rp_when_" t={t} />
          <label className="mb-5 block">
            <span className="label">{t('rp_words')}</span>
            <textarea rows={4} maxLength={4000} className="field resize-none" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <Choices legend={t('rp_contact')} options={[true, false]} value={contactOk} onChange={setContactOk} prefix="" t={(k) => (k === 'true' ? t('rp_yes') : t('rp_no'))} />
          <p className="mb-5 rounded-2xl bg-blush px-4 py-3 text-[15px] text-rose-ink">{t('web_confidential')}</p>
          {error && (
            <p role="alert" className="mb-3 text-rose-ink">
              {error}
            </p>
          )}
          <button className="btn w-full" disabled={busy || !category}>
            {t('rp_send')}
          </button>
        </form>
      )}
      {mine.length > 0 && (
        <section>
          <h2 className="mb-2 text-[24px]">{t('rp_mine')}</h2>
          <ul className="flex flex-col gap-2">
            {mine.map((r) => (
              <li key={r.id} className="flex justify-between rounded-3xl bg-white p-4 text-[15px] ring-1 ring-hair">
                <span className="text-plum">{t(`rp_cat_${r.category}`).split(' (')[0]}</span>
                <span className="text-muted">{t(`rp_status_${r.status}`)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  )
}
