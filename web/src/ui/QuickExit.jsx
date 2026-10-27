// Leaves at once and replaces this page in the browser history, like the landing page's Quick exit.
export function quickExit() {
  try {
    localStorage.removeItem('ubah:draft')
  } catch {
    /* nothing kept */
  }
  window.location.replace('https://www.google.com/search?q=weather+today')
}

export function QuickExit({ label }) {
  return (
    <button type="button" onClick={quickExit} className="rounded-full bg-plum px-4 py-2 text-[15px] font-medium text-cream hover:bg-accent">
      {label || 'Quick exit'}
    </button>
  )
}
