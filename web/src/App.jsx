import { useEffect, useState } from 'react'
import GirlApp from './girl/GirlApp'
import Dashboard from './staff/Dashboard'
import Inbox from './staff/Inbox'
import { useStore } from './store'

const VIEWS = [
  { hash: '#/', label: 'Girl app' },
  { hash: '#/dada', label: 'Dada inbox' },
  { hash: '#/partner', label: 'Partner dashboard' },
]

const currentHash = () => (VIEWS.some((v) => v.hash === location.hash) ? location.hash : '#/')

export default function App() {
  const store = useStore()
  const [hash, setHash] = useState(currentHash)

  useEffect(() => {
    const on = () => setHash(currentHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  return (
    <>
      <nav aria-label="Prototype views" className="flex items-center justify-center gap-1 bg-ink px-2 py-1.5 text-xs text-mist">
        <span className="mr-1 hidden sm:inline">Prototype:</span>
        {VIEWS.map((v) => (
          <a
            key={v.hash}
            href={v.hash}
            aria-current={hash === v.hash ? 'page' : undefined}
            className={`rounded-full px-2.5 py-1 no-underline ${hash === v.hash ? 'bg-white font-bold text-ink' : 'text-mist hover:text-white'}`}
          >
            {v.label}
          </a>
        ))}
      </nav>
      {hash === '#/' && <GirlApp {...store} />}
      {hash === '#/dada' && <Inbox cases={store.partner.cases} setPartner={store.setPartner} setGirl={store.setGirl} />}
      {hash === '#/partner' && <Dashboard partner={store.partner} />}
    </>
  )
}
