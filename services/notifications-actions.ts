'use server';

/**
 * Notification inbox actions (Phase 1 SLA/notifications increment).
 * Every query is pinned to the CALLER's userId — a notification id from
 * another user's inbox can never be marked or read across accounts.
 */
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { revalidatePath } from 'next/cache';

async function requireUser() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  return session.user;
}

export async function markNotificationReadAction(formData: FormData): SafeAction<void> {
  return runAction(async () => {
    const me = await requireUser();
    const id = String(formData.get('id') ?? '');
    if (!id) throw new ValidationError({ id: 'required' });
    await prisma.notification.updateMany({
      where: { id, userId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    // perf audit #35: NO revalidatePath here. This action fires as the user
    // clicks THROUGH to the deep link — revalidating made the action response
    // re-render the 100-row inbox that is being navigated away from, racing the
    // navigation for zero visible benefit. The inbox re-fetches fresh on its
    // next real visit; mark-all (below) still revalidates because the user
    // stays on the page and needs the immediate repaint.
  });
}

export async function markAllNotificationsReadAction(): SafeAction<{ marked: number }> {
  return runAction(async () => {
    const me = await requireUser();
    const res = await prisma.notification.updateMany({
      where: { userId: me.id, readAt: null },
      data: { readAt: new Date() },
    });
    revalidatePath('/notifications');
    return { marked: res.count };
  });
}
