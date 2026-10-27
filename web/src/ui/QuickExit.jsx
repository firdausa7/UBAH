// Leaves at once and replaces this page in the browser history, like the landing page's Quick exit.
import { forgetEverything } from '../lib/offline.js'

export function quickExit() {
  // Lock her session on the server first (keepalive: it finishes even as the page goes), so whoever
  // opens this phone next needs her PIN.
  try {
    fetch('/api/auth/girl/lock', { method: 'POST', headers: { 'x-ubah': '1' }, credentials: 'same-origin', keepalive: true }).catch(() => {})
  } catch {
    /* offline: the session still locks itself after 15 minutes */
  }
  forgetEverything()
  window.location.replace('https://www.google.com/search?q=weather+today')
}

export function QuickExit({ label }) {
  return (
    <button type="button" onClick={quickExit} className="rounded-full bg-plum px-4 py-2 text-[15px] font-medium text-cream hover:bg-accent">
      {label || 'Quick exit'}
    </button>
  )
}
