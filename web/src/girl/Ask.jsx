import { useEffect, useRef, useState } from 'react'
import { DONT_KNOW, SUGGESTIONS, detectDanger, langLabel, matchTopic } from '../data'
import { anonId, uid } from '../store'
import { Icon, ScreenHeader, speak, stopSpeaking } from '../ui'

const WELCOME = {
  id: 'welcome',
  from: 'ubah',
  lines: [
    'Welcome. Your name is not saved.',
    'Ask me anything about periods, pregnancy, family planning, infections or staying safe.',
  ],
}

export default function Ask({ girl, setGirl, setPartner, go, openCare }) {
  const [text, setText] = useState('')
  const [playing, setPlaying] = useState(null)
  const [note, setNote] = useState(null)
  const endRef = useRef(null)
  const messages = girl.messages.length ? girl.messages : [WELCOME]

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  useEffect(() => stopSpeaking, [])

  function openCase({ kind, sign, question }) {
    const id = girl.caseId ?? anonId()
    setPartner((p) => ({
      cases: [
        {
          id: uid(),
          girl: id,
          kind,
          sign,
          lang: girl.lang,
          channel: 'text',
          summary: question,
          draft:
            kind === 'urgent'
              ? 'Please go to [Health post name] now. Show your Ubah pass at the desk. Can someone go with you?'
              : 'Hello, I am a Dada from Ubah. I read your question. How can I help?',
          status: kind === 'urgent' ? 'urgent' : 'waiting',
          at: Date.now(),
        },
        ...p.cases,
      ],
    }))
    return id
  }

  function ask(raw) {
    const q = raw.trim()
    if (!q) return
    setText('')
    const danger = detectDanger(q)
    const topic = danger ? null : matchTopic(q)
    const now = Date.now()

    let reply
    let caseId = girl.caseId
    if (danger) {
      caseId = openCase({ kind: 'urgent', sign: danger.sign, question: q })
      reply = {
        id: uid(),
        from: 'ubah',
        urgent: true,
        lines: ['This sounds urgent. I am connecting you to a Dada and a nurse now.', danger.advice],
        actions: ['care'],
        services: ['Counselling', ...(danger.sign === 'Safety concern' ? ['Safety support'] : [])],
      }
    } else if (topic) {
      if (topic.handoff) caseId = openCase({ kind: 'person', sign: topic.label, question: q })
      reply = {
        id: uid(),
        from: 'ubah',
        lines: topic.answer,
        source: topic.source,
        services: topic.services,
        actions: topic.handoff ? ['care'] : ['listen', 'care', 'dada'],
        handedOff: topic.handoff,
      }
    } else {
      reply = { id: uid(), from: 'ubah', lines: DONT_KNOW, actions: ['dada'] }
    }

    setGirl((g) => ({
      caseId,
      messages: [...(g.messages.length ? g.messages : [WELCOME]), { id: uid(), from: 'girl', text: q, at: now }, reply],
    }))
    setPartner((p) => ({
      questions: [
        ...p.questions,
        { at: now, lang: girl.lang, topic: danger ? 'danger' : topic?.id ?? 'unknown', channel: 'text', danger: !!danger },
      ],
    }))
  }

  function talkToDada(msg) {
    const lastQ = [...messages].reverse().find((m) => m.from === 'girl')?.text ?? 'Asked to talk to a person'
    const caseId = openCase({ kind: 'person', sign: 'Asked for a person', question: lastQ })
    setGirl((g) => ({
      caseId,
      messages: [
        ...g.messages.map((m) => (m.id === msg.id ? { ...m, actions: m.actions.filter((a) => a !== 'dada') } : m)),
        { id: uid(), from: 'ubah', lines: ['A Dada will reply here soon. Dadas are trained young women from your community, supported by a nurse.'] },
      ],
    }))
  }

  function toggleListen(msg) {
    if (playing === msg.id) {
      stopSpeaking()
      setPlaying(null)
      return
    }
    const ok = speak(msg.lines, () => setPlaying(null))
    setPlaying(ok ? msg.id : null)
    if (!ok) setNote('Audio is not available in this browser.')
  }

  return (
    <>
      <ScreenHeader
        onBack={() => go('home')}
        backLabel="Back to home"
        title={<><em className="font-semibold">Ask</em> Ubah</>}
        subtitle="Answers checked against WHO and MoH guidance"
        className="border-b border-line bg-white"
      />
      {girl.lang !== 'en' && (
        <p className="mx-4 mt-2.5 mb-0 rounded-[10px] bg-sand px-3 py-2 text-center text-[13px]">
          Shown in English in this prototype. Ubah will reply in {langLabel(girl.lang)}.
        </p>
      )}

      <main className="flex flex-1 flex-col gap-3 px-4 py-3.5" aria-live="polite">
        {messages.map((m) =>
          m.from === 'girl' ? (
            <div key={m.id} className="max-w-[78%] self-end rounded-[18px_18px_4px_18px] bg-ink px-3.5 py-3 text-base leading-snug text-white">
              {m.text}
            </div>
          ) : (
            <div key={m.id} className="flex w-[88%] flex-col gap-2 self-start">
              <div
                className={`flex flex-col gap-2.5 rounded-[18px_18px_18px_4px] border bg-white p-3.5 text-base leading-[1.45] ${
                  m.urgent ? 'border-2 border-clay' : m.dada ? 'border-sea' : 'border-line'
                }`}
              >
                {m.dada && <span className="text-xs font-bold text-sea">Dada</span>}
                {m.lines.map((l, i) => (
                  <span key={i}>{l}</span>
                ))}
                {m.source && <span className="text-xs text-muted">From: {m.source}</span>}
                {m.handedOff && <span className="text-[13px] font-bold text-sea">A Dada has been asked to reply to you.</span>}
              </div>
              {m.actions?.includes('listen') && (
                <button
                  type="button"
                  onClick={() => toggleListen(m)}
                  className="flex items-center gap-2.5 self-start rounded-[18px] border border-line bg-white py-1.5 pr-4 pl-1.5"
                >
                  <span className="flex size-11 items-center justify-center rounded-full bg-sand">
                    {playing === m.id ? <Icon.Stop className="size-4" /> : <Icon.Play className="size-[18px]" />}
                  </span>
                  <span className="text-sm text-muted">{playing === m.id ? 'Stop' : 'Listen to this answer'}</span>
                </button>
              )}
              {m.actions?.includes('care') && (
                <button
                  type="button"
                  onClick={() => openCare(m.services ?? [])}
                  className="flex min-h-12 items-center justify-center rounded-full bg-clay font-bold text-white hover:bg-clay-dark"
                >
                  Find a clinic near me
                </button>
              )}
              {m.actions?.includes('dada') && (
                <button
                  type="button"
                  onClick={() => talkToDada(m)}
                  className="flex min-h-12 items-center justify-center rounded-full border border-ink bg-white font-bold hover:bg-sand"
                >
                  Talk to a Dada
                </button>
              )}
            </div>
          ),
        )}

        {girl.messages.length === 0 && (
          <div className="flex flex-col gap-2 pt-1">
            <span className="text-[13px] text-muted">Or start with one of these:</span>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="min-h-11 rounded-full border border-chip bg-white px-3.5 text-left text-sm hover:border-ink">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        <div ref={endRef} />
      </main>

      {note && (
        <p role="status" className="mx-4 mb-2 rounded-[10px] bg-sand px-3 py-2 text-[13px]">
          {note}{' '}
          <button type="button" className="underline" onClick={() => setNote(null)}>OK</button>
        </p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault()
          ask(text)
        }}
        className="sticky bottom-0 flex items-center gap-2 border-t border-line bg-white px-4 pt-3 pb-6"
      >
        <label htmlFor="msg" className="sr-only">Your question</label>
        <input
          id="msg"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type your question"
          autoComplete="off"
          className="h-12 min-w-0 flex-1 rounded-full border border-chip bg-ground px-4 text-base"
        />
        {text.trim() ? (
          <button type="submit" aria-label="Send" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-clay text-white">
            <Icon.Send className="size-[22px]" />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Record a voice note"
            onClick={() => setNote('Voice notes in Somali come with the WhatsApp pilot. For now, please type your question.')}
            className="flex size-12 shrink-0 items-center justify-center rounded-full bg-clay text-white"
          >
            <Icon.Mic className="size-[22px]" />
          </button>
        )}
      </form>
    </>
  )
}
