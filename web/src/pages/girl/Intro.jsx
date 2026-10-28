import { useStrings } from '../../lib/strings.jsx'

// "How Ubah works": shown once on this phone, and from Settings. Three short points, before she types anything.
const KEY = 'ubah:intro-seen'

export function introSeen() {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true // can't remember it: don't show it every time
  }
}

export default function Intro({ onDone }) {
  const { t } = useStrings()
  const done = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* shown again next time: harmless */
    }
    onDone()
  }
  const points = [
    ['bg-lavender', 'app_intro_private_t', 'web_intro_private', <path key="p" d="M12 3l7 3v5c0 5-3.5 8-7 10-3.5-2-7-5-7-10V6z" />],
    ['bg-blush', 'app_intro_ask_t', 'app_intro_ask', <path key="a" d="M4 5h16v11H8l-4 4z" />],
    ['bg-white ring-1 ring-hair', 'app_intro_care_t', 'app_intro_care', <path key="c" d="M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.5-7 11-7 11z" />],
  ]
  return (
    <main className="px-4 pt-4 pb-28">
      <h1 className="mb-5 text-[38px] leading-tight">{t('app_intro_title')}</h1>
      <ol className="mb-6 flex flex-col gap-3">
        {points.map(([bg, title, body, icon]) => (
          <li key={title} className={`rounded-[24px] p-5 ${bg}`}>
            <svg viewBox="0 0 24 24" className="mb-2 h-7 w-7 fill-none stroke-plum stroke-[1.8] [stroke-linejoin:round]" aria-hidden="true">
              {icon}
            </svg>
            <h2 className="mb-1 font-sans text-[19px] font-medium">{t(title)}</h2>
            <p className="text-[16px] text-text">{t(body)}</p>
          </li>
        ))}
      </ol>
      <p className="mb-6 rounded-[20px] bg-blush px-5 py-4 text-[15px] text-rose-ink">{t('web_confidential')}</p>
      <button type="button" className="btn w-full" onClick={done}>
        {t('app_intro_start')}
      </button>
    </main>
  )
}
