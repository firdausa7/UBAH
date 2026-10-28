import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { Navigate, useLocation } from 'react-router'
import { api, ApiError } from './api.js'
import { forgetEverything, isRememberedGirl, rememberGirl } from './offline.js'

// Who is signed in, as the server says. The guards below are only for comfort:
// every /api/me, /api/worker and /api/admin call is checked on the server.

const SessionContext = createContext(null)

export function SessionProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined: still asking; null: nobody
  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/auth/session')
      if (s.role === 'girl') rememberGirl()
      setSession(s)
    } catch (e) {
      // No connection (not "signed out"): a girl on this phone can still open what works offline.
      setSession(!(e instanceof ApiError) && isRememberedGirl() ? { role: 'girl', offline: true } : null)
    }
  }, [])
  useEffect(() => {
    refresh()
  }, [refresh])
  const signOut = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {})
    forgetEverything()
    setSession(null)
  }, [])
  return <SessionContext.Provider value={{ session, refresh, signOut }}>{children}</SessionContext.Provider>
}

export const useSession = () => useContext(SessionContext)

export const homeFor = (role) => ({ girl: '/me', health_worker: '/worker', admin: '/admin', staff: '/staff' })[role] || '/login'

export function RequireRole({ role, children }) {
  const { session } = useSession()
  const location = useLocation()
  if (session === undefined) return <Waiting />
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />
  // A staff member's browser can also hold a girl's sign-in (a shared phone): her space still opens.
  if (session.role !== role && !session.also?.includes(role)) {
    if (session.role === 'staff') {
      window.location.replace('/staff')
      return <Waiting />
    }
    return <Navigate to={homeFor(session.role)} replace />
  }
  return children
}

export function Waiting() {
  return (
    <div className="flex min-h-dvh items-center justify-center" role="status" aria-live="polite">
      <img src="/assets/rose.png" alt="" className="h-12 w-auto animate-pulse" />
    </div>
  )
}
