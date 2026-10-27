import { Link } from 'react-router'

export function Brand({ to = '/', light = false, suffix }) {
  return (
    <Link to={to} className="flex items-center gap-2.5 no-underline" reloadDocument={to === '/'}>
      <img src="/assets/rose.png" alt="" className="h-9 w-auto" />
      <span className={`font-serif text-[26px] font-semibold tracking-[3px] ${light ? 'text-cream' : 'text-plum'}`}>UBAH</span>
      {suffix && <span className={`ml-1 text-sm ${light ? 'text-mist' : 'text-muted'}`}>{suffix}</span>}
    </Link>
  )
}
