import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: skeleton for the steward /duplicates page. Each pair card has two
// columns side-by-side, so make the skeleton blocks taller to roughly
// match the real layout.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Duplicate review" subtitle="Loading…" />
      <div className="space-y-3 p-4 sm:p-6">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-40 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
    </main>
  );
}
