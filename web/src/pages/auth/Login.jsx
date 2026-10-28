import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { api } from '../../lib/api.js'
import { homeFor, useSession, Waiting } from '../../lib/session.jsx'
import { StringsProvider, savedLanguage, useStrings } from '../../lib/strings.jsx'
import { Brand } from '../../ui/Brand.jsx'
import { QuickExit } from '../../ui/QuickExit.jsx'

// One login for everyone. Girls: phone + PIN (an SMS code the first time, or after a forgotten PIN).
// Staff: login + password, then their usual second step. The server sends each to their own area.

export default function Login() {
  const [lang, setLang] = useState(savedLanguage())
  const { session } = useSession()
  if (session === undefined) return <Waiting />
  if (session) {
    if (session.role !== 'staff') return <Navigate to={homeFor(session.role)} replace />
    window.location.replace('/staff')
    return <Waiting />
  }
  return (
    <StringsProvider lang={lang}>
      <LoginScreen lang={lang} setLang={setLang} />
    </StringsProvider>
  )
}

function LoginScreen({ lang, setLang }) {
  const { t, ready, languages } = useStrings()
  const [who, setWho] = useState('girl')
  if (!ready) return <Waiting />
  return (
    <div className="min-h-dvh">
      <div className="flex items-center justify-center gap-3 bg-plum px-4 py-2 text-sm text-cream">
        <QuickExit label={t('web_quick_exit')} />
      </div>
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-5">
        <Brand />
        <nav aria-label={t('web_language')} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {languages.map((l) => (
            <button
              key={l.code}
              type="button"
              lang={l.code}
              onClick={() => setLang(l.code)}
              aria-current={l.code === (lang || 'en') ? 'true' : undefined}
              className={`min-h-8 ${l.code === (lang || 'en') ? 'font-bold text-plum' : 'text-muted hover:text-plum'}`}
            >
              {l.name}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto grid max-w-5xl items-start gap-10 px-6 pt-4 pb-20 md:grid-cols-[1.05fr_1fr] md:pt-10">
        <section className="hidden md:block">
          <p className="eyebrow mb-4">Ubah · ubax</p>
          <h1 className="mb-5 text-[56px] leading-[1.05]">
            {t('web_welcome').split(' ').slice(0, -2).join(' ')} <em>{t('web_welcome').split(' ').slice(-2).join(' ')}</em>
          </h1>
          <div className="mt-10 flex h-64 items-center justify-center rounded-[28px] bg-lavender">
            <img src="/assets/rose.png" alt="" className="h-40 w-auto" />
          </div>
        </section>

        <section className="rounded-[28px] bg-white p-7 ring-1 ring-hair sm:p-9">
          <h1 className="mb-6 text-[40px] leading-tight md:hidden">{t('web_welcome')}</h1>
          {who === 'girl' ? <GirlLogin lang={lang} setLang={setLang} /> : <StaffLogin />}
          <div className="mt-8 border-t border-hair pt-5 text-center">
            <button type="button" className="text-[15px] font-medium text-accent underline underline-offset-4 hover:text-plum" onClick={() => setWho(who === 'girl' ? 'staff' : 'girl')}>
              {who === 'girl' ? t('web_staff') : t('web_back')}
            </button>
          </div>
        </section>
      </main>
    </div>
  )
}

function Alert({ children }) {
  if (!children) return null
  return (
    <p role="alert" className="mb-4 rounded-2xl bg-blush px-4 py-3 text-[15px] text-rose-ink">
      {children}
    </p>
  )
}

function useFinish() {
  const { refresh } = useSession()
  const navigate = useNavigate()
  return async (result) => {
    if (result.redirect) return window.location.assign(result.redirect)
    if (result.role === 'staff') return window.location.assign('/staff')
    await refresh()
    navigate(result.home || homeFor(result.role), { replace: true })
  }
}

function GirlLogin({ lang, setLang }) {
  const { t, languages } = useStrings()
  const finish = useFinish()
  const [step, setStep] = useState('pin') // pin | ask-code | code
  const [phone, setPhone] = useState('')
  const [pin, setPin] = useState('')
  const [code, setCode] = useState('')
  const [newPin, setNewPin] = useState('')
  const [ageBand, setAgeBand] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const message = (e) =>
    ({ wrong: t('web_wrong'), bad_code: t('web_wrong'), locked: t('web_locked'), wait: t('web_wait'), phone: t('web_phone_invalid'), pin_too_easy: t('web_pin_easy'), pin_format: t('web_new_pin_hint') })[e?.code] || t('web_error')

  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(message(e))
      if (e?.code === 'locked') setStep('ask-code')
    } finally {
      setBusy(false)
    }
  }

  const phoneField = (
    <label className="mb-4 block">
      <span className="label">{t('web_phone')}</span>
      <input className="field text-lg" type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="07…" />
    </label>
  )

  if (step === 'pin')
    return (
      <form onSubmit={(e) => (e.preventDefault(), run(async () => finish(await api.post('/auth/girl/pin', { phone, pin }))))}>
        <Alert>{error}</Alert>
        {phoneField}
        <label className="mb-6 block">
          <span className="label">{t('web_pin')}</span>
          <input className="field text-center text-2xl tracking-[0.5em]" type="password" inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4}" maxLength={4} required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
        </label>
        <button className="btn w-full" disabled={busy}>
          {t('web_sign_in')}
        </button>
        <p className="mt-5 text-center text-[15px]">
          <button type="button" className="font-medium text-accent underline underline-offset-4" onClick={() => (setError(''), setStep('ask-code'))}>
            {t('web_first_time')}
          </button>
        </p>
      </form>
    )

  if (step === 'ask-code')
    return (
      <form
        onSubmit={(e) => (
          e.preventDefault(),
          run(async () => {
            await api.post('/auth/girl/code', { phone })
            setStep('code')
          })
        )}
      >
        <Alert>{error}</Alert>
        <p className="mb-4 text-text">{t('web_first_time')}</p>
        {phoneField}
        <button className="btn w-full" disabled={busy}>
          {t('web_get_code')}
        </button>
        <p className="mt-5 text-center">
          <button type="button" className="btn-quiet" onClick={() => (setError(''), setStep('pin'))}>
            {t('web_back')}
          </button>
        </p>
      </form>
    )

  return (
    <form onSubmit={(e) => (e.preventDefault(), run(async () => finish(await api.post('/auth/girl/verify', { phone, code, pin: newPin, language: lang || 'en', ...(ageBand ? { ageBand } : {}) }))))}>
      <Alert>{error}</Alert>
      <p className="mb-5 rounded-2xl bg-lavender px-4 py-3 text-[15px] text-plum">{t('web_code_sent')}</p>
      <label className="mb-4 block">
        <span className="label">{t('web_code')}</span>
        <input className="field text-center text-2xl tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <label className="mb-1.5 block">
        <span className="label">{t('web_new_pin')}</span>
        <input className="field text-center text-2xl tracking-[0.5em]" type="password" inputMode="numeric" autoComplete="new-password" pattern="[0-9]{4}" maxLength={4} required value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))} />
      </label>
      <p className="mb-5 text-[14px] text-muted">{t('web_new_pin_hint')}</p>
      <fieldset className="mb-5">
        <legend className="label">{t('web_age_q')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {['under_15', '15_17', '18_plus', 'not_said'].map((band) => (
            <button
              key={band}
              type="button"
              onClick={() => setAgeBand(ageBand === band ? '' : band)}
              aria-pressed={ageBand === band}
              className={`min-h-11 rounded-2xl border px-3 text-[15px] ${ageBand === band ? 'border-accent bg-lavender font-medium text-plum' : 'border-line bg-white text-text hover:border-accent'}`}
            >
              {t(`web_age_${band}`)}
            </button>
          ))}
        </div>
      </fieldset>
      <p className="mb-5 rounded-2xl bg-blush px-4 py-3 text-[15px] text-rose-ink">{t('web_confidential')}</p>
      <fieldset className="mb-6">
        <legend className="label">{t('web_choose_language')}</legend>
        <div className="grid grid-cols-2 gap-2">
          {languages.map((l) => (
            <button
              key={l.code}
              type="button"
              lang={l.code}
              onClick={() => setLang(l.code)}
              aria-pressed={(lang || 'en') === l.code}
              className={`min-h-12 rounded-2xl border px-3 text-[16px] ${(lang || 'en') === l.code ? 'border-accent bg-lavender font-medium text-plum' : 'border-line bg-white text-text hover:border-accent'}`}
            >
              {l.name}
            </button>
          ))}
        </div>
      </fieldset>
      <button className="btn w-full" disabled={busy}>
        {t('web_continue')}
      </button>
    </form>
  )
}

