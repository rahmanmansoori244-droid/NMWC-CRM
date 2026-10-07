'use server';

/**
 * Notification inbox actions (Phase 1 SLA/notifications increment).
 * Every query is pinned to the CALLER's userId — a notification id from
 * another user's inbox can never be marked or read across accounts.
 */
import { prisma } from '@/lib/db';
import { requireActor } from '@/lib/session';
import { bellInformationKinds } from '@/lib/notify-policy';
import { ValidationError, runAction, type SafeAction } from '@/lib/errors';
import { revalidatePath } from 'next/cache';

async function requireUser() {
  return requireActor(); // F15: refuses a session that must change its password
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

/**
 * F1 fixer review (2026-10-05): mark the caller's unread information-only rows
 * (REQUEST_FYI) read, and nothing else. "Mark all read" also marks his unread
 * must-act rows read, and a read row is never e-mailed (SKIPPED_READ): clearing
 * the FYI noise must not cost him the e-mail that asks him to act. The kinds are
 * his role's, the same the bell counts apart (a salesman's progress pings too).
 */
export async function markInformationReadAction(): SafeAction<{ marked: number }> {
  return runAction(async () => {
    const me = await requireUser();
    const res = await prisma.notification.updateMany({
      where: { userId: me.id, readAt: null, kind: { in: [...bellInformationKinds(me.role)] } },
      data: { readAt: new Date() },
    });
    revalidatePath('/notifications');
    return { marked: res.count };
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
