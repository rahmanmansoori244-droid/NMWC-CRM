import Link from 'next/link';
import type { Route } from 'next';

export type Delta = {
  /** Signed whole percentage against the previous window, or null when there was nothing to compare. */
  pct: number | null;
  /** "vs the 30 days before" */
  against: string;
  /** Whether a rise is good news (new customers) or not (closures); colours the arrow. */
  goodWhenUp?: boolean;
};

/**
 * F2 — one figure in the dashboard's top row. A tile whose query failed says so
 * instead of showing 0, which would read as a real figure.
 */
export function KpiTile({
  label,
  value,
  sub,
  delta,
  href,
  hrefLabel,
  extra,
  failed = false,
}: {
  label: string;
  value: string;
  sub?: string;
  delta?: Delta;
  href?: Route;
  hrefLabel?: string;
  /** A second, related figure under the first (e.g. what waits elsewhere). */
  extra?: React.ReactNode;
  failed?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg bg-white px-3 py-2.5 ring-1 ring-inset ring-slate-200">
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
      {failed ? (
        <div className="mt-1 text-sm text-slate-500" role="status">
          Not available just now
        </div>
      ) : (
        <>
          <div className="text-2xl font-bold tabular-nums text-slate-900">{value}</div>
          {delta && <DeltaLine delta={delta} />}
          {sub && <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{sub}</div>}
          {extra && <div className="mt-0.5 text-[11px] leading-snug text-slate-600">{extra}</div>}
          {href && hrefLabel && (
            <Link href={href} className="mt-1 text-[11px] font-medium text-brand-700 hover:underline">
              {hrefLabel}
            </Link>
          )}
        </>
      )}
    </div>
  );
}

function DeltaLine({ delta }: { delta: Delta }) {
  if (delta.pct === null) {
    return <div className="text-[11px] text-slate-500">none {delta.against.replace(/^vs /, 'in ')}</div>;
  }
  const up = delta.pct > 0;
  const flat = delta.pct === 0;
  const good = up === (delta.goodWhenUp ?? true);
  return (
    <div className="text-[11px] text-slate-600">
      <span aria-hidden="true" className={flat ? 'text-slate-500' : good ? 'text-emerald-700' : 'text-amber-700'}>
        {flat ? '■' : up ? '▲' : '▼'}
      </span>{' '}
      {flat ? 'no change' : `${up ? '+' : ''}${delta.pct}%`} {delta.against}
    </div>
  );
}
