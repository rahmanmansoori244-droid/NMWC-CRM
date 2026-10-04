import Link from 'next/link';
import type { Route } from 'next';
import { SERIES, TRACK } from './palette';

export type BarRow = {
  key: string;
  label: string;
  /** A second line under the label ("12 open branches", "no salesman assigned"). */
  note?: string;
  value: number;
  /** What the right-hand column prints; defaults to the value. */
  display?: string;
  href?: Route;
  /** An accessible name for the link when the label alone is ambiguous. */
  hrefLabel?: string;
};

/**
 * F2 — a ranked list with a bar per row: a list, not a <table> (every table must
 * sit in TableScroll and their number is pinned), readable on a phone, value at
 * the bar's end in text colour. `max` fixes the scale (100 for percentages);
 * otherwise the largest value fills the track.
 */
export function BarList({
  rows,
  max,
  color = SERIES[0],
  emptyText,
  more,
}: {
  rows: BarRow[];
  max?: number;
  color?: string;
  emptyText: string;
  /** Rows left out of a capped list ("and 4 more"). */
  more?: number;
}) {
  if (rows.length === 0) return <p className="text-sm text-slate-500">{emptyText}</p>;
  const scale = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div>
      <ul className="space-y-2">
        {rows.map((r) => {
          const width = Math.max(0, Math.min(100, (r.value / scale) * 100));
          const label = r.href ? (
            <Link href={r.href} aria-label={r.hrefLabel} className="truncate font-medium text-brand-700 hover:underline">
              {r.label}
            </Link>
          ) : (
            <span className="truncate font-medium text-slate-800">{r.label}</span>
          );
          return (
            <li key={r.key} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-3 text-xs sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
              <div className="flex min-w-0 flex-col">
                {label}
                {r.note && <span className="text-[11px] leading-snug text-slate-500">{r.note}</span>}
              </div>
              <div className="h-2 overflow-hidden rounded-full" style={{ backgroundColor: TRACK }} aria-hidden="true">
                <div className="h-full rounded-full" style={{ width: `${width}%`, backgroundColor: color }} />
              </div>
              <span className="text-right font-semibold tabular-nums text-slate-800">
                {r.display ?? r.value.toLocaleString('en-GB')}
              </span>
            </li>
          );
        })}
      </ul>
      {more && more > 0 ? <p className="mt-2 text-[11px] text-slate-500">and {more.toLocaleString('en-GB')} more</p> : null}
    </div>
  );
}
