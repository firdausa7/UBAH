import { useState } from 'react'
import { clinicById } from '../data'
import { PrimaryButton, ScreenHeader } from '../ui'

// In the pilot this arrives by SMS on day 3 ("Reply 1 Yes, 2 Not yet").
// The app version lets a girl answer as soon as she has been.
export default function Checkin({ pass, go, save }) {
  const [visited, setVisited] = useState(null)
  const [respect, setRespect] = useState(null)
  const [served, setServed] = useState(null)
  if (!pass) return null

  const ready = visited === 'no' || (visited === 'yes' && served && respect)

  return (
    <>
      <ScreenHeader onBack={() => go('pass', pass.code)} backLabel="Back to pass" title={<>How did it <em className="font-semibold">go</em>?</>} />
      <main className="flex flex-1 flex-col gap-4 px-4 pt-1 pb-6">
        <p className="m-0 text-[15px] text-muted">
          About your pass <strong className="text-ink">{pass.code}</strong> for {clinicById(pass.clinic)?.name}. Anonymous. Helps other girls choose safe clinics.
        </p>

        <Question label="Did you visit the clinic?" value={visited} onChange={setVisited} options={[['yes', 'Yes'], ['no', 'Not yet']]} />
        {visited === 'yes' && (
          <>
            <Question label="Did you get the care you needed?" value={served} onChange={setServed} options={[['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]} />
            <Question label="Were you treated with respect?" value={respect} onChange={setRespect} options={[['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]} />
          </>
        )}
        {visited === 'no' && (
          <p className="m-0 rounded-[14px] bg-sand p-3.5 text-[15px]">That's okay. Your pass still works. If something is stopping you, a Dada can help.</p>
        )}

        <PrimaryButton disabled={!ready} onClick={() => save(pass.code, { visited, served, respect, at: Date.now() })}>
          Send anonymously
        </PrimaryButton>
      </main>
    </>
  )
}

function Question({ label, value, onChange, options }) {
  return (
    <fieldset className="m-0 flex flex-col gap-3 rounded-[18px] border border-line bg-white p-4">
      <legend className="float-left mb-3 w-full p-0 text-[17px] font-bold">{label}</legend>
      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`min-h-12 rounded-[14px] border text-[15px] font-bold ${value === v ? 'border-ink bg-ink text-white' : 'border-chip bg-white text-ink hover:border-ink'}`}
          >
            {l}
          </button>
        ))}
      </div>
    </fieldset>
  )
}
