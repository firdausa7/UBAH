import { NavLink, useNavigate } from 'react-router'
import { useSession } from '../lib/session.jsx'
import { Brand } from './Brand.jsx'

// The frame for workers' and admins' screens. Staff work in English.
export function StaffShell({ area, home, links = [], children }) {
  const { session, signOut } = useSession()
  const navigate = useNavigate()
  return (
    <div className="min-h-dvh">
      <header className="bg-plum text-cream">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-3">
          <Brand to={home} light suffix={area} />
          <nav className="flex flex-wrap items-center gap-1 text-[15px]">
            {links.map((l) => (
              <NavLink key={l.to} to={l.to} end className={({ isActive }) => `rounded-full px-3 py-1.5 no-underline ${isActive ? 'bg-cream/15 text-cream' : 'text-mist hover:text-cream'}`}>
                {l.label}
              </NavLink>
            ))}
            <a href="/staff" className="rounded-full px-3 py-1.5 text-mist no-underline hover:text-cream">
              Staff tools
            </a>
            <span className="hidden px-2 text-mist sm:inline">{session?.name}</span>
            <button type="button" className="rounded-full px-3 py-1.5 text-mist hover:text-cream" onClick={async () => (await signOut(), navigate('/login', { replace: true }))}>
              Sign out
            </button>
          </nav>
        </div>
      </header>
      {children}
    </div>
  )
}

export function when(at) {
  const d = new Date(at)
  const mins = Math.round((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

export const CHANNELS = { web: 'Web', whatsapp: 'WhatsApp', sms: 'SMS', app: 'App', simulator: 'Simulator' }
