import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

// Care in three steps: what she needs, the partner clinics that can help, then one free pass.
export default function Care() {
  const { t } = useStrings()
  const [services, setServices] = useState([])
  const [picked, setPicked] = useState([])
  const [clinics, setClinics] = useState(null)
  const [pass, setPass] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .get(`/me/clinics?services=${picked.join(',')}`)
      .then((d) => (setServices(d.services), setClinics(d.clinics)))
      .catch(() => setError(t('web_error')))
  }, [picked, t])

  const toggle = (s) => setPicked((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))
  const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '')

  async function getPass() {
    setBusy(true)
    setError('')
    try {
      const r = await api.post('/me/passes', { services: picked })
      setPass(r.code ? r : { none: true })
    } catch {
      setError(t('web_error'))
    } finally {
      setBusy(false)
    }
  }

  if (pass)
    return (
      <main className="px-4 pt-2 pb-28">
        {pass.code ? (
          <section className="rounded-[28px] bg-plum p-7 text-center text-cream">
            <p className="eyebrow mb-2 !text-mist">{t('app_your_pass')}</p>
            <p className="font-serif text-[52px] leading-none font-semibold tracking-[4px]">{pass.code}</p>
            <p className="mt-4 text-mist">{t('app_pass_show')}</p>
            <Link to="/me/passes" className="btn mt-6 bg-cream text-plum hover:bg-mist">
              {t('app_nav_passes')}
            </Link>
          </section>
        ) : (
          <section className="rounded-[28px] bg-blush p-7">
            <p className="text-rose-ink">{t('app_no_clinics')}</p>
          </section>
        )}
      </main>
    )

  return (
    <main className="flex flex-col gap-5 px-4 pt-2 pb-28">
      <section>
        {/* app_care_pick already asks "What do you need? Pick one or more.": it is the heading. */}
        <h1 className="mb-3 text-[30px] leading-tight">
          <span className="mr-2 font-sans text-[15px] font-medium text-accent">1</span>
          {t('app_care_pick')}
        </h1>
        <div className="flex flex-wrap gap-2">
          {services.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={picked.includes(s)}
              onClick={() => toggle(s)}
              className={`min-h-11 rounded-full border px-4 text-[15px] ${picked.includes(s) ? 'border-accent bg-lavender font-medium text-plum' : 'border-line bg-white text-text'}`}
            >
              {t(`svc_${s}`) || s}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[28px] leading-tight">
          <span className="mr-2 font-sans text-[15px] font-medium text-accent">2</span>
          {picked.length ? t('app_care_step2') : t('app_care_all')}
        </h2>
        {error && <p className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">{error}</p>}
        {clinics?.length === 0 && <p className="text-text">{t('app_no_clinics')}</p>}
        <ul className="flex flex-col gap-2">
          {(clinics ?? []).map((c) => (
            <li key={c.id} className="rounded-3xl bg-white p-4 ring-1 ring-hair">
              <p className="font-medium text-plum">
                {c.name} {c.verified && <span className="tag ml-1 bg-lavender text-plum">{t('app_verified')}</span>}
              </p>
              <p className="text-[15px] text-text">
                {c.area} · {c.hours}
              </p>
              <p className="mt-1 text-[14px] text-muted">{c.rating ? fill(t('app_rating'), { yes: c.rating.respectful, total: c.rating.total }) : t('app_no_rating')}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="sticky bottom-24 rounded-[28px] bg-lavender p-5">
        <h2 className="mb-1 text-[26px] leading-tight">
          <span className="mr-2 font-sans text-[15px] font-medium text-accent">3</span>
          {t('app_care_step3')}
        </h2>
        <p className="mb-3 text-[15px] text-text">{t('app_care_pass_note')}</p>
        <button type="button" className="btn w-full" disabled={busy || !picked.length} onClick={getPass}>
          {picked.length ? t('app_get_pass') : t('app_pick_first')}
        </button>
      </section>
    </main>
  )
}
