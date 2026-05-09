import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import type { Role } from '@prisma/client';

const HOME_BY_ROLE: Record<Role, string> = {
  SALESMAN: '/today',
  SUPERVISOR: '/approvals',
  MANAGER: '/dashboard',
  STEWARD: '/import',
  VIEWER: '/dashboard',
};

export default async function HomePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  const target = HOME_BY_ROLE[session.user.role] ?? '/customers';
  redirect(target);
}
