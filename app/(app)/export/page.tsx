import { ComingSoon } from '@/components/nmwc/ComingSoon';
export const metadata = { title: 'Export · NMWC' };
export default function Page() {
  return (
    <ComingSoon
      title="Export to Excel"
      milestone="Milestone 7"
      description="Filter by region/route/status/completeness and download an Excel of the customer master. Comes in M7 alongside the duplicate review tool."
    />
  );
}
