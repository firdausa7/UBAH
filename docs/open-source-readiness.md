# Open-source readiness

Checked on 2026-10-28. **No licence file has been added**: that waits for the decisions below.

## What was checked

| Check | Result |
|---|---|
| Secrets in the code | None in the current files, and none in any commit of the git history (searched for API keys, tokens and private keys, and for committed `.env`, key and credential files). `.env` is git-ignored; `.env.example` holds names only. |
| Real people's data | None in the repository. Demo data (`src/seed.ts`, `npm run demo`) is made up and labelled `[DEMO]`; production refuses to seed it. Voice recordings and evaluation sets (`eval/`, `data/stt-eval/`) are git-ignored. |
| Contributors | Every commit is by one author (Firdausa Salat). No outside contributions to clear. |
| Server dependencies (production) | MIT 131, ISC 13, Apache-2.0 3, BSD-3-Clause 1, 0BSD 1, and `png-js` (MIT, stated in its readme rather than its package file). All permissive and compatible with Apache-2.0. |
| Web app dependencies (shipped to phones) | MIT only (React, React DOM, React Router and their parts). Build tools (Vite, Tailwind, `lightningcss` under MPL-2.0) are build-time only and not shipped. |
| Fonts | DM Sans and Cormorant Garamond: SIL Open Font License 1.1 (free to bundle and self-host). |
| Separate tools | The MMS reference server (`tools/mms-server/`) is our own code, but the **MMS model weights are CC-BY-NC 4.0 (non-commercial)**: they are not in this repository, and whoever runs that server must check the licence. |
| Outside services | OpenAI, Google Cloud (Translation, Speech-to-Text), ElevenLabs, Meta WhatsApp, Africa's Talking, Safaricom M-Pesa: each has its own terms. Using them is configuration (keys in the environment), not code they own. |

## Decisions before publishing

1. **Who owns the copyright**: you personally, or HPI-SOLUTIONS KE LIMITED (and whether any funder or partner agreement, for example with UNICEF Femtech Ventures or a health partner, says anything about the code or content). Your legal adviser should confirm.
2. **The licence**. The project already declares **Apache-2.0** for the code (`package.json`): permissive, with a patent grant, compatible with every dependency above, and common for public-interest software. An alternative is **AGPL-3.0** if you want anyone running a modified Ubah as a service to publish their changes. Recommendation: Apache-2.0, unless a partner requires otherwise.
3. **Health content** (`content/`) and the glossary (`data/glossary.json`): the README proposes CC BY 4.0. The starter topics are drafts: publish them under a content licence only once a health partner has reviewed them and agreed (their sources must allow it).
4. **The name and partners**: say clearly that Ubah is not endorsed by UNICEF or any partner unless it is.

## Then, to publish

- Add `LICENSE` (the full Apache-2.0 text) and a short `NOTICE` (copyright owner and year).
- Keep `SECURITY.md` (how to report a vulnerability privately) and fill in its contact.
- Add a `CONTRIBUTING.md` asking contributors to sign off their commits (Developer Certificate of Origin), so later contributions are clear too.
- Publish from a fresh clone, never a working folder (no `.env`, `.data/`, `eval/` or `web/dist`).
