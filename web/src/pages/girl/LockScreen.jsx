import { useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../lib/api.js'
import { useSession, Waiting } from '../../lib/session.jsx'
import { useStrings } from '../../lib/strings.jsx'
import { Brand } from '../../ui/Brand.jsx'
import { QuickExit } from '../../ui/QuickExit.jsx'

// Ubah locked itself after a while unused (phones are shared). Nothing of hers is on this screen.
export default function LockScreen({ onUnlocked }) {
  const { t, ready } = useStrings()
  const { signOut } = useSession()
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!ready) return <Waiting />

  async function unlock(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.post('/auth/girl/unlock', { pin })
      setPin('')
      onUnlocked()
    } catch (err) {
      if (err.code === 'locked' || err.code === 'not_signed_in') {
        await signOut()
        return navigate('/login', { replace: true })
      }
      setError(err.code === 'wrong' ? t('app_pin_wrong') : t('web_error'))
      setPin('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col px-4">
      <header className="flex items-center justify-between py-3">
        <Brand to="/me" />
        <QuickExit label={t('web_quick_exit')} />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center pb-24 text-center">
        <img src="/assets/rose.png" alt="" className="mb-6 h-16 w-auto" />
        <form onSubmit={unlock} className="w-full max-w-xs">
          <label htmlFor="pin" className="mb-3 block font-serif text-[30px] font-semibold text-plum">
            {t('app_pin_enter')}
          </label>
          {error && (
            <p role="alert" className="mb-3 rounded-2xl bg-blush px-4 py-2 text-[15px] text-rose-ink">
              {error}
            </p>
          )}
          <input id="pin" className="field mb-4 text-center text-3xl tracking-[0.6em]" type="password" inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4}" maxLength={4} required autoFocus value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          <button className="btn w-full" disabled={busy || pin.length !== 4}>
            {t('web_continue')}
          </button>
        </form>
        <button type="button" className="mt-6 text-[15px] font-medium text-accent underline underline-offset-4" onClick={async () => (await signOut(), navigate('/login', { replace: true }))}>
          {t('web_first_time')}
        </button>
      </main>
    </div>
  )
}
