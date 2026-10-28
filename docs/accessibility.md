# Accessibility and slow networks

What is checked automatically, what was measured, and what still needs people.

## Checked on every test run

| Check | Where | What it covers |
|---|---|---|
| Colour contrast, WCAG AA (4.5:1) | `web/src/lib/contrast.test.js` | Every text colour on every background the girls' screens use: 6 dark text colours × 8 light backgrounds, 3 light text colours × 3 dark backgrounds (58 pairs). Colours are read from `web/src/index.css`, so a palette change is checked too. |
| axe-core, WCAG 2.1 A + AA | `web/src/a11y.test.jsx` | Sign in, Chat (with a nurse's reply and a menu), Wellbeing, Confidential report, Settings, the PIN lock. Rendered with the real English words from `src/i18n.ts`, so a missing word (an empty label) fails. |
| No third-party fonts | `test/security.test.ts` | The CSP allows fonts and styles only from Ubah; the landing page and `/staff` link `/ui/fonts.css`. |
| Compression | `test/security.test.ts` | Built app files are compressed; pages and API answers are not. |

The axe test was checked against a deliberate fault: removing the settings button's label failed 4 of the 6 screens.

### Fixed in this pass

- The violet accent (`#6c4acf`) reached only 3.96:1 on rose and 4.32:1 on mist. It is now `#623ecc` (same hue, slightly darker; at least 4.53:1 on every light background, 6.82:1 on white), in the app, the landing page and `/staff`.

### Not covered by these checks

- jsdom does not paint, so axe cannot measure contrast there. The contrast test covers the palette, but not text placed over images or with reduced opacity (`bg-cream/95`, `bg-white/60`).
- No test with a real screen reader (TalkBack on a low-cost Android phone is the one that matters), and no test with girls who read little. Both need people, in Dadaab, before launch.
- The screens' words are checked in English only. Somali, Kiswahili and Afaan Oromoo labels depend on published translations.
- `/staff` pages (server-rendered) are not run through axe.

## Slow networks

Measured from the production build (`npm --prefix web run build`) and the running server.

| First open of the girls' space | Over the network |
|---|---|
| Page (`index.html`) | 0.5 kB |
| App script | 315 kB, **95 kB** compressed |
| Styles | 29 kB, 6 kB compressed |
| Fonts | only the faces a screen uses: about 14 kB each (DM Sans), 23 kB each (Cormorant Garamond) |
| Her words (`/api/strings`) | 11.6 kB (4.2 kB if compressed; left as is) |

- Built files have content-based names and are cached for a year (`immutable`); a return visit downloads only what changed.
- The service worker keeps the app, its fonts, the words and the lessons for offline use, and never her messages (see `web/public/sw.js`). `/ui/fonts.css` has a fixed name, so it is checked for a newer copy each time.
- The workers' and admins' screens are separate files that girls' phones never download.
- Fonts were fetched from Google before; they are now bundled (Latin subset only: Somali, Kiswahili, Afaan Oromoo and English all use it), so a girl's phone no longer contacts Google and the fonts work offline.
- Compression is applied only to `/ui` files. Pages and API answers can contain someone's data next to text she typed, which compression can leak (BREACH); they stay uncompressed.

Not measured: real load times on 2G/3G in Dadaab. The numbers above are sizes, not times.
