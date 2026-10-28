import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Every text colour on every background the girls' screens put it on reaches WCAG AA for normal
// text (4.5:1): small phones, bright sun, cracked screens. Colours are read from index.css itself.

const css = readFileSync('src/index.css', 'utf8') // tests run from web/
const color = Object.fromEntries([...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]))
color.white = '#ffffff'

const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const DARK_TEXT = ['plum', 'text', 'muted', 'rose-ink', 'accent', 'urgent']
const LIGHT_BG = ['cream', 'white', 'lavender', 'blush', 'soft', 'rose', 'mist', 'urgent-bg']
const LIGHT_TEXT = ['cream', 'white', 'mist']
const DARK_BG = ['plum', 'accent', 'urgent']

describe('colour contrast (WCAG AA, 4.5:1)', () => {
  it('reads the palette', () => {
    for (const k of [...DARK_TEXT, ...LIGHT_BG, ...LIGHT_TEXT, ...DARK_BG]) expect(color[k], k).toMatch(/^#/)
  })
  const pairs = [...DARK_TEXT.flatMap((t) => LIGHT_BG.map((b) => [t, b])), ...LIGHT_TEXT.flatMap((t) => DARK_BG.map((b) => [t, b]))]
  it.each(pairs)('%s on %s', (t, b) => {
    expect(ratio(color[t], color[b]), `${t} ${color[t]} on ${b} ${color[b]}`).toBeGreaterThanOrEqual(4.5)
  })
})
