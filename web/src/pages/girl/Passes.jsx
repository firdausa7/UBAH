import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

export default function Passes() {
  const { t, lang } = useStrings()
  const [passes, setPasses] = useState(null)
  useEffect(() => {
    api
      .get('/me/passes')
      .then((d) => setPasses(d.passes))
      .catch(() => setPasses([]))
  }, [])
  const date = (d) => new Date(d).toLocaleDateString(lang, { day: 'numeric', month: 'long' })

  return (
    <main className="px-4 pt-2 pb-28">
      <h1 className="mb-1 text-[34px] leading-tight">{t('app_nav_passes')}</h1>
      <p className="mb-4 text-[15px] text-text">{t('app_passes_intro')}</p>
      {passes?.length === 0 && (
        <div className="rounded-[28px] bg-lavender p-6">
          <p className="mb-4 text-plum">{t('app_passes_empty')}</p>
          <Link to="/me/care" className="btn">
            {t('app_pass_get')}
          </Link>
        </div>
      )}
      <ul className="flex flex-col gap-3">
        {(passes ?? []).map((p) => (
          <li key={p.code} className={`rounded-[28px] p-5 ${p.valid ? 'bg-plum text-cream' : 'bg-white text-text ring-1 ring-hair'}`}>
            <div className="mb-1 flex items-center justify-between gap-2 text-[14px]">
              <span className={`tag ${p.valid ? 'bg-cream/15 text-cream' : 'bg-soft text-muted'}`}>{p.valid ? t('app_pass_ready') : p.redeemed ? t('app_pass_used') : t('app_pass_expired')}</span>
              {p.valid && <span className="text-mist">{t('app_pass_valid').replace('{date}', date(p.expiresAt))}</span>}
            </div>
            <p className={`font-serif text-[40px] leading-tight font-semibold tracking-[3px] ${p.valid ? '' : 'text-muted'}`}>{p.code}</p>
            <p className={`text-[15px] ${p.valid ? 'text-mist' : ''}`}>{p.services.map((s) => t(`svc_${s}`) || s).join(' · ')}</p>
            {p.clinic && (
              <p className={`mt-1 text-[15px] ${p.valid ? 'text-cream' : ''}`}>
                {p.clinic}, {p.area} · {p.hours}
              </p>
            )}
          </li>
        ))}
      </ul>
    </main>
  )
}
