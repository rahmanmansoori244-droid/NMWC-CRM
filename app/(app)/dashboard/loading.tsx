import { PageHeader } from '@/components/nmwc/PageHeader';

// F2: skeleton for /dashboard, mirroring the page — the filter bar, seven
// figures, then the cards two by two with the wide ones (What stands out, the
// map, the gaps) across both columns, in the page's order.
const CARDS: Array<{ wide?: boolean; tall?: boolean }> = [
  { wide: true },
  { tall: true },
  { tall: true },
  {},
  {},
  { wide: true, tall: true },
  { wide: true },
  {},
  {},
  {},
];

export default function Loading() {
  return (
    <main aria-busy="true">
      <PageHeader title="Dashboard" subtitle="Loading…" />
      <div className="flex flex-wrap gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-9 w-20 animate-pulse rounded-md bg-slate-200/60" />
        ))}
      </div>
      <div className="space-y-4 p-4 sm:p-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-200/60" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {CARDS.map((c, i) => (
            <div
              key={i}
              className={`animate-pulse rounded-lg bg-slate-200/60 ${c.wide ? 'lg:col-span-2' : ''} ${
                c.tall ? 'h-80' : c.wide ? 'h-32' : 'h-56'
              }`}
            />
          ))}
        </div>
      </div>
    </main>
  );
}
