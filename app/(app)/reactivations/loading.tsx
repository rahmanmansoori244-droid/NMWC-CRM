import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: skeleton for the manager /reactivations queue. Real items are
// taller because each shows two evidence photos — bias the skeleton tall.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Reactivation queue" subtitle="Loading…" />
      <div className="space-y-3 p-4 sm:p-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="h-44 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
    </main>
  );
}
