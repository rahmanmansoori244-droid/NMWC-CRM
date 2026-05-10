import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: rendered instantly by Next while the page's data fetches resolve.
// Matches the real /customers layout: header + filter strip + 8 card rows.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Customers" subtitle="Loading…" />
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
        <div className="h-10 w-full max-w-md animate-pulse rounded-md bg-slate-200/60" />
        <div className="h-10 w-32 animate-pulse rounded-md bg-slate-200/60" />
        <div className="h-10 w-20 animate-pulse rounded-md bg-slate-200/60" />
      </div>
      <section className="px-4 py-4 sm:px-6">
        <div className="grid gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
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
