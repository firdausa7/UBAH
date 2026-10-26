import { useState } from 'react'
import { langLabel } from '../data'
import { timeAgo, uid } from '../store'
import { Badge } from '../ui'

const TABS = [
  { id: 'urgent', label: 'Urgent' },
  { id: 'waiting', label: 'Waiting' },
  { id: 'done', label: 'Done' },
]

export default function Inbox({ cases, setPartner, setGirl }) {
  const [tab, setTab] = useState('urgent')
  const shown = cases.filter((c) => c.status === tab)
  const count = (id) => cases.filter((c) => c.status === id).length

  const update = (id, patch) => setPartner((p) => ({ cases: p.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)) }))

  function send(c, text) {
    // Prototype: girl and Dada share one device store, so the reply lands in her chat.
    setGirl((g) => ({ messages: [...g.messages, { id: uid(), from: 'ubah', dada: true, lines: [text] }] }))
    update(c.id, { status: 'done', reply: text, doneAt: Date.now() })
  }

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col bg-ground sm:my-6 sm:min-h-[844px] sm:overflow-hidden sm:rounded-[32px] sm:border sm:border-line">
      <header className="flex flex-col gap-3 border-b border-line bg-white px-4 pt-5 pb-3">
        <div className="flex items-center justify-between">
          <div className="flex flex-col">
            <h1 className="m-0 text-2xl font-normal"><em className="font-semibold">Dada</em> inbox</h1>
            <span className="text-[13px] text-muted">On shift: [Dada name] · Nurse: [Nurse name]</span>
          </div>
          <Badge>Online</Badge>
        </div>
        <div role="tablist" aria-label="Cases" className="grid grid-cols-3 gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`min-h-11 rounded-[10px] text-sm ${tab === t.id ? 'bg-ink font-bold text-white' : 'border border-chip bg-white'}`}
            >
              {t.label}{t.id !== 'done' ? ` · ${count(t.id)}` : ''}
            </button>
          ))}
        </div>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-4 py-3.5">
        {shown.length === 0 && (
          <p className="m-0 rounded-[14px] bg-sand p-4 text-[15px]">
            {tab === 'done' ? 'No finished cases yet.' : 'No cases here. Danger signs and requests for a person from the girl app appear here.'}
          </p>
        )}
        {shown.map((c) => (
          <Case key={c.id} c={c} onSend={send} onDone={() => update(c.id, { status: 'done', doneAt: Date.now() })} />
        ))}
      </main>

      <p className="m-0 border-t border-line bg-white px-4 pt-3 pb-5 text-[13px] text-muted">
        The AI drafts; a Dada always decides. Urgent cases alert the nurse at once.
      </p>
    </div>
  )
}

function Case({ c, onSend, onDone }) {
  const [draft, setDraft] = useState(c.draft)
  const urgent = c.kind === 'urgent'

  return (
    <article className={`flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 ${urgent && c.status !== 'done' ? 'border-2 border-clay' : 'border border-line'}`}>
      <div className="flex items-center justify-between gap-2">
        <Badge tone={urgent ? 'warn' : 'neutral'}>{urgent ? `Danger sign: ${c.sign.toLowerCase()}` : c.sign}</Badge>
        <span className="text-[13px] text-muted">{timeAgo(c.at)}</span>
      </div>
      <span className="text-[13px] text-muted">Girl #{c.girl} · {langLabel(c.lang)} · {c.channel}</span>
      <p className="m-0 text-[15px] leading-snug">"{c.summary}"</p>

      {c.status === 'done' ? (
        c.reply && <p className="m-0 rounded-[10px] bg-ground px-3 py-2.5 text-sm">Sent: {c.reply}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1 rounded-[10px] bg-ground px-3 py-2.5">
            <label htmlFor={`d-${c.id}`} className="text-xs font-bold text-muted">AI draft reply, check before sending</label>
            <textarea
              id={`d-${c.id}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              className="resize-y rounded-md border border-line bg-white p-2 text-sm leading-snug"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button type="button" disabled={!draft.trim()} onClick={() => onSend(c, draft.trim())} className="min-h-[46px] rounded-full bg-ink text-[15px] font-bold text-white disabled:opacity-40">
              Send
            </button>
            {urgent ? (
              <a href="tel:[NURSE NUMBER]" className="flex min-h-[46px] items-center justify-center rounded-full border border-ink text-[15px] font-bold text-ink no-underline">
                Call nurse
              </a>
            ) : (
              <button type="button" onClick={onDone} className="min-h-[46px] rounded-full border border-ink bg-white text-[15px] font-bold">
                Mark done
              </button>
            )}
          </div>
        </>
      )}
    </article>
  )
}
