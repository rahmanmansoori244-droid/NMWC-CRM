import { PageHeader } from '@/components/nmwc/PageHeader';

/**
 * PERF (audit #3/#18): shared instant-loading skeleton. A route segment with a
 * loading.tsx paints THIS in ~0ms on click (Next prefetches the shell), hiding
 * the full Oman round trip + server render behind visible feedback instead of a
 * frozen page. Keep it dumb: no data, no client JS.
 */
export function RouteSkeleton({ title, rows = 6 }: { title: string; rows?: number }) {
  return (
    <main>
      <PageHeader title={title} subtitle="Loading…" />
      <div className="space-y-3 p-4 sm:p-6">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-slate-200/60" />
        ))}
      </div>
    </main>
  );
}
