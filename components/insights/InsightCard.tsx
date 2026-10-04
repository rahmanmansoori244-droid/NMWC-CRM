/**
 * F2 — one dashboard card: a title, the definition of what it counts (always on
 * screen, never only in a tooltip), and its body — or, when the query behind it
 * failed, a short notice in its place. One failed card never takes the page with
 * it (lib/insights/load.ts).
 */
export function InsightCard({
  title,
  definition,
  failed = false,
  wide = false,
  children,
  footer,
}: {
  title: string;
  definition: React.ReactNode;
  failed?: boolean;
  wide?: boolean;
  children?: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const id = `insight-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
  return (
    <section
      aria-labelledby={id}
      className={`flex min-w-0 flex-col rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 sm:p-5 ${
        wide ? 'lg:col-span-2' : ''
      }`}
    >
      <h2 id={id} className="text-sm font-semibold text-slate-900">
        {title}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">{definition}</p>
      <div className="mt-4 min-w-0 flex-1">
        {failed ? <CardUnavailable /> : children}
      </div>
      {footer && !failed && <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">{footer}</div>}
    </section>
  );
}

export function CardUnavailable() {
  return (
    <p role="status" className="rounded-md bg-slate-50 p-3 text-sm text-slate-600 ring-1 ring-slate-200">
      This card could not be loaded just now. The rest of the page is unaffected; reload the page to try again.
    </p>
  );
}

/** A small swatch that carries a series' identity beside its (text-coloured) label. */
export function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );
}
