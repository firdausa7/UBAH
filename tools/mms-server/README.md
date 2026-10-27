# Ubah MMS server

Speech-to-text with Meta's **MMS** (Massively Multilingual Speech) model, for languages OpenAI's
speech-to-text doesn't cover, first of all **Afaan Oromoo**. Ubah calls it as the `mms` provider.

> **Not yet run by the Ubah team.** This is a reference server: test it on your machine before
> relying on it, and measure it with `npm run eval:languages` like any other provider.

## Before you use it

- **Licence:** the MMS model weights are released under **CC-BY-NC 4.0 (non-commercial)**. Ask your
  legal adviser whether a pilot run by HPI-SOLUTIONS KE LIMITED may use them.
- **Which Oromo?** MMS has several Oromo varieties: `gaz` (West Central), `hae` (Eastern),
  `gax` (Borana-Arsi-Guji, spoken in northern Kenya). `GET /languages` lists what the model has.
  Record with your speakers and compare (`STT_OM_LANGUAGE=gax`, then `gaz`).
- **Language must be given.** MMS can't detect the language and is weaker on notes that mix
  languages; for Somali and Kiswahili, compare it with OpenAI on the same recordings.
- **Hosting:** voice notes are personal data. Host it where your DPIA allows (ideally in Kenya); it
  stores nothing and logs no transcripts.

## Run it

Needs Python 3.11+, `ffmpeg`, and about 4 GB for the model (downloaded on first start). A GPU is
much faster; a CPU works for testing.

```bash
cd tools/mms-server
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
MMS_API_KEY=choose-a-long-random-key uvicorn server:app --host 0.0.0.0 --port 8090
curl http://localhost:8090/languages
```

## Connect Ubah

In Ubah's `.env` (per language; the others keep using OpenAI):

```
STT_OM_PROVIDER=mms
STT_OM_BASE_URL=http://your-mms-server:8090
STT_OM_API_KEY=the-same-long-random-key
STT_OM_LANGUAGE=gaz
```

Then compare on your recordings, for example Somali on both:

```bash
npm run eval:languages -- --lang so                      # OpenAI (eval/report.md)
npm run eval:languages -- --lang so --provider so=mms    # MMS    (eval/report-so-mms.md)
```

Use the provider with **no missed urgent messages** and the lower error rate.
