import { useCallback, useEffect, useState } from 'react'
import { Route, Routes } from 'react-router'
import { api } from '../../lib/api.js'
import { CHANNELS, StaffShell, when } from '../../ui/StaffShell.jsx'

// Assign each girl to one health worker. Admins never see her messages.
export default function AdminApp() {
  return (
    <StaffShell
      area="Admin"
      home="/admin"
      links={[
        { to: '/admin', label: 'Assignments' },
        { to: '/admin/templates', label: 'Answer templates' },
      ]}
    >
      <Routes>
        <Route index element={<Assignments />} />
        <Route path="templates" element={<Templates />} />
      </Routes>
    </StaffShell>
  )
}

function Assignments() {
  const [girls, setGirls] = useState(null)
  const [workers, setWorkers] = useState([])
  const [filter, setFilter] = useState('all')
  const [note, setNote] = useState('')
  const [confirmAuto, setConfirmAuto] = useState(false)
  const load = useCallback(() => Promise.all([api.get('/admin/girls'), api.get('/admin/workers')]).then(([g, w]) => (setGirls(g.girls), setWorkers(w.workers))), [])
  useEffect(() => {
    load()
  }, [load])

  async function assign(girl, workerId) {
    if (workerId) await api.put(`/admin/girls/${girl.id}/assignment`, { workerId: Number(workerId) })
    else await api.del(`/admin/girls/${girl.id}/assignment`)
    setNote(`Girl ${girl.anonId}: ${workerId ? `assigned to ${workers.find((w) => w.id === Number(workerId))?.name}` : 'unassigned'}`)
    load()
  }

  const shown = (girls ?? []).filter((g) => filter === 'all' || (filter === 'none' ? !g.worker : true))
  const unassigned = (girls ?? []).filter((g) => !g.worker).length
  const LANG = { so: 'Soomaali', sw: 'Kiswahili', om: 'Afaan Oromoo', en: 'English' }

  async function assignByLanguage() {
    setConfirmAuto(false)
    const r = await api.post('/admin/assign-unassigned')
    const missing = Object.entries(r.noWorker)
      .map(([l, n]) => `${LANG[l] ?? l} (${n})`)
      .join(', ')
    setNote(`Assigned ${r.assigned} girl${r.assigned === 1 ? '' : 's'} by language.${missing ? ` No health worker speaks: ${missing}. Add the language to a worker in Staff tools → Admin, or assign them by hand.` : ''}`)
    load()
  }
  return (
    <main className="mx-auto grid max-w-7xl gap-6 px-5 py-6 lg:grid-cols-[1fr_320px]">
      <section>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h1 className="text-[40px] leading-none">
            Who looks after <em>whom</em>
          </h1>
          <div className="flex rounded-full bg-white p-1 ring-1 ring-hair" role="group" aria-label="Show">
            {[
              ['all', 'All girls'],
              ['none', 'Not assigned'],
            ].map(([v, l]) => (
              <button key={v} type="button" aria-pressed={filter === v} onClick={() => setFilter(v)} className={`rounded-full px-3 py-1 text-[14px] ${filter === v ? 'bg-plum text-cream' : 'text-text hover:bg-soft'}`}>
                {l}
              </button>
            ))}
          </div>
        </div>
        {unassigned > 0 && (
          <div className="mb-4 rounded-[24px] bg-blush p-5">
            <p className="mb-3 text-rose-ink">
              <strong className="font-medium">
                {unassigned} girl{unassigned === 1 ? ' has' : 's have'} no health worker yet.
              </strong>{' '}
              Their everyday messages wait until someone is assigned; urgent ones always reach the nurses.
            </p>
            {confirmAuto ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] text-plum">Give each to a nurse or Dada who speaks her language, whoever has the fewest girls?</span>
                <button type="button" className="btn" onClick={assignByLanguage}>
                  Yes, assign them
                </button>
                <button type="button" className="btn-ghost" onClick={() => setConfirmAuto(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="btn" onClick={() => setConfirmAuto(true)}>
                Assign them by language
              </button>
            )}
          </div>
        )}
        {note && (
          <p role="status" className="mb-3 rounded-2xl bg-lavender px-4 py-2 text-[15px]">
            {note}
          </p>
        )}
        {girls === null ? (
          <p className="text-muted">Loading…</p>
        ) : (
          <div className="overflow-x-auto rounded-[28px] bg-white ring-1 ring-hair">
            <table className="w-full min-w-[560px] text-left text-[15px]">
              <thead className="text-[13px] tracking-wider text-muted uppercase">
                <tr className="border-b border-hair">
                  <th className="px-5 py-3 font-medium">Girl</th>
                  <th className="px-3 py-3 font-medium">Language</th>
                  <th className="px-3 py-3 font-medium">Channel</th>
                  <th className="px-3 py-3 font-medium">Joined</th>
                  <th className="px-5 py-3 font-medium">Health worker</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((g) => (
                  <tr key={g.id} className="border-b border-hair last:border-0">
                    <td className="px-5 py-3 font-medium text-plum">{g.anonId}</td>
                    <td className="px-3 py-3">{g.languageLabel}</td>
                    <td className="px-3 py-3">{CHANNELS[g.channel] ?? g.channel}</td>
                    <td className="px-3 py-3 text-muted">{when(g.createdAt)}</td>
                    <td className="px-5 py-2">
                      <select aria-label={`Health worker for girl ${g.anonId}`} className={`field py-2 text-[15px] ${g.worker ? '' : 'border-rose bg-blush'}`} value={g.worker?.id ?? ''} onChange={(e) => assign(g, e.target.value)}>
                        <option value="">Not assigned</option>
                        {workers.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name} ({w.role === 'nurse' ? 'Nurse' : 'Dada'})
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {shown.length === 0 && <p className="p-6 text-text">No girls here.</p>}
          </div>
        )}
      </section>

      <aside className="rounded-[28px] bg-lavender p-6 self-start">
        <h2 className="mb-3 text-[28px] leading-tight">Health workers</h2>
        <ul className="flex flex-col gap-2">
          {workers.map((w) => (
            <li key={w.id} className="flex items-center justify-between rounded-2xl bg-white px-4 py-3">
              <span>
                <span className="block font-medium text-plum">{w.name}</span>
                <span className="text-[13px] text-muted">
                  {w.role === 'nurse' ? 'Nurse' : 'Dada'}
                  {w.languages.length ? ` · ${w.languages.join(', ')}` : ''}
                </span>
              </span>
              <span className="font-serif text-[26px] font-semibold text-accent" aria-label={`${w.girls} girls`}>
                {w.girls}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[14px] text-text">Urgent messages also alert every nurse, so no girl waits for one person.</p>
      </aside>
    </main>
  )
}

function Templates() {
  const [items, setItems] = useState(null)
  const [language, setLanguage] = useState('so')
  const [english, setEnglish] = useState('')
  const [note, setNote] = useState('')
  const load = useCallback(() => api.get('/admin/templates').then((d) => setItems(d.templates)), [])
  useEffect(() => {
    load()
  }, [load])

  async function add(e) {
    e.preventDefault()
    try {
      await api.post('/admin/templates', { language, english })
      setEnglish('')
      setNote('Added. A native speaker adds the translation through the CSV export and import; until then it is not used.')
      load()
    } catch (err) {
      setNote(err.code === 'exists' ? 'That answer is already a template for this language.' : 'Not added. Please try again.')
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-5 py-6">
      <h1 className="mb-2 text-[40px] leading-none">
        Answer <em>templates</em>
      </h1>
      <p className="mb-6 max-w-2xl text-text">Answers workers often write. When a native speaker has checked the translation, girls receive that checked wording instead of a machine translation.</p>
      <form onSubmit={add} className="mb-6 flex flex-wrap items-end gap-3 rounded-[28px] bg-white p-5 ring-1 ring-hair">
        <label>
          <span className="label">Language</span>
          <select className="field py-2.5" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="so">Soomaali</option>
            <option value="sw">Kiswahili</option>
            <option value="om">Afaan Oromoo</option>
          </select>
        </label>
        <label className="min-w-64 flex-1">
          <span className="label">English answer</span>
          <input className="field" required maxLength={1600} value={english} onChange={(e) => setEnglish(e.target.value)} />
        </label>
        <button className="btn">Add</button>
      </form>
      {note && (
        <p role="status" className="mb-4 rounded-2xl bg-lavender px-4 py-2 text-[15px]">
          {note}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {(items ?? []).map((t) => (
          <li key={t.id} className="rounded-3xl bg-white p-4 ring-1 ring-hair">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-[13px]">
              <span className="tag bg-soft text-plum">{t.language}</span>
              {t.reviewedBy ? <span className="tag bg-lavender text-plum">Checked by {t.reviewedBy}</span> : <span className="tag bg-blush text-rose-ink">Waiting for a native speaker</span>}
            </div>
            <p className="text-plum">{t.english}</p>
            {t.translated && <p className="text-[15px] text-text">{t.translated}</p>}
          </li>
        ))}
        {items?.length === 0 && <li className="text-text">No templates yet.</li>}
      </ul>
    </main>
  )
}
