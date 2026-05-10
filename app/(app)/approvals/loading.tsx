import { PageHeader } from '@/components/nmwc/PageHeader';

// P3.5: skeleton for the supervisor / manager /approvals queue. Loads
// instantly while the queue data + scope check resolve.
export default function Loading() {
  return (
    <main>
      <PageHeader title="Approval queue" subtitle="Loading…" />
      <div className="space-y-3 p-4 sm:p-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-lg bg-slate-200/60"
          />
        ))}
      </div>
    </main>
  );
}
