import { deflateSync } from "node:zlib";

// The app's PNG icons (Android needs PNGs to install a web app), drawn here so no image tool is
// needed: Ubah's coral square with a white "u". Made once at startup, then cached in memory.

function crc32(buf: Buffer): number {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// Coverage of the "u" stroke at (x, y), both in 0..1 icon units.
function onU(x: number, y: number): boolean {
  const w = 0.11; // stroke width
  const top = 0.28;
  const mid = 0.53;
  const r = 0.1875;
  if (y >= top && y <= mid && (Math.abs(x - 0.3125) <= w / 2 || Math.abs(x - 0.6875) <= w / 2)) return true;
  if (y > mid) {
    const d = Math.hypot(x - 0.5, y - mid);
    return Math.abs(d - r) <= w / 2;
  }
  // round caps on top
  return Math.hypot(x - 0.3125, y - top) <= w / 2 || Math.hypot(x - 0.6875, y - top) <= w / 2;
}

export function iconPng(size: number): Buffer {
  const ss = 3; // supersampling for smooth edges
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0; // filter: none
    for (let px = 0; px < size; px++) {
      let u = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) if (onU((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size)) u++;
      const a = u / (ss * ss);
      const o = py * (size * 4 + 1) + 1 + px * 4;
      // Full-bleed background (Android masks it to its own shape).
      raw[o] = Math.round(0xc8 * (1 - a) + 255 * a);
      raw[o + 1] = Math.round(0x46 * (1 - a) + 255 * a);
      raw[o + 2] = Math.round(0x2b * (1 - a) + 255 * a);
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const cache = new Map<number, Buffer>();
export const icon = (size: 192 | 512) => {
  if (!cache.has(size)) cache.set(size, iconPng(size));
  return cache.get(size)!;
};
