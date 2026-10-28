import { useCallback, useEffect, useState } from 'react'
import { Link, NavLink, Route, Routes } from 'react-router'
import { api, ApiError } from '../../lib/api.js'
import LockScreen from './LockScreen.jsx'
import Intro, { introSeen } from './Intro.jsx'
import MyData from './MyData.jsx'
import { Waiting } from '../../lib/session.jsx'
import { StringsProvider, savedLanguage, useStrings } from '../../lib/strings.jsx'
import { registerOffline } from '../../lib/offline.js'
import { Brand } from '../../ui/Brand.jsx'
import { QuickExit } from '../../ui/QuickExit.jsx'
import Chat from './Chat.jsx'
import Settings from './Settings.jsx'
import Care from './Care.jsx'
import Passes from './Passes.jsx'
import Learn from './Learn.jsx'

// The girls' space. Light on purpose: cheap Android phones, slow data. Every word is in her language.
export default function GirlApp() {
  const [me, setMe] = useState(null)
  const [locked, setLocked] = useState(false)
  const [intro, setIntro] = useState(() => !introSeen())
  const reload = useCallback(
    () =>
      api
        .get('/me')
        .then((d) => (setMe(d), setLocked(false)))
        .catch((e) => {
          if (e instanceof ApiError && e.code === 'pin_needed') return setLocked(true)
          setMe({ language: savedLanguage() || 'en', consents: {}, languages: [], offline: true })
        }),
    [],
  )
  useEffect(() => {
    registerOffline()
    reload()
    const lock = () => setLocked(true)
    window.addEventListener('ubah:locked', lock)
    return () => window.removeEventListener('ubah:locked', lock)
  }, [reload])
  if (locked)
    return (
      <StringsProvider lang={me?.language || savedLanguage()}>
        <LockScreen onUnlocked={reload} />
      </StringsProvider>
    )
  if (!me) return <Waiting />
  return (
    <StringsProvider lang={me.language}>
      <Shell>
        <Routes>
          <Route index element={intro ? <Intro onDone={() => setIntro(false)} /> : <Chat />} />
          <Route path="intro" element={<Intro onDone={() => history.back()} />} />
          <Route path="care" element={<Care />} />
          <Route path="passes" element={<Passes />} />
          <Route path="learn" element={<Learn />} />
          <Route path="settings" element={<Settings me={me} setMe={setMe} />} />
          <Route path="data" element={<MyData />} />
        </Routes>
      </Shell>
    </StringsProvider>
  )
}

function Shell({ children }) {
  const { t, ready, lang } = useStrings()
  if (!ready) return <Waiting />
  return (
    <div lang={lang} className="mx-auto flex min-h-dvh max-w-xl flex-col">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-3 bg-cream/95 px-4 py-3 backdrop-blur">
        <Brand to="/me" />
        <div className="flex items-center gap-2">
          <Link to="/me/settings" className="btn-quiet" aria-label={t('web_settings')}>
            <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-plum stroke-[1.8]" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z" />
            </svg>
          </Link>
          <QuickExit label={t('web_quick_exit')} />
        </div>
      </header>
      {children}
      <BottomNav />
    </div>
  )
}

// Every item has an icon and a word: some girls read little.
const NAV = [
  ['/me', 'app_nav_ask', <path key="a" d="M4 5h16v11H8l-4 4z" />],
  ['/me/care', 'app_nav_care', <path key="c" d="M12 21s-7-4.5-7-11a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 6.5-7 11-7 11z" />],
  ['/me/passes', 'app_nav_passes', <path key="p" d="M4 7h16v10H4zM8 7v10" />],
  ['/me/learn', 'app_nav_learn', <path key="l" d="M4 5h7a3 3 0 0 1 3 3v12a2 2 0 0 0-2-2H4zM20 5h-6M20 5v13h-6" />],
]

function BottomNav() {
  const { t } = useStrings()
  return (
    <nav aria-label="Ubah" className="fixed inset-x-0 bottom-0 z-20 border-t border-hair bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto grid max-w-xl grid-cols-4">
        {NAV.map(([to, key, icon]) => (
          <li key={to}>
            <NavLink to={to} end className={({ isActive }) => `flex min-h-14 flex-col items-center justify-center gap-0.5 text-[12px] no-underline ${isActive ? 'font-medium text-accent' : 'text-muted'}`}>
              <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-current stroke-[1.8] [stroke-linejoin:round]" aria-hidden="true">
                {icon}
              </svg>
              {t(key)}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