// Staff pages are in English (the team works in English).
function StaffLogin() {
  const finish = useFinish()
  const [step, setStep] = useState({ name: 'password' })
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(fn) {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(
        { wrong: "That didn't work. Check and try again.", locked: 'Too many tries: the account is locked for a while.', no_phone: 'Your account has no phone number for login codes. Ask an admin to add it.' }[e?.code] ||
          'Something went wrong. Please try again.',
      )
      if (e?.code === 'locked') setStep({ name: 'password' })
    } finally {
      setBusy(false)
    }
  }

  if (step.name === 'password')
    return (
      <form
        onSubmit={(e) => (
          e.preventDefault(),
          run(async () => {
            const r = await api.post('/auth/staff', { login, password })
            if (r.step === 'code') setStep({ name: 'code', method: r.method })
            else await finish(r)
          })
        )}
      >
        <h2 className="mb-5 text-[30px] leading-tight">
          Staff <em>login</em>
        </h2>
        <Alert>{error}</Alert>
        <label className="mb-4 block">
          <span className="label">Login</span>
          <input className="field" autoComplete="username" autoCapitalize="none" required value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label className="mb-6 block">
          <span className="label">Password</span>
          <input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button className="btn w-full" disabled={busy}>
          Continue
        </button>
      </form>
    )

  return (
    <form onSubmit={(e) => (e.preventDefault(), run(async () => finish(await api.post('/auth/staff/code', { code }))))}>
      <h2 className="mb-2 text-[30px] leading-tight">
        Enter <em>your code</em>
      </h2>
      <p className="mb-5 text-[15px] text-muted">{step.method === 'sms' ? 'We sent a 6-digit code by SMS to your phone.' : 'Open your authenticator app and type the 6-digit code for Ubah.'}</p>
      <Alert>{error}</Alert>
      <input className="field mb-6 text-center text-2xl tracking-[0.4em]" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required value={code} onChange={(e) => setCode(e.target.value)} aria-label="Code" />
      <button className="btn w-full" disabled={busy}>
        Sign in
      </button>
      {step.method === 'sms' && (
        <p className="mt-4 text-center">
          <button type="button" className="btn-quiet" onClick={() => run(() => api.post('/auth/staff/code/resend'))}>
            Send a new code
          </button>
        </p>
      )}
    </form>
  )
}
