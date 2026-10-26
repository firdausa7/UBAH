import { useEffect, useState } from 'react'
import { TOPICS } from '../data'
import { Icon, ScreenHeader, speak, stopSpeaking } from '../ui'

export default function Learn({ go, openCare }) {
  const [playing, setPlaying] = useState(null)
  useEffect(() => stopSpeaking, [])

  const toggle = (t) => {
    if (playing === t.id) {
      stopSpeaking()
      setPlaying(null)
    } else if (speak(t.answer, () => setPlaying(null))) {
      setPlaying(t.id)
    }
  }

  return (
    <>
      <ScreenHeader onBack={() => go('home')} backLabel="Back to home" title={<><em className="font-semibold">Learn</em> about my body</>} />
      <main className="flex flex-1 flex-col gap-3 px-4 pt-1 pb-6">
        {TOPICS.map((t) => (
          <article key={t.id} className="flex flex-col gap-2.5 rounded-[18px] border border-line bg-white p-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="m-0 text-lg font-bold">{t.label}</h2>
              <button
                type="button"
                onClick={() => toggle(t)}
                aria-label={playing === t.id ? `Stop ${t.label}` : `Listen to ${t.label}`}
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-sand hover:bg-line"
              >
                {playing === t.id ? <Icon.Stop className="size-4" /> : <Icon.Play className="size-[18px]" />}
              </button>
            </div>
            {t.answer.map((l, i) => (
              <p key={i} className="m-0 text-[15px] leading-snug">{l}</p>
            ))}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted">From: {t.source}</span>
              <button type="button" onClick={() => openCare(t.services)} className="min-h-11 text-sm font-bold text-sea underline">
                Find care
              </button>
            </div>
          </article>
        ))}
      </main>
    </>
  )
}
