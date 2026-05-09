/**
 * Session helpers used in server components and server actions.
 */
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Role } from '@prisma/client';
import type { SessionUser } from '@/lib/permissions';
import { ForbiddenError } from '@/lib/errors';

export async function requireSession(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) redirect('/login');
  return {
    id: session.user.id,
    role: session.user.role,
    username: session.user.username,
  };
}

export async function requireRole(allowed: Role[]): Promise<SessionUser> {
  const user = await requireSession();
  if (!allowed.includes(user.role)) {
    throw new ForbiddenError(`Role ${user.role} not allowed.`);
  }
  return user;
}
