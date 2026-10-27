import { useEffect, useState } from 'react'
import { api } from '../../lib/api.js'
import { useStrings } from '../../lib/strings.jsx'

// Short lessons checked by health workers, grouped by topic; tap one to read or listen.
export default function Learn() {
  const { t } = useStrings()
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(null)
  useEffect(() => {
    api
      .get('/me/learn')
      .then(setData)
      .catch(() => setData({ lessons: [], upcoming: [] }))
  }, [])

  if (open)
    return (
      <main className="px-4 pt-2 pb-28">
        <button type="button" className="btn-quiet mb-2" onClick={() => setOpen(null)}>
          ← {t('web_back')}
        </button>
        <article className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
          <p className="eyebrow mb-2">{t(`cat_${open.category}`) || open.category}</p>
          <h1 className="mb-4 text-[34px] leading-tight">{open.title}</h1>
          {open.audio && <audio controls preload="none" src={open.audio} className="mb-4 w-full" />}
          <p className="text-[17px] whitespace-pre-line text-text">{open.body}</p>
          {!open.translated && <p className="mt-4 text-[14px] text-muted">{t('translation_pending')}</p>}
        </article>
      </main>
    )

  const groups = {}
  for (const l of data?.lessons ?? []) (groups[l.category] ??= []).push(l)
  return (
    <main className="px-4 pt-2 pb-28">
      <h1 className="mb-1 text-[34px] leading-tight">{t('app_nav_learn')}</h1>
      <p className="mb-4 text-[15px] text-text">{t('app_learn_intro')}</p>
      {data && !data.lessons.length && <p className="rounded-[28px] bg-lavender p-6 text-plum">{t('app_learn_empty')}</p>}
      {Object.entries(groups).map(([cat, lessons]) => (
        <section key={cat} className="mb-5">
          <h2 className="mb-2 text-[24px]">{t(`cat_${cat}`) || cat}</h2>
          <ul className="flex flex-col gap-2">
            {lessons.map((l) => (
              <li key={l.id}>
                <button type="button" onClick={() => setOpen(l)} className="flex w-full items-center justify-between rounded-3xl bg-white p-4 text-left ring-1 ring-hair hover:ring-accent">
                  <span className="text-plum">{l.title}</span>
                  {l.audio && <span className="tag bg-soft text-plum">♪</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data?.upcoming?.length > 0 && (
        <section className="rounded-[28px] bg-blush p-5">
          <h2 className="mb-1 text-[24px]">{t('app_learn_soon_t')}</h2>
          <p className="mb-2 text-[15px] text-rose-ink">{t('app_learn_soon')}</p>
          <p className="text-[15px] text-plum">{data.upcoming.map((c) => t(`cat_${c}`) || c).join(' · ')}</p>
        </section>
      )}
    </main>
  )
}
