import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

// Her right to see her data: what Ubah keeps, in plain words, and a copy to download.
export default function MyData() {
  const { t, lang } = useStrings()
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    api
      .get('/me/data')
      .then(setData)
      .catch(() => setError(true))
  }, [])

  function download() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'ubah-my-data.json'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const date = (d) => new Date(d).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })
  const row = (label, value) => (
    <div className="flex justify-between gap-4 border-t border-hair py-3 first:border-t-0">
      <dt className="text-text">{label}</dt>
      <dd className="text-right font-medium text-plum">{value}</dd>
    </div>
  )

  return (
    <main className="flex flex-col gap-5 px-4 pt-2 pb-28">
      <Link to="/me/settings" className="btn-quiet self-start">
        ← {t('web_back')}
      </Link>
      <h1 className="text-[34px] leading-tight">{t('web_data')}</h1>
      <p className="text-text">{t('web_data_intro')}</p>
      {error && <p className="rounded-2xl bg-blush px-4 py-2 text-rose-ink">{t('web_error')}</p>}
      {data && (
        <>
          <dl className="rounded-[28px] bg-white px-6 py-2 ring-1 ring-hair">
            {row(t('web_data_code'), data.account.code)}
            {row(t('web_language'), data.account.language)}
            {row(t('web_data_joined'), date(data.account.joined))}
            {row(t('web_data_phone'), t('web_data_phone_kept'))}
            {row(t('web_data_worker'), data.healthWorker === 'nurse' ? t('web_data_worker_nurse') : data.healthWorker === 'dada' ? t('web_data_worker_dada') : t('web_data_worker_none'))}
            {row(t('web_share_messages'), data.sharing.messages ? '✓' : '—')}
            {row(t('web_share_voice'), data.sharing.voice ? '✓' : '—')}
          </dl>
          <dl className="rounded-[28px] bg-lavender px-6 py-2">
            <p className="eyebrow pt-3">{t('web_data_counts')}</p>
            {row(t('web_data_messages'), data.counts.messages)}
            {row(t('web_data_passes'), data.counts.passes)}
            {row(t('web_data_voice'), data.counts.voiceRecordings)}
          </dl>
          <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
            <button type="button" className="btn w-full" onClick={download}>
              {t('web_data_download')}
            </button>
            <p className="mt-3 text-[14px] text-rose-ink">{t('web_data_download_warn')}</p>
          </section>
          <p className="text-[15px] text-text">{t('web_data_change')}</p>
        </>
      )}
    </main>
  )
}
