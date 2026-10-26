import { clinicById } from '../data'
import { Badge, Icon, ScreenHeader } from '../ui'
import { daysLeft } from './Pass'

export default function Passes({ passes, go }) {
  return (
    <>
      <ScreenHeader onBack={() => go('home')} backLabel="Back to home" title={<>My <em className="font-semibold">passes</em></>} />
      <main className="flex flex-1 flex-col gap-3 px-4 pt-1 pb-6">
        {passes.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-[18px] border border-line bg-white p-5">
            <Icon.Ticket className="size-8 text-sea" />
            <p className="m-0 text-[15px]">You have no referral passes yet. Find a clinic to get one. It never shows your name.</p>
            <button type="button" onClick={() => go('care')} className="min-h-11 rounded-full bg-clay px-5 font-bold text-white">
              Find care
            </button>
          </div>
        ) : (
          passes.map((p) => {
            const left = daysLeft(p)
            return (
              <button
                key={p.code}
                type="button"
                onClick={() => go('pass', p.code)}
                className="flex flex-col gap-2 rounded-[18px] border border-line bg-white p-4 text-left hover:border-chip"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-2xl font-bold tracking-[2px]">{p.code}</span>
                  {p.checkin ? <Badge tone="neutral">Checked in</Badge> : left > 0 ? <Badge>Valid {left} days</Badge> : <Badge tone="warn">Expired</Badge>}
                </div>
                <span className="text-sm text-muted">
                  {clinicById(p.clinic)?.name} · {p.services.join(', ')}
                </span>
              </button>
            )
          })
        )}
      </main>
    </>
  )
}
