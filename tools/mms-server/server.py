"""Ubah MMS server: speech-to-text with Meta's MMS model, for languages Whisper lacks (Afaan Oromoo).

POST /audio/transcriptions   multipart: file (any audio ffmpeg can read), language (ISO 639-3, e.g. som, gaz)
                             -> {"text": "...", "confidence": 0.0-1.0, "language": "gaz"}
GET  /languages              -> the language codes this model supports
GET  /health                 -> {"ok": true}

Ubah calls it as the "mms" provider (src/providers/speech.ts). Nothing is stored: each recording is
decoded in memory, transcribed and dropped, and no transcript is logged.
"""

import os
import subprocess
import threading

import numpy as np
import torch
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from transformers import AutoProcessor, Wav2Vec2ForCTC

MODEL_ID = os.environ.get("MMS_MODEL", "facebook/mms-1b-all")
API_KEY = os.environ.get("MMS_API_KEY", "")
MAX_SECONDS = int(os.environ.get("MMS_MAX_SECONDS", "120"))
RATE = 16_000

processor = AutoProcessor.from_pretrained(MODEL_ID)
model = Wav2Vec2ForCTC.from_pretrained(MODEL_ID)
device = "cuda" if torch.cuda.is_available() else "cpu"
model.to(device).eval()
SUPPORTED = sorted(processor.tokenizer.vocab.keys())

# One language adapter is loaded at a time; switching is quick, but requests must not overlap a switch.
lock = threading.Lock()
loaded = {"language": None}

app = FastAPI(title="Ubah MMS server")


def decode(data: bytes) -> np.ndarray:
    """Any audio (ogg/opus, webm, m4a, mp3, wav) -> 16 kHz mono float32, via ffmpeg, in memory."""
    run = subprocess.run(
        ["ffmpeg", "-nostdin", "-loglevel", "error", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", str(RATE), "pipe:1"],
        input=data,
        capture_output=True,
        check=False,
    )
    if run.returncode != 0:
        raise HTTPException(status_code=400, detail={"error": "unreadable_audio"})
    return np.frombuffer(run.stdout, dtype=np.float32)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "device": device}


@app.get("/languages")
def languages():
    return {"languages": SUPPORTED}


@app.post("/audio/transcriptions")
def transcribe(
    file: UploadFile = File(...),
    language: str = Form(...),
    model_name: str = Form(None, alias="model"),
    authorization: str = Header(None),
):
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail={"error": "unauthorized"})
    if language not in SUPPORTED:
        raise HTTPException(status_code=400, detail={"error": "unsupported_language", "language": language})
    audio = decode(file.file.read())
    if audio.size == 0:
        return {"text": "", "confidence": 0.0, "language": language}
    if audio.size > RATE * MAX_SECONDS:
        raise HTTPException(status_code=413, detail={"error": "too_long"})

    with lock:
        if loaded["language"] != language:
            processor.tokenizer.set_target_lang(language)
            model.load_adapter(language)
            loaded["language"] = language
        inputs = processor(audio, sampling_rate=RATE, return_tensors="pt").to(device)
        with torch.no_grad():
            logits = model(**inputs).logits[0]
        ids = torch.argmax(logits, dim=-1)
        text = processor.decode(ids)

    # Confidence: the model's average certainty on the frames where it heard a letter (not silence).
    probs = torch.softmax(logits, dim=-1).max(dim=-1).values
    spoken = ids != processor.tokenizer.pad_token_id
    confidence = float(probs[spoken].mean()) if bool(spoken.any()) else 0.0
    return {"text": text.strip(), "confidence": round(confidence, 3), "language": language}
