import type { Route } from 'next';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Role } from '@prisma/client';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { MarkAllReadButton, NotificationRow } from './NotificationList';

export const metadata = { title: 'Notifications · NMWC' };
export const dynamic = 'force-dynamic';

/** Roles allowed onto /approvals/[id] — mirror of the detail page's gate. */
const APPROVER_ROLES: Role[] = [
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

/**
 * Deep link per notification, kind- and role-aware:
 *  - review-request kinds route APPROVERS to the edit's review page (the
 *    customer profile has a DIFFERENT scope gate and may 404 on a reviewer
 *    who legitimately received the ping — adversarial-review fix);
 *  - everything else lands on the customer profile / the recipient's queue.
 *
 * The return type is checked against the app's routes: any static page, or one
 * of the two dynamic pages named here.
 */
function hrefFor(
  n: { editId: string | null; customerId: string | null; kind: string },
  role: Role
): Route<`/approvals/${string}` | `/customers/${string}`> {
  if (n.kind === 'TEMIX_UPLOAD_READY') return '/temix';
  const reviewKinds = ['EDIT_SUBMITTED', 'EDIT_STAGE_ADVANCED', 'SLA_BREACH'];
  if (n.editId && reviewKinds.includes(n.kind) && APPROVER_ROLES.includes(role)) {
    return `/approvals/${n.editId}`;
  }
  if (n.customerId) return `/customers/${n.customerId}`;
  return '/work';
}

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const notifications = await prisma.notification.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <main>
      <PageHeader
        title="Notifications"
        subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}
        actions={unread > 0 ? <MarkAllReadButton /> : undefined}
      />
      <div className="p-4 sm:p-6">
        {notifications.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description="Approvals, rejections and SLA alerts for you will show up here."
          />
        ) : (
          <ul className="grid gap-2">
            {notifications.map((n) => (
              <li key={n.id}>
                <Link href={hrefFor(n, session.user.role)} className="block">
                  <NotificationRow
                    id={n.id}
                    title={n.title}
                    body={n.body}
                    kind={n.kind}
                    createdAt={n.createdAt.toISOString()}
                    unread={!n.readAt}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
