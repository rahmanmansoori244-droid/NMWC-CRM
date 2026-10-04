/**
 * F2 — a hand-drawn, APPROXIMATE outline of Oman for the dashboard's heat map.
 *
 * Entered by hand from general geographic knowledge of the coastline and the
 * borders (no file was downloaded and nothing is fetched at runtime): the
 * mainland, the Musandam exclave and Masirah island, in [longitude, latitude]
 * degrees. It is a frame for orientation, accurate to roughly ten kilometres —
 * NOT a survey map, and the page says so. Borders are drawn as straight runs.
 *
 * Served from the app's own bundle as inline SVG: no tiles, no third-party
 * request, no CSP change.
 */

export type LngLat = readonly [number, number];

/** Mainland, clockwise from the Yemen border on the Arabian Sea coast. */
const MAINLAND: readonly LngLat[] = [
  [53.11, 16.65], // Yemen border at the coast
  [52.78, 17.35],
  [52.0, 19.0], // Yemen–Saudi tripoint
  [55.0, 20.0], // Saudi border
  [55.67, 22.0],
  [55.21, 22.71], // Saudi–UAE tripoint
  [55.23, 23.11], // UAE border
  [55.53, 23.52],
  [55.53, 23.93],
  [55.98, 24.13],
  [55.8, 24.27],
  [55.89, 24.92],
  [56.37, 24.98], // Gulf of Oman coast, north of Shinas
  [56.6, 24.55],
  [56.85, 24.24], // Sohar
  [57.15, 23.95],
  [57.4, 23.88],
  [57.9, 23.72], // Barka
  [58.2, 23.66], // Seeb
  [58.6, 23.6], // Muscat
  [58.75, 23.5],
  [58.95, 23.2], // Qurayyat
  [59.18, 22.99],
  [59.45, 22.66], // Sur
  [59.81, 22.53], // Ras al Hadd
  [59.81, 22.31],
  [59.6, 21.95],
  [59.44, 21.71],
  [59.28, 21.43],
  [58.86, 21.11],
  [58.49, 20.43], // Barr al Hikman
  [58.03, 20.48],
  [57.83, 20.24],
  [57.67, 19.74], // Duqm
  [57.79, 19.07], // Ras Madrakah
  [57.69, 18.94],
  [57.23, 18.95],
  [56.61, 18.57],
  [56.51, 18.09],
  [56.28, 17.88],
  [55.66, 17.88], // Shuwaymiyah
  [55.27, 17.63],
  [55.27, 17.23], // Hasik
  [54.79, 16.95], // Mirbat
  [54.24, 17.04], // Salalah
  [53.57, 16.71],
];

/** Musandam, the exclave at the Strait of Hormuz. */
const MUSANDAM: readonly LngLat[] = [
  [56.26, 25.71],
  [56.07, 26.06],
  [56.18, 26.2],
  [56.36, 26.4],
  [56.49, 26.31],
  [56.43, 26.07],
  [56.39, 25.9],
];

/** Masirah island, off the Arabian Sea coast. */
const MASIRAH: readonly LngLat[] = [
  [58.62, 20.17],
  [58.78, 20.36],
  [58.9, 20.55],
  [58.94, 20.69],
  [58.86, 20.7],
  [58.74, 20.5],
  [58.64, 20.33],
];

export const OMAN_POLYGONS: readonly (readonly LngLat[])[] = [MAINLAND, MUSANDAM, MASIRAH];

/** A few towns for orientation (approximate centres). */
export const OMAN_PLACES: ReadonlyArray<{ name: string; at: LngLat }> = [
  { name: 'Khasab', at: [56.24, 26.18] },
  { name: 'Sohar', at: [56.75, 24.35] },
  { name: 'Muscat', at: [58.41, 23.59] },
  { name: 'Nizwa', at: [57.53, 22.93] },
  { name: 'Sur', at: [59.53, 22.57] },
  { name: 'Duqm', at: [57.7, 19.67] },
  { name: 'Salalah', at: [54.09, 17.02] },
];

/** The frame the country view draws: Oman with a little sea around it. */
export const OMAN_FRAME = { lngMin: 51.7, lngMax: 60.2, latMin: 16.3, latMax: 26.7 } as const;

export type Frame = { lngMin: number; lngMax: number; latMin: number; latMax: number };

/**
 * Equirectangular projection into SVG units: 100 units per degree of latitude,
 * and longitude shrunk by cos(21°), the middle of the country, so shapes keep
 * their proportions within a few percent across Oman.
 */
const UNITS = 100;
const KX = UNITS * Math.cos((21 * Math.PI) / 180);

export function project(frame: Frame, [lng, lat]: LngLat): [number, number] {
  return [round((lng - frame.lngMin) * KX), round((frame.latMax - lat) * UNITS)];
}

export function frameSize(frame: Frame): { width: number; height: number } {
  return { width: round((frame.lngMax - frame.lngMin) * KX), height: round((frame.latMax - frame.latMin) * UNITS) };
}

/** One SVG path for every polygon, in this frame. */
export function outlinePath(frame: Frame): string {
  return OMAN_POLYGONS.map(
    (poly) => poly.map((p, i) => `${i === 0 ? 'M' : 'L'}${project(frame, p).join(' ')}`).join(' ') + ' Z'
  ).join(' ');
}

/** Size of one degree of longitude and latitude in SVG units. */
export const UNITS_PER_DEG = { x: KX, y: UNITS } as const;

/**
 * The frame for a set of cells: their extent with a margin, never smaller than
 * `minSpan` degrees, kept inside the country frame, and widened to the country
 * frame's aspect so the picture keeps its proportions.
 */
export function frameAround(
  cells: ReadonlyArray<{ lat: number; lng: number }>,
  cellDeg: number,
  minSpan = 1
): Frame {
  if (cells.length === 0) return { ...OMAN_FRAME };
  let latMin = Infinity;
  let latMax = -Infinity;
  let lngMin = Infinity;
  let lngMax = -Infinity;
  for (const c of cells) {
    latMin = Math.min(latMin, c.lat);
    latMax = Math.max(latMax, c.lat + cellDeg);
    lngMin = Math.min(lngMin, c.lng);
    lngMax = Math.max(lngMax, c.lng + cellDeg);
  }
  const pad = 0.15;
  let f: Frame = { lngMin: lngMin - pad, lngMax: lngMax + pad, latMin: latMin - pad, latMax: latMax + pad };
  // At least minSpan degrees tall, centred.
  const latSpan = Math.max(minSpan, f.latMax - f.latMin);
  const latMid = (f.latMin + f.latMax) / 2;
  f = { ...f, latMin: latMid - latSpan / 2, latMax: latMid + latSpan / 2 };
  // The country frame's aspect (in projected units), by widening whichever side is short.
  const target = frameSize(OMAN_FRAME).width / frameSize(OMAN_FRAME).height;
  const size = frameSize(f);
  if (size.width / size.height < target) {
    const lngSpan = (size.height * target) / KX;
    const lngMid = (f.lngMin + f.lngMax) / 2;
    f = { ...f, lngMin: lngMid - lngSpan / 2, lngMax: lngMid + lngSpan / 2 };
  } else {
    const latSpan2 = size.width / target / UNITS;
    const mid = (f.latMin + f.latMax) / 2;
    f = { ...f, latMin: mid - latSpan2 / 2, latMax: mid + latSpan2 / 2 };
  }
  // Never wider than the country view itself.
  if (f.lngMax - f.lngMin >= OMAN_FRAME.lngMax - OMAN_FRAME.lngMin) return { ...OMAN_FRAME };
  return f;
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
