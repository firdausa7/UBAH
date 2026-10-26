# Ubah prototype

React + Tailwind CSS (v4, Vite) prototype of Ubah, the voice-first Somali SRH companion described in the UNICEF Femtech Ventures solution brief. The design follows the Ubah MVP canvas.

```bash
npm install
npm run dev      # then open the printed localhost URL
npm run build
```

## Views (switch with the dark bar at the top)

- **Girl app** (`#/`): Home (language, PIN lock, wipe history, quick exit), Ask Ubah (topic answers, danger-sign triage, "I don't know" + Dada handoff, read-aloud), Learn, Find care (filter by service), Referral pass (anonymous code, valid 7 days), My passes, and the after-visit check-in (visited / served / respect).
- **Dada inbox** (`#/dada`): urgent and waiting cases from the girl app, editable AI draft, send reply back to the girl's chat.
- **Partner dashboard** (`#/partner`): questions by topic, passes, visits confirmed, clinic dignity scores, urgent handoffs, JSON export. All figures come from real use of the prototype; nothing is pre-filled.

## Before testing with users

- Replace every answer in `src/data.js` with health-partner-approved content (WHO / MoH), and the `[PLACEHOLDER]` clinic names, hours, shortcode and nurse number.
- Data is kept in the browser's localStorage on one device. A pilot needs a backend (WhatsApp / SMS gateway, Kenya-hosted storage, DPIA).
- Voice notes and Somali replies are not built yet: answers show in English and are read aloud with the browser's speech engine.
