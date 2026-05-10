import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: skeleton for /dashboard. Mirrors the real layout — 7 KPI tiles
// followed by 4 chart cards in a 2x2 grid.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Dashboard" subtitle="Loading…" />
      <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-6 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
      <div className="grid gap-4 px-4 pb-6 sm:px-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-56 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
    </main>
  );
}
