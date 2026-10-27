# Language evaluation

Real voice notes, run through the same steps as a girl's message, to decide whether a language
stays **beta** or becomes **enabled** (`src/languages/<lang>.ts`).

```
eval/audio/so/001.ogg …        the recordings          (git-ignored: real voices)
eval/expected/so.csv           what each one should be (git-ignored: what people said)
eval/report.md                 the result              (git-ignored)
```

`eval/expected/<lang>.csv` has one row per recording (see `example/so.csv`):

| Column | What to write |
|---|---|
| `file` | the file name in `eval/audio/<lang>/` |
| `said` | exactly what was said, in the speaker's words (mixed languages as spoken) |
| `meaning` | the correct English meaning |
| `should_be_urgent` | `yes` or `no` |
| `consent_ref` | the reference of the signed consent form. **A row without it is refused** and never sent to any provider |

Only record young women aged 18+, with signed consent, reading or speaking typical questions.
For each language, aim for 10–20 notes: formal, casual, and mixed with English. Include urgent
sentences, and ordinary ones that use similar words ("a little blood"), to catch false alarms.

Run it:

```bash
npm run eval:languages                 # every language with a CSV; needs STT_API_KEY and GOOGLE_TRANSLATE_API_KEY
npm run eval:languages -- --lang so    # one language
npm run eval:languages -- --mock       # no keys: checks the CSV and the danger lists only
```

Read the report in this order: **urgent messages missed** (each one needs a new danger word in
`data/danger/` or a closer look), then transcription errors, then the English side by side with the
correct meaning. A native speaker should read the translation table.
