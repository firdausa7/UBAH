import { CLINICS, SERVICES } from '../data'
import { Badge, Chip, ScreenHeader } from '../ui'

export default function Care({ services, setServices, go, issuePass }) {
  const toggle = (s) => setServices(services.includes(s) ? services.filter((x) => x !== s) : [...services, s])

  const clinics = CLINICS.map((c) => ({ ...c, offers: c.services.filter((s) => services.includes(s)) }))
    .filter((c) => services.length === 0 || c.offers.length > 0)
    .sort((a, b) => b.offers.length - a.offers.length)

  return (
    <>
      <ScreenHeader onBack={() => go('home')} backLabel="Back to home" title={<><em className="font-semibold">Find</em> care</>} />

      <div className="flex flex-col gap-3 px-4">
        <p className="m-0 text-[15px] text-muted">What do you need? Pick one or more.</p>
        <div role="group" aria-label="Services" className="flex flex-wrap gap-2">
          {SERVICES.map((s) => (
            <Chip key={s} size="sm" pressed={services.includes(s)} onClick={() => toggle(s)}>
              {s}
            </Chip>
          ))}
        </div>
      </div>

      <main className="flex flex-1 flex-col gap-3 p-4">
        {clinics.length === 0 && (
          <p className="m-0 rounded-[14px] bg-sand p-4 text-[15px]">No partner clinic offers all of these yet. Try fewer services, or talk to a Dada.</p>
        )}
        {clinics.map((c, i) => (
          <article key={c.id} className="flex flex-col gap-2.5 rounded-[18px] border border-line bg-white p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex flex-col gap-0.5">
                <h2 className="m-0 text-lg font-bold">{c.name}</h2>
                <span className="text-sm text-muted">
                  {c.area} · {c.distance}
                </span>
              </div>
              <Badge>Verified</Badge>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[13px]">
              {c.tags.map((t) => (
                <span key={t} className="rounded-[10px] bg-ground px-2.5 py-1">{t}</span>
              ))}
            </div>
            {services.length > 0 && (
              <p className="m-0 text-[13px] text-muted">
                Offers: <span className="text-ink">{c.offers.join(', ')}</span>
              </p>
            )}
            <button
              type="button"
              disabled={services.length === 0}
              onClick={() => issuePass(c.id, c.offers)}
              className={`flex min-h-12 items-center justify-center rounded-full text-base font-bold disabled:opacity-40 ${
                i === 0 ? 'bg-clay text-white hover:bg-clay-dark' : 'border border-ink text-ink hover:bg-sand'
              }`}
            >
              {services.length === 0 ? 'Pick a service first' : 'Get my referral pass'}
            </button>
          </article>
        ))}
        <p className="m-0 text-[13px] text-muted">Clinics are checked by community health workers and rated by girls who visited.</p>
      </main>
    </>
  )
}
