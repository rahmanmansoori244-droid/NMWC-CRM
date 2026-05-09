import { ComingSoon } from '@/components/nmwc/ComingSoon';
export const metadata = { title: 'Approvals · NMWC' };
export default function Page() {
  return (
    <ComingSoon
      title="Approvals"
      milestone="Milestone 5"
      description="Supervisor approval queue with side-by-side diff view ships in M5. Use Work items in the meantime to see pending submissions."
    />
  );
}
