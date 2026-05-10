import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: skeleton for the salesman /today route. Mirrors the real page —
// greeting header, 3 stat tiles, then 6 visit cards.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Loading your day…" subtitle="One moment" />
      <div className="grid grid-cols-3 gap-2 px-4 pt-4 sm:gap-3 sm:px-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="h-16 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
      <section className="px-4 py-4 sm:px-6">
        <div className="mb-3 h-5 w-48 animate-pulse rounded bg-slate-200/60" />
        <div className="grid gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-20 animate-pulse rounded-lg bg-slate-200/60"
            />
          ))}
        </div>
      </section>
    </main>
  );
}
