import { useState } from 'react'
import { QuickExit } from '../ui'

export default function Lock({ pin, onUnlock }) {
  const [entry, setEntry] = useState('')
  const [wrong, setWrong] = useState(false)

  const press = (d) => {
    const next = (entry + d).slice(0, 4)
    setWrong(false)
    setEntry(next)
    if (next.length === 4) {
      if (next === pin) onUnlock()
      else {
        setWrong(true)
        setEntry('')
      }
    }
  }

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex items-center justify-between px-5 pt-5 pb-2">
        <div className="text-[28px] font-bold tracking-tight text-clay">ubah</div>
        <QuickExit />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-5 pb-10">
        <h1 className="m-0 text-2xl font-normal">Enter your <em className="font-semibold">PIN</em></h1>
        <div className="flex gap-3" aria-label={`${entry.length} of 4 digits entered`}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={`size-4 rounded-full border-2 border-ink ${i < entry.length ? 'bg-ink' : ''}`} />
          ))}
        </div>
        <p role="alert" className="m-0 h-5 text-sm text-warn">{wrong ? 'That PIN is not right. Try again.' : ''}</p>
        <div className="grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <Key key={d} onClick={() => press(d)}>{d}</Key>
          ))}
          <span />
          <Key onClick={() => press('0')}>0</Key>
          <Key onClick={() => setEntry(entry.slice(0, -1))} label="Delete">⌫</Key>
        </div>
      </main>
    </div>
  )
}

function Key({ children, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="size-[72px] rounded-full border border-line bg-white text-2xl font-bold hover:bg-sand"
    >
      {children}
    </button>
  )
}
