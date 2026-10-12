import busboy from "busboy";
import type { Request } from "express";

// Reads one uploaded audio file from a multipart form, with strict size and type limits.
export const AUDIO_TYPES: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};
export const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

export interface Upload {
  bytes: Buffer;
  mime: string;
  filename: string;
}

export function readAudioUpload(req: Request): Promise<Upload | null> {
  return new Promise((resolve) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_AUDIO_BYTES, fields: 5 } });
    } catch {
      return resolve(null);
    }
    let result: Upload | null = null;
    let bad = false;
    bb.on("file", (_name, stream, info) => {
      const mime = info.mimeType.split(";")[0].trim().toLowerCase();
      if (!(mime in AUDIO_TYPES)) {
        bad = true;
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("limit", () => {
        bad = true;
      });
      stream.on("end", () => {
        if (!bad) result = { bytes: Buffer.concat(chunks), mime, filename: (info.filename ?? "").slice(0, 120) };
      });
    });
    bb.on("close", () => resolve(bad || !result || result.bytes.length === 0 ? null : result));
    bb.on("error", () => resolve(null));
    req.pipe(bb);
  });
}
