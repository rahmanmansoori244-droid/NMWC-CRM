import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { homeForRole } from '@/lib/role-home';

export default async function RootPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  // perf audit #20: go straight to the role landing page — the old
  // `/` → `/home` → target chain cost an extra full round trip on every entry.
  redirect(homeForRole(session.user.role));
}
