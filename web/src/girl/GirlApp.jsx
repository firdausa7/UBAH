import { useState } from 'react'
import { newPassCode } from '../data'
import { Icon } from '../ui'
import Ask from './Ask'
import Care from './Care'
import Checkin from './Checkin'
import Home from './Home'
import Learn from './Learn'
import Lock from './Lock'
import Pass from './Pass'
import Passes from './Passes'

const TABS = [
  { id: 'home', label: 'Home', icon: Icon.Home },
  { id: 'ask', label: 'Ask', icon: Icon.Chat },
  { id: 'care', label: 'Care', icon: Icon.Pin },
  { id: 'passes', label: 'My passes', icon: Icon.Ticket },
]

export default function GirlApp({ girl, setGirl, setPartner, wipeGirl }) {
  const [unlocked, setUnlocked] = useState(false)
  const [screen, setScreen] = useState({ name: 'home' })
  const [services, setServices] = useState([])

  const go = (name, code) => {
    setScreen({ name, code })
    window.scrollTo(0, 0)
  }
  const openCare = (svc) => {
    setServices(svc)
    go('care')
  }

  function issuePass(clinic, svc) {
    const code = newPassCode()
    const pass = { code, clinic, services: svc, at: Date.now() }
    setGirl((g) => ({ passes: [pass, ...g.passes] }))
    setPartner((p) => ({ referrals: [...p.referrals, { ...pass }] }))
    go('pass', code)
  }

  function saveCheckin(code, answers) {
    setGirl((g) => ({ passes: g.passes.map((p) => (p.code === code ? { ...p, checkin: answers } : p)) }))
    setPartner((p) => ({ referrals: p.referrals.map((r) => (r.code === code ? { ...r, checkin: answers } : r)) }))
    go('pass', code)
  }

  if (girl.pin && !unlocked) {
    return (
      <Frame>
        <Lock pin={girl.pin} onUnlock={() => setUnlocked(true)} />
      </Frame>
    )
  }

  const pass = girl.passes.find((p) => p.code === screen.code)
  const props = { girl, setGirl, setPartner, go, openCare }
  const tab = { pass: 'passes', checkin: 'passes', learn: 'home' }[screen.name] ?? screen.name

  return (
    <Frame>
      {screen.name === 'home' && <Home {...props} wipeGirl={wipeGirl} />}
      {screen.name === 'ask' && <Ask {...props} />}
      {screen.name === 'learn' && <Learn {...props} />}
      {screen.name === 'care' && <Care services={services} setServices={setServices} go={go} issuePass={issuePass} />}
      {screen.name === 'passes' && <Passes passes={girl.passes} go={go} />}
      {screen.name === 'pass' && <Pass pass={pass} go={go} />}
      {screen.name === 'checkin' && <Checkin pass={pass} go={go} save={saveCheckin} />}

      {screen.name !== 'ask' && (
        <nav aria-label="Main" className="sticky bottom-0 grid grid-cols-4 border-t border-line bg-white pt-2 pb-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => go(t.id)}
              aria-current={tab === t.id ? 'page' : undefined}
              className={`flex min-h-11 flex-col items-center justify-center gap-1 text-[13px] ${tab === t.id ? 'font-bold text-ink' : 'text-muted'}`}
            >
              <t.icon className="size-[22px]" />
              {t.label}
            </button>
          ))}
        </nav>
      )}
    </Frame>
  )
}

function Frame({ children }) {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-ground sm:my-6 sm:min-h-[844px] sm:overflow-hidden sm:rounded-[32px] sm:border sm:border-line sm:shadow-[0_20px_60px_-20px_rgba(21,29,44,0.25)]">
      {children}
    </div>
  )
}
