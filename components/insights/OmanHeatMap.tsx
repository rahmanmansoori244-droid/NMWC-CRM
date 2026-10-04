import {
  OMAN_FRAME,
  OMAN_PLACES,
  UNITS_PER_DEG,
  frameAround,
  frameSize,
  outlinePath,
  project,
  type Frame,
} from '@/lib/geo/oman';
import { COAST, LAND, SEQUENTIAL } from './palette';

export type HeatCell = { lat: number; lng: number; n: number };

/**
 * Upper bounds of up to five colour classes over the cells' counts: one class per
 * distinct count when there are five or fewer, quantiles otherwise.
 */
export function heatClasses(counts: number[]): number[] {
  const distinct = [...new Set(counts)].sort((a, b) => a - b);
  if (distinct.length <= SEQUENTIAL.length) return distinct;
  const sorted = [...counts].sort((a, b) => a - b);
  const bounds: number[] = [];
  for (let i = 1; i <= SEQUENTIAL.length; i++) {
    const v = sorted[Math.min(sorted.length - 1, Math.ceil((i / SEQUENTIAL.length) * sorted.length) - 1)]!;
    if (!bounds.includes(v)) bounds.push(v);
  }
  if (bounds[bounds.length - 1] !== sorted[sorted.length - 1]) bounds.push(sorted[sorted.length - 1]!);
  return bounds.slice(-SEQUENTIAL.length);
}

function classOf(n: number, bounds: number[]): number {
  const i = bounds.findIndex((b) => n <= b);
  return i === -1 ? bounds.length - 1 : i;
}

/**
 * Fewer classes than ramp steps are spread across the whole ramp, light to dark,
 * so two classes read as clearly different; a single class takes the middle step.
 */
function colourFor(cls: number, classes: number): string {
  const last = SEQUENTIAL.length - 1;
  const idx = classes <= 1 ? Math.floor(last / 2) : Math.round((cls * last) / (classes - 1));
  return SEQUENTIAL[Math.max(0, Math.min(last, idx))]!;
}

/**
 * F2 — where the open branches in view that have GPS sit, on a hand-drawn,
 * approximate outline of Oman (lib/geo/oman.ts). Server-rendered inline SVG: no
 * tiles, no third party, no script.
 *
 * Squares are grid cells the database counted (lib/insights/load.ts heatSql) —
 * never a branch's own point. A cell too small to see at this scale is drawn at a
 * minimum size around its centre, and the legend says so. With one region in
 * view the frame closes in on its cells.
 */
export function OmanHeatMap({
  cells,
  cellDeg,
  zoom,
}: {
  cells: HeatCell[];
  cellDeg: number;
  /** Close in on the cells (one region in view) instead of showing the whole country. */
  zoom: boolean;
}) {
  const frame: Frame = zoom ? frameAround(cells, cellDeg) : { ...OMAN_FRAME };
  const { width, height } = frameSize(frame);
  const bounds = heatClasses(cells.map((c) => c.n));
  const minSide = width * 0.009;
  const trueW = cellDeg * UNITS_PER_DEG.x;
  const trueH = cellDeg * UNITS_PER_DEG.y;
  const enlarged = trueW < minSide;
  const fontSize = Math.round(width * 0.026 * 10) / 10;
  const located = cells.reduce((s, c) => s + c.n, 0);
  const densest = cells.reduce((m, c) => Math.max(m, c.n), 0);
  const ordered = [...cells].sort((a, b) => a.n - b.n);

  return (
    <figure className="min-w-0">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full max-w-md"
        role="img"
        aria-label={`Approximate map of Oman: ${cells.length.toLocaleString('en-GB')} squares hold ${located.toLocaleString('en-GB')} open branches with GPS; the densest square holds ${densest.toLocaleString('en-GB')}.`}
      >
        <defs>
          <clipPath id="oman-frame">
            <rect x="0" y="0" width={width} height={height} />
          </clipPath>
        </defs>
        <rect x="0" y="0" width={width} height={height} fill="#ffffff" />
        <g clipPath="url(#oman-frame)">
          <path d={outlinePath(frame)} fill={LAND} stroke={COAST} strokeWidth={width * 0.0025} strokeLinejoin="round" />
          {ordered.map((c) => {
            const [x0, y0] = project(frame, [c.lng, c.lat + cellDeg]);
            const side = Math.max(trueW, minSide);
            const sideY = Math.max(trueH, minSide);
            const x = enlarged ? x0 + trueW / 2 - side / 2 : x0;
            const y = enlarged ? y0 + trueH / 2 - sideY / 2 : y0;
            const cls = classOf(c.n, bounds);
            return (
              <rect
                key={`${c.lat}:${c.lng}`}
                x={round(x)}
                y={round(y)}
                width={round(side)}
                height={round(sideY)}
                fill={colourFor(cls, bounds.length)}
                fillOpacity={0.9}
              >
                <title>{`${c.n.toLocaleString('en-GB')} open branch${c.n === 1 ? '' : 'es'} with GPS`}</title>
              </rect>
            );
          })}
          {OMAN_PLACES.map((p) => {
            const [x, y] = project(frame, p.at);
            if (x < 0 || y < 0 || x > width || y > height) return null;
            // Near the right edge the name goes to the left of its dot, so it is not cut off.
            const leftward = x > width * 0.82;
            return (
              <g key={p.name} aria-hidden="true">
                <circle cx={x} cy={y} r={fontSize * 0.22} fill="#475569" />
                <text
                  x={leftward ? x - fontSize * 0.4 : x + fontSize * 0.4}
                  y={y + fontSize * 0.35}
                  fontSize={fontSize}
                  fill="#475569"
                  textAnchor={leftward ? 'end' : 'start'}
                >
                  {p.name}
                </text>
              </g>
            );
          })}
        </g>
      </svg>
      <figcaption className="mt-2 space-y-1 text-[11px] text-slate-500">
        {bounds.length > 0 && (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Open branches per square:</span>
            {bounds.map((b, i) => {
              const lo = i === 0 ? 1 : bounds[i - 1]! + 1;
              return (
                <span key={b} className="flex items-center gap-1">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: colourFor(i, bounds.length) }}
                  />
                  <span className="tabular-nums">{lo === b ? b : `${lo}–${b}`}</span>
                </span>
              );
            })}
          </span>
        )}
        <span className="block">
          Each square is {cellDeg}° (about {Math.round(cellDeg * 111)} km) across
          {enlarged ? '; small squares are drawn larger so they stay visible' : ''}. Outline approximate, not a survey
          map; town names for orientation only.
        </span>
      </figcaption>
    </figure>
  );
}

function round(v: number): number {
  return Math.round(v * 10) / 10;
}
