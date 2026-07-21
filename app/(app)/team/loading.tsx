import { RouteSkeleton } from '@/components/nmwc/RouteSkeleton';

// PERF (audit #3/#18): instant skeleton — see components/nmwc/RouteSkeleton.tsx.
export default function Loading() {
  return <RouteSkeleton title="Team" />;
}
