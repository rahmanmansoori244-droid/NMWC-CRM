import { Swatch } from './InsightCard';

export type ColumnSeries = { key: string; label: string; color: string };
export type ColumnPoint = {
  key: string;
  /** Axis and tooltip label for the bucket ("5 Oct", "Oct 2026"). */
  label: string;
  /** One value per series, in series order; stacked bottom-up. */
  values: number[];
  /** The bucket is cut by the window (a first or last week or month). */
  partial?: boolean;
};

/**
 * F2 — a stacked column chart over time, as plain HTML: no library, no script,
 * nothing for the CSP to refuse, and it reflows on a phone (an SVG viewBox would
 * shrink its own labels instead).
 *
 * Columns are at most 24px wide and grow from one baseline; stacked segments sit
 * 2px apart; every column carries a native tooltip; a legend names each series
 * with its total; and "Show the numbers" lists every bucket, so nothing depends
 * on telling colours apart or on hovering.
 */
export function ColumnChart({
  series,
  points,
  unit,
  emptyText,
  legendTotals = true,
}: {
  series: ColumnSeries[];
  points: ColumnPoint[];
  /** "new customers" — used in the tooltip and the numbers list. */
  unit: string;
  emptyText: string;
  /**
   * Print each series' total in the legend. Off when the bars are not additive
   * (distinct customers per bucket: one customer can sit in two bars).
   */
  legendTotals?: boolean;
}) {
  const totals = series.map((_, i) => points.reduce((s, p) => s + (p.values[i] ?? 0), 0));
  const max = Math.max(0, ...points.map((p) => p.values.reduce((s, v) => s + v, 0)));
  if (points.length === 0) return <p className="text-sm text-slate-500">{emptyText}</p>;
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  const describe = (p: ColumnPoint) => {
    const sum = p.values.reduce((s, v) => s + v, 0);
    const parts = series.length > 1 ? ` (${series.map((s, i) => `${p.values[i] ?? 0} ${s.label.toLowerCase()}`).join(', ')})` : '';
    return `${p.label}${p.partial ? ' (part of the period)' : ''}: ${sum.toLocaleString('en-GB')} ${unit}${parts}`;
  };

  return (
    <div>
      {series.length > 1 && (
        <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
          {series.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              <Swatch color={s.color} />
              {s.label}
              {legendTotals && (
                <span className="font-semibold tabular-nums text-slate-800">{totals[i]!.toLocaleString('en-GB')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {max === 0 ? (
        <p className="text-sm text-slate-500">{emptyText}</p>
      ) : (
        <div className="flex gap-2">
          <div className="flex h-36 flex-col justify-between text-right text-[10px] tabular-nums text-slate-400" aria-hidden="true">
            <span>{max.toLocaleString('en-GB')}</span>
            <span>0</span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex h-36 items-end gap-[2px] border-b border-slate-200" aria-hidden="true">
              {points.map((p) => {
                const sum = p.values.reduce((s, v) => s + v, 0);
                return (
                  <div key={p.key} className="flex h-full min-w-0 flex-1 items-end justify-center" title={describe(p)}>
                    <div
                      className="flex w-full max-w-[24px] flex-col-reverse gap-[2px]"
                      style={{ height: `${(sum / max) * 100}%`, minHeight: sum > 0 ? 2 : 0 }}
                    >
                      {series.map((s, i) => {
                        const v = p.values[i] ?? 0;
                        if (v <= 0) return null;
                        return (
                          <div
                            key={s.key}
                            className="w-full last:rounded-t"
                            style={{ flexGrow: v, flexBasis: 0, minHeight: 2, backgroundColor: s.color, opacity: p.partial ? 0.6 : 1 }}
                          />
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex gap-[2px] text-[10px] text-slate-500" aria-hidden="true">
              {points.map((p, i) => (
                <div key={p.key} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
                  {i % labelEvery === 0 ? p.label : ''}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      <details className="mt-3 text-xs text-slate-600">
        <summary className="cursor-pointer select-none font-medium text-slate-700">Show the numbers</summary>
        <ul className="mt-2 max-h-48 space-y-0.5 overflow-y-auto tabular-nums">
          {points.map((p) => (
            <li key={p.key}>{describe(p)}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
