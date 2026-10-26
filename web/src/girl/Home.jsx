import { useState } from 'react'
import { LANGS } from '../data'
import { Chip, Icon, QuickExit } from '../ui'

export default function Home({ girl, setGirl, wipeGirl, go }) {
  const [confirmWipe, setConfirmWipe] = useState(false)
  const [settingPin, setSettingPin] = useState(false)
  const [pinDraft, setPinDraft] = useState('')

  const savePin = (e) => {
    e.preventDefault()
    if (!/^\d{4}$/.test(pinDraft)) return
    setGirl(() => ({ pin: pinDraft }))
    setPinDraft('')
    setSettingPin(false)
  }

  return (
    <>
      <header className="flex items-center justify-between px-5 pt-5 pb-2">
        <div className="text-[28px] font-bold tracking-tight text-clay">ubah</div>
        <QuickExit />
      </header>

      <main className="flex flex-1 flex-col gap-[18px] px-5 pt-2 pb-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[32px] leading-[1.15] font-normal tracking-tight">
            <em className="font-semibold">Salaan.</em> What do you need today?
          </h1>
          <p className="m-0 text-base text-muted">
            Private answers about your body, your health and where to get care.
          </p>
        </div>

        <div role="group" aria-label="Language" className="flex flex-wrap gap-2">
          {LANGS.map((l) => (
            <Chip key={l.id} pressed={girl.lang === l.id} onClick={() => setGirl(() => ({ lang: l.id }))}>
              {l.label}
            </Chip>
          ))}
        </div>

        <nav aria-label="Start" className="flex flex-col gap-3">
          <button
            type="button"
            onClick={() => go('ask')}
            className="flex items-center gap-3.5 rounded-[18px] bg-clay p-[18px] text-left text-white hover:bg-clay-dark"
          >
            <Icon.Chat className="size-8 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span className="text-[19px] font-bold">Ask a private question</span>
              <span className="text-sm">Type or send a voice note</span>
            </span>
          </button>
          <HomeCard icon={Icon.Pin} title="Find care near me" sub="Verified, youth-friendly clinics" onClick={() => go('care')} />
          <HomeCard icon={Icon.Book} title="Learn about my body" sub="Short lessons you can listen to" onClick={() => go('learn')} />
        </nav>

        <section aria-label="Privacy" className="flex flex-col gap-3 rounded-[14px] bg-sand p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon.Lock className="mt-0.5 size-[22px] shrink-0" />
            <p className="m-0 text-sm leading-snug">
              No name or phone number needed.{' '}
              {girl.pin ? 'Your chats stay locked behind your PIN.' : 'Add a PIN so only you can open your chats.'}
            </p>
          </div>

          {settingPin ? (
            <form onSubmit={savePin} className="flex items-center gap-2">
              <label htmlFor="newpin" className="sr-only">New 4-digit PIN</label>
              <input
                id="newpin"
                inputMode="numeric"
                autoComplete="off"
                maxLength={4}
                value={pinDraft}
                onChange={(e) => setPinDraft(e.target.value.replace(/\D/g, ''))}
                placeholder="4 digits"
                className="h-11 w-28 rounded-full border border-chip bg-white px-4 text-base tracking-[0.3em]"
              />
              <button type="submit" disabled={pinDraft.length !== 4} className="h-11 rounded-full bg-ink px-4 text-sm font-bold text-white disabled:opacity-40">
                Save PIN
              </button>
              <button type="button" onClick={() => setSettingPin(false)} className="h-11 px-2 text-sm text-muted underline">
                Cancel
              </button>
            </form>
          ) : confirmWipe ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold">Delete all chats and passes on this phone?</span>
              <button type="button" onClick={() => { wipeGirl(); setConfirmWipe(false) }} className="h-11 rounded-full bg-ink px-4 text-sm font-bold text-white">
                Yes, wipe
              </button>
              <button type="button" onClick={() => setConfirmWipe(false)} className="h-11 px-2 text-sm text-muted underline">
                Keep
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {girl.pin ? (
                <button type="button" onClick={() => setGirl(() => ({ pin: null }))} className="h-11 rounded-full border border-chip bg-white px-4 text-sm">
                  Remove PIN
                </button>
              ) : (
                <button type="button" onClick={() => setSettingPin(true)} className="h-11 rounded-full border border-chip bg-white px-4 text-sm">
                  Set a PIN
                </button>
              )}
              <button type="button" onClick={() => setConfirmWipe(true)} className="h-11 rounded-full border border-chip bg-white px-4 text-sm">
                Wipe my history
              </button>
            </div>
          )}
        </section>

        <p className="m-0 text-sm text-muted">
          No smartphone? Text <strong>UBAH</strong> to [SHORTCODE] or dial [USSD CODE].
        </p>
      </main>
    </>
  )
}

function HomeCard({ icon: I, title, sub, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-3.5 rounded-[20px] border border-line bg-white p-[18px] text-left text-ink hover:border-chip"
    >
      <I className="size-8 shrink-0 text-sea" />
      <span className="flex flex-col gap-0.5">
        <span className="text-[19px] font-bold">{title}</span>
        <span className="text-sm text-muted">{sub}</span>
      </span>
    </button>
  )
}
