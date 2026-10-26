import { CLINICS, TOPICS } from '../data'

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')

export default function Dashboard({ partner }) {
  const { questions, referrals, cases } = partner
  const checked = referrals.filter((r) => r.checkin)
  const visited = checked.filter((r) => r.checkin.visited === 'yes')
  const urgent = cases.filter((c) => c.kind === 'urgent')
  const answered = urgent.filter((c) => c.doneAt)
  const median = (() => {
    const mins = answered.map((c) => (c.doneAt - c.at) / 60000).sort((a, b) => a - b)
    if (!mins.length) return null
    return Math.round(mins[Math.floor(mins.length / 2)])
  })()

  const topicRows = [...TOPICS.map((t) => ({ id: t.id, label: t.label })), { id: 'danger', label: 'Danger signs' }, { id: 'unknown', label: 'Not covered yet' }]
    .map((t) => ({ ...t, n: questions.filter((q) => q.topic === t.id).length }))
    .sort((a, b) => b.n - a.n)
  const maxTopic = Math.max(1, ...topicRows.map((t) => t.n))

  const clinicRows = CLINICS.map((c) => {
    const rs = referrals.filter((r) => r.clinic === c.id)
    const vis = rs.filter((r) => r.checkin?.visited === 'yes')
    return {
      ...c,
      passes: rs.length,
      checkins: rs.filter((r) => r.checkin).length,
      visited: vis.length,
      respect: vis.filter((r) => r.checkin.respect === 'yes').length,
      served: vis.filter((r) => r.checkin.served === 'yes').length,
    }
  })

  return (
    <div className="min-h-dvh bg-ground px-4 py-8 sm:px-6">
      <div className="mx-auto flex max-w-[1200px] flex-col gap-5">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-lg font-bold text-clay">ubah</span>
            <h1 className="m-0 text-[34px] font-normal tracking-tight sm:text-[40px]"><em className="font-semibold">Partner</em> dashboard</h1>
            <span className="text-[15px] text-muted">[PILOT SITE] · all data anonymous</span>
          </div>
          <button
            type="button"
            onClick={() => download(partner)}
            className="min-h-11 rounded-full bg-ink px-4 text-[15px] font-bold text-white"
          >
            Download data (JSON)
          </button>
        </header>

        <p className="m-0 rounded-[10px] bg-sand px-3.5 py-2.5 text-sm">
          Prototype: figures come only from use of the girl app on this device. Nothing is estimated in advance.
        </p>

        <section aria-label="Key numbers" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Questions answered" value={questions.length} sub={`${questions.filter((q) => q.topic === 'unknown').length} answered "I don't know"`} />
          <Stat label="Referral passes issued" value={referrals.length} sub={`across ${new Set(referrals.map((r) => r.clinic)).size} clinics`} />
          <Stat highlight label="Visits confirmed" value={checked.length ? pct(visited.length, referrals.length) : '—'} sub={`of passes, from ${checked.length} check-ins`} />
          <Stat label="Urgent handoffs" value={urgent.length} sub={median === null ? 'no replies yet' : `median reply ${median} min`} />
        </section>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_360px]">
          <section className="flex min-w-0 flex-col gap-3.5 rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 text-[19px] font-bold">Clinic dignity scores</h2>
              <span className="text-sm text-muted">From girls' anonymous check-ins after each referral</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-[15px]">
                <thead>
                  <tr className="text-left text-[13px] text-muted">
                    {['Clinic', 'Passes', 'Visits confirmed', 'Got the care needed', 'Treated with respect'].map((h) => (
                      <th key={h} className="border-b border-line px-2 py-2.5 font-normal">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {clinicRows.map((c) => (
                    <tr key={c.id} className="border-b border-sand last:border-0">
                      <td className="px-2 py-3 font-bold">{c.name}</td>
                      <td className="px-2 py-3 tabular-nums">{c.passes}</td>
                      <td className="px-2 py-3 tabular-nums">{c.checkins ? pct(c.visited, c.passes) : '—'}</td>
                      <td className="px-2 py-3 tabular-nums">{pct(c.served, c.visited)}</td>
                      <td className="px-2 py-3 tabular-nums">
                        <span className={c.visited && c.respect / c.visited < 0.7 ? 'font-bold text-warn' : ''}>{pct(c.respect, c.visited)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="m-0 text-[13px] text-muted">Below 70% respect is flagged. Share scores privately with each clinic first.</p>
          </section>

          <section className="flex flex-col gap-3.5 rounded-2xl border border-line bg-white p-5">
            <div className="flex flex-col gap-0.5">
              <h2 className="m-0 text-[19px] font-bold">What girls ask about</h2>
              <span className="text-sm text-muted">Questions by topic</span>
            </div>
            <ul className="m-0 flex list-none flex-col gap-3 p-0 text-[15px]">
              {topicRows.map((t) => (
                <li key={t.id} className="flex flex-col gap-1">
                  <div className="flex justify-between">
                    <span>{t.label}</span>
                    <span className="text-muted tabular-nums">{t.n} · {pct(t.n, questions.length)}</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-[#E3E8EE]">
                    <div className={`h-full rounded-full ${t.id === 'danger' ? 'bg-clay' : 'bg-sea'}`} style={{ width: `${(t.n / maxTopic) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="flex flex-wrap items-center gap-5 rounded-2xl border border-line bg-white p-5">
          <div className="flex flex-[1_1_280px] flex-col gap-0.5">
            <h2 className="m-0 text-[19px] font-bold">AI answer quality</h2>
            <span className="text-sm text-muted">Health workers review a weekly sample of answers</span>
          </div>
          <Mini label="Answers reviewed" value="[N]" />
          <Mini label="Rated accurate and safe" value="[X]%" />
          <Mini label={'"I don\'t know" answers'} value={questions.filter((q) => q.topic === 'unknown').length} />
        </section>
      </div>
    </div>
  )
}

function Stat({ label, value, sub, highlight }) {
  return (
    <div className={`flex flex-col gap-1.5 rounded-2xl bg-white p-[18px] ${highlight ? 'border-2 border-clay' : 'border border-line'}`}>
      <span className="text-sm text-muted">{label}</span>
      <span className="text-[38px] leading-tight tabular-nums">{value}</span>
      <span className="text-[13px] text-muted">{sub}</span>
    </div>
  )
}

function Mini({ label, value }) {
  return (
    <div className="flex flex-[1_1_160px] flex-col">
      <span className="text-[13px] text-muted">{label}</span>
      <span className="text-[22px] font-bold tabular-nums">{value}</span>
    </div>
  )
}

function download(partner) {
  const blob = new Blob([JSON.stringify(partner, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `ubah-partner-data-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}
