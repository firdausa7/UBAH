import { PASS_DAYS, clinicById } from '../data'
import { Icon, PrimaryButton, ScreenHeader } from '../ui'

export function daysLeft(pass) {
  const left = PASS_DAYS - Math.floor((Date.now() - pass.at) / 86400000)
  return Math.max(0, left)
}

export default function Pass({ pass, go }) {
  if (!pass) return null
  const clinic = clinicById(pass.clinic)

  return (
    <>
      <ScreenHeader onBack={() => go('passes')} backLabel="Back to my passes" title={<>Your <em className="font-semibold">pass</em></>} />
      <main className="flex flex-1 flex-col gap-3.5 px-4 pt-1 pb-6">
        <section aria-label="Pass" className="flex flex-col gap-3.5 rounded-[22px] bg-ink p-[22px] text-white">
          <span className="text-sm text-mist">Show this code at the desk. You will not need to explain again.</span>
          <span className="text-[52px] leading-none font-bold tracking-[4px]">{pass.code}</span>
          <dl className="m-0 grid grid-cols-2 gap-3 text-sm">
            <Field k="Clinic" v={clinic?.name} />
            <Field k="Valid for" v={`${daysLeft(pass)} more days`} />
            <Field k="Services" v={pass.services.join(', ')} />
            <Field k="Your name" v="Not shared" />
          </dl>
          <span className="text-[13px] text-mist">Works at any Ubah partner clinic.</span>
        </section>

        <div className="flex items-start gap-2.5 rounded-[14px] border border-line bg-white p-3.5">
          <Icon.Chat className="mt-0.5 size-[22px] shrink-0 text-sea" />
          <p className="m-0 text-[15px] leading-snug">Ubah will send a short message in 3 days to ask how it went. Reply STOP anytime.</p>
        </div>

        {pass.checkin ? (
          <p className="m-0 rounded-[14px] bg-ok-bg p-3.5 text-[15px] text-ok">Thank you. Your answers were saved without your name.</p>
        ) : (
          <button
            type="button"
            onClick={() => go('checkin', pass.code)}
            className="flex min-h-12 items-center justify-center rounded-full border border-ink bg-white font-bold hover:bg-sand"
          >
            I've been to the clinic: tell Ubah how it went
          </button>
        )}

        <PrimaryButton onClick={() => go('home')}>Done</PrimaryButton>
      </main>
    </>
  )
}

function Field({ k, v }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-mist">{k}</dt>
      <dd className="m-0 font-bold">{v}</dd>
    </div>
  )
}
