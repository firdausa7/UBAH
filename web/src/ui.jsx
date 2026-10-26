// Shared UI pieces and stroke icons.

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

export const Icon = {
  Chat: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  ),
  Pin: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </svg>
  ),
  Book: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M4 5h6a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2H4z" />
      <path d="M20 5h-6a2 2 0 0 0-2 2v12a2 2 0 0 1 2-2h6z" />
    </svg>
  ),
  Lock: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  ),
  Back: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} strokeWidth={2.2} {...p}>
      <path d="M15 18l-6-6 6-6" />
    </svg>
  ),
  Mic: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  ),
  Send: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M4 12l16-8-6 16-2.5-6.5z" />
    </svg>
  ),
  Play: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
      <path d="M7 4l13 8-13 8z" />
    </svg>
  ),
  Stop: (p) => (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ),
  Ticket: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v8a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2z" />
      <path d="M13 6v12" strokeDasharray="2 2" />
    </svg>
  ),
  Home: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z" />
    </svg>
  ),
  Alert: (p) => (
    <svg viewBox="0 0 24 24" {...stroke} {...p}>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v4M12 18h.01" />
    </svg>
  ),
}

// Leaves the app at once and replaces this page in history, so Back does not return.
export function quickExit() {
  window.location.replace('https://www.google.com/search?q=weather+today')
}

export function QuickExit({ short = false }) {
  return (
    <button
      type="button"
      onClick={quickExit}
      aria-label="Quick exit, closes Ubah instantly"
      className="h-11 shrink-0 rounded-full border-2 border-ink bg-white px-3.5 text-[15px] font-bold text-ink hover:bg-sand"
    >
      {short ? 'Exit' : 'Quick exit'}
    </button>
  )
}

export function BackButton({ onClick, label = 'Back' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-sand"
    >
      <Icon.Back className="size-[22px]" />
    </button>
  )
}

export function ScreenHeader({ onBack, backLabel, title, subtitle, className = '' }) {
  return (
    <header className={`flex items-center gap-3 px-4 pt-4 pb-3 ${className}`}>
      {onBack && <BackButton onClick={onBack} label={backLabel} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="m-0 text-[24px] leading-tight font-normal">{title}</h1>
        {subtitle && <span className="text-[13px] text-muted">{subtitle}</span>}
      </div>
      <QuickExit short />
    </header>
  )
}

export function Chip({ pressed, onClick, children, size = 'md' }) {
  const h = size === 'sm' ? 'h-10 px-3.5 text-sm' : 'h-11 px-4 text-[15px]'
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`${h} rounded-full transition-colors ${
        pressed
          ? 'border border-ink bg-ink font-bold text-white'
          : 'border border-chip bg-white text-ink hover:border-ink'
      }`}
    >
      {children}
    </button>
  )
}

export function PrimaryButton({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`flex min-h-12 items-center justify-center rounded-full bg-clay px-5 text-base font-bold text-white hover:bg-clay-dark disabled:opacity-40 ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function SecondaryButton({ children, className = '', ...props }) {
  return (
    <button
      type="button"
      className={`flex min-h-12 items-center justify-center rounded-full border border-ink bg-white px-5 text-base font-bold text-ink hover:bg-sand ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Badge({ tone = 'ok', children }) {
  const tones = {
    ok: 'bg-ok-bg text-ok',
    warn: 'bg-warn-bg text-warn',
    neutral: 'bg-sand text-ink',
  }
  return (
    <span className={`inline-flex rounded-xl px-2.5 py-1 text-[13px] font-bold ${tones[tone]}`}>
      {children}
    </span>
  )
}

export function speak(lines, onEnd) {
  if (!('speechSynthesis' in window)) return false
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(lines.join(' '))
  u.rate = 0.95
  u.onend = onEnd
  u.onerror = onEnd
  window.speechSynthesis.speak(u)
  return true
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
