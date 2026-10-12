// "Nearest partner clinic" from a shared location or a typed area/landmark.
// Clinic coordinates and landmarks are entered by admins. A girl's coordinates are never stored.

export interface ClinicPlace {
  id: number;
  name: string;
  area: string;
  hours: string;
  services: string[];
  lat: number | null;
  lng: number | null;
  landmarks: string[];
  site_id: number | null;
  site: string | null;
}

// Great-circle distance in kilometres.
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["the", "near", "in", "at", "block", "my", "i", "am", "im"].includes(w));

// Best clinic whose landmarks, area, site or name share words with what she typed.
export function matchPlace(clinics: ClinicPlace[], text: string): { clinicId: number; name: string; point: { lat: number; lng: number } | null } | null {
  const q = new Set(words(text));
  if (!q.size) return null;
  let best: { score: number; c: ClinicPlace; name: string } | null = null;
  for (const c of clinics) {
    const candidates: Array<[string, number]> = [...c.landmarks.map((l): [string, number] => [l, 3]), [c.area, 2], [c.site ?? "", 1], [c.name, 1]];
    for (const [name, weight] of candidates) {
      const w = words(name);
      if (!w.length) continue;
      const hit = w.filter((x) => q.has(x)).length;
      if (!hit) continue;
      const score = (hit / w.length) * weight + hit;
      if (!best || score > best.score) best = { score, c, name };
    }
  }
  if (!best) return null;
  return { clinicId: best.c.id, name: best.name, point: best.c.lat != null && best.c.lng != null ? { lat: best.c.lat, lng: best.c.lng } : null };
}

// Clinics offering at least one needed service (or any, if none do), nearest first.
// Without a point, the preferred (matched) clinic comes first, then others at the same site.
export function nearestClinics(clinics: ClinicPlace[], origin: { lat: number; lng: number } | null, services: string[], preferId?: number) {
  const offering = services.length ? clinics.filter((c) => c.services.some((s) => services.includes(s))) : clinics;
  const pool = offering.length ? offering : clinics;
  const preferred = preferId ? clinics.find((c) => c.id === preferId) : undefined;
  return pool
    .map((c) => ({ clinic: c, km: origin && c.lat != null && c.lng != null ? haversineKm(origin, { lat: c.lat, lng: c.lng }) : null }))
    .sort((a, b) => {
      if (!origin && preferred) {
        const pa = a.clinic.id === preferred.id ? 0 : a.clinic.site_id === preferred.site_id ? 1 : 2;
        const pb = b.clinic.id === preferred.id ? 0 : b.clinic.site_id === preferred.site_id ? 1 : 2;
        if (pa !== pb) return pa - pb;
      }
      if (a.km == null && b.km == null) return 0;
      if (a.km == null) return 1;
      if (b.km == null) return -1;
      return a.km - b.km;
    });
}
