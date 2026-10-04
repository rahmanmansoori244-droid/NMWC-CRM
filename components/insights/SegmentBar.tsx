import { Swatch } from './InsightCard';

export type Segment = { key: string; label: string; value: number; color: string };

/**
 * F2 — one horizontal bar split into parts of a whole (requests by state), with
 * every part named and counted in text beside it. Segments are 2px apart.
 */
export function SegmentBar({ label, segments, emptyText }: { label: string; segments: Segment[]; emptyText: string }) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  return (
    <div className="text-xs">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-medium text-slate-800">{label}</span>
        <span className="tabular-nums text-slate-600">{total.toLocaleString('en-GB')}</span>
      </div>
      {total === 0 ? (
        <p className="text-slate-500">{emptyText}</p>
      ) : (
        <>
          <div className="flex h-2.5 gap-[2px] overflow-hidden rounded-full" aria-hidden="true">
            {segments
              .filter((s) => s.value > 0)
              .map((s) => (
                <div key={s.key} style={{ flexGrow: s.value, flexBasis: 0, backgroundColor: s.color }} />
              ))}
          </div>
          <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600">
            {segments.map((s) => (
              <li key={s.key} className="flex items-center gap-1">
                <Swatch color={s.color} />
                {s.label} <span className="font-semibold tabular-nums text-slate-800">{s.value.toLocaleString('en-GB')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
