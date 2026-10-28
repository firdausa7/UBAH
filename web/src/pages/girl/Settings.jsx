import { useEffect, useState } from 'react'
import { currentSubscription, pushSupported, turnOffPush, turnOnPush } from '../../lib/push.js'
import { Link, useNavigate } from 'react-router'
import { api } from '../../lib/api.js'
import { useSession } from '../../lib/session.jsx'
import { forgetEverything } from '../../lib/offline.js'
import { useStrings } from '../../lib/strings.jsx'

export default function Settings({ me, setMe }) {
  const { t } = useStrings()
  const { signOut } = useSession()
  const navigate = useNavigate()
  const [saved, setSaved] = useState('')
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [push, setPush] = useState({ available: false, on: false, blocked: false })

  useEffect(() => {
    if (!pushSupported()) return
    Promise.all([api.get('/me/push'), currentSubscription()])
      .then(([p, sub]) => setPush({ available: p.enabled, publicKey: p.publicKey, on: Boolean(sub), blocked: Notification.permission === 'denied' }))
      .catch(() => {})
  }, [])

  async function togglePush(on) {
    if (on) {
      const r = await turnOnPush(push.publicKey, { title: t('web_push_title'), body: t('web_push_body') }).catch(() => 'error')
      setPush({ ...push, on: r === 'on', blocked: r === 'blocked' })
    } else {
      await turnOffPush()
      setPush({ ...push, on: false })
    }
  }
  const [wipeError, setWipeError] = useState('')

  async function wipe() {
    try {
      await turnOffPush()
      await api.del('/me')
      forgetEverything()
      await signOut()
      navigate('/login', { replace: true })
    } catch {
      setWipeError(t('web_error'))
    }
  }

  async function language(code) {
    const r = await api.patch('/me', { language: code })
    setMe({ ...me, language: r.language })
  }

  async function share(scope, value) {
    const r = await api.put('/me/consents', { [scope]: value })
    setMe({ ...me, consents: r.consents })
    setSaved(scope)
    setTimeout(() => setSaved(''), 1500)
  }

  return (
    <main className="flex flex-col gap-5 px-4 pt-2 pb-12">
      <Link to="/me" className="btn-quiet self-start">
        ← {t('web_back')}
      </Link>

      <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
        <h2 className="mb-4 text-[28px] leading-tight">{t('web_language')}</h2>
        <div className="grid grid-cols-2 gap-2">
          {me.languages.map((l) => (
            <button
              key={l.code}
              type="button"
              lang={l.code}
              onClick={() => language(l.code)}
              aria-pressed={me.language === l.code}
              className={`min-h-12 rounded-2xl border px-3 ${me.language === l.code ? 'border-accent bg-lavender font-medium text-plum' : 'border-line bg-white text-text hover:border-accent'}`}
            >
              {l.name}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-[28px] bg-blush p-6">
        <h2 className="mb-4 text-[28px] leading-tight">{t('web_share_title')}</h2>
        <Toggle label={t('web_share_messages')} hint={t('web_share_messages_hint')} on={Boolean(me.consents.messages)} onChange={(v) => share('messages', v)} saved={saved === 'messages' && t('web_saved')} />
        <Toggle label={t('web_share_voice')} hint={t('web_share_voice_hint')} on={Boolean(me.consents.voice)} onChange={(v) => share('voice', v)} saved={saved === 'voice' && t('web_saved')} />
        <p className="mt-4 text-[15px] text-rose-ink">{t('web_share_urgent')}</p>
      </section>

      {push.available && (
        <section className="rounded-[28px] bg-white px-6 py-2 ring-1 ring-hair">
          <Toggle label={t('web_push')} hint={push.blocked ? t('web_push_blocked') : t('web_push_hint')} on={push.on} onChange={togglePush} />
        </section>
      )}

      <Link to="/me/data" className="btn-ghost self-center">
        {t('web_data')}
      </Link>

      <Link to="/me/intro" className="btn-quiet self-center">
        {t('app_intro_title')}
      </Link>

      <button type="button" className="btn-ghost self-center" onClick={async () => (await turnOffPush(), await signOut(), navigate('/login', { replace: true }))}>
        {t('web_sign_out')}
      </button>

      <section className="rounded-[28px] bg-white p-6 ring-1 ring-hair">
        <h2 className="mb-2 text-[26px] leading-tight">{t('app_wipe')}</h2>
        <p className="mb-4 text-[15px] text-text">{t('app_wipe_explain')}</p>
        {wipeError && (
          <p role="alert" className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">
            {wipeError}
          </p>
        )}
        {confirmWipe ? (
          <div role="alertdialog" aria-label={t('app_wipe')} className="rounded-2xl bg-blush p-4">
            <p className="mb-3 font-medium text-rose-ink">{t('app_wipe_confirm')}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn border-urgent bg-urgent hover:border-plum" onClick={wipe}>
                {t('app_wipe_yes')}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setConfirmWipe(false)}>
                {t('app_cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn-ghost" onClick={() => setConfirmWipe(true)}>
            {t('app_wipe')}
          </button>
        )}
      </section>
    </main>
  )
}

function Toggle({ label, hint, on, onChange, saved }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-rose/60 py-4 first-of-type:border-t-0">
      <div>
        <p className="font-medium text-plum">{label}</p>
        <p className="text-[15px] text-text">{hint}</p>
        {saved && (
          <p className="mt-1 text-[14px] text-accent" role="status">
            {saved}
          </p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => onChange(!on)}
        className={`relative mt-1 h-8 w-14 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-white ring-1 ring-line'}`}
      >
        <span className={`absolute top-1 h-6 w-6 rounded-full transition-all ${on ? 'left-7 bg-white' : 'left-1 bg-muted/50'}`} />
      </button>
    </div>
  )
}
