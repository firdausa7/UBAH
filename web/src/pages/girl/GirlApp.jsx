import { useCallback, useEffect, useState } from 'react'
import { Link, Route, Routes } from 'react-router'
import { api } from '../../lib/api.js'
import { Waiting } from '../../lib/session.jsx'
import { StringsProvider, useStrings } from '../../lib/strings.jsx'
import { Brand } from '../../ui/Brand.jsx'
import { QuickExit } from '../../ui/QuickExit.jsx'
import Chat from './Chat.jsx'
import Settings from './Settings.jsx'

// The girls' space. Light on purpose: cheap Android phones, slow data. Every word is in her language.
export default function GirlApp() {
  const [me, setMe] = useState(null)
  const reload = useCallback(() => api.get('/me').then(setMe), [])
  useEffect(() => {
    reload().catch(() => setMe({ language: 'en', consents: {}, languages: [] }))
  }, [reload])
  if (!me) return <Waiting />
  return (
    <StringsProvider lang={me.language}>
      <Shell>
        <Routes>
          <Route index element={<Chat />} />
          <Route path="settings" element={<Settings me={me} setMe={setMe} />} />
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
    </div>
  )
}
