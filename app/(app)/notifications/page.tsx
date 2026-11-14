import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { hrefFor } from '@/lib/notification-links';
import { splitBellCounts } from '@/lib/notification-bell';
import { MarkAllReadButton, MarkInformationReadButton, NotificationRow } from './NotificationList';

export const metadata = { title: 'Notifications · NMWC' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const [notifications, unreadByKind] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      // Named columns: the e-mail outbox columns are no business of the inbox.
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        editId: true,
        customerId: true,
        readAt: true,
        createdAt: true,
        edit: { select: { isReactivation: true } },
      },
    }),
    // Follow-up 1, H16 (bug hunt round 1, finding 9): the unread state, the
    // subtitle and the bulk buttons come from EVERY unread row, counted as the
    // bell counts them (app/(app)/layout.tsx). Read from the 100 rows shown, a
    // person with older unread rows saw "All caught up" and no "Mark all read"
    // while the bell still showed a number, and could not clear it.
    prisma.notification.groupBy({
      by: ['kind'],
      where: { userId: session.user.id, readAt: null },
      _count: { _all: true },
    }),
  ]);
  // F1: the same split as the bell — rows that may ask for action, and rows
  // that only inform (lib/notification-bell.ts).
  const counts = splitBellCounts(
    unreadByKind.map((g) => ({ kind: g.kind, count: g._count._all })),
    session.user.role
  );
  const unread = unreadByKind.reduce((sum, g) => sum + g._count._all, 0);
  const subtitle =
    unread === 0
      ? 'All caught up'
      : [
          ...(counts.action > 0 ? [`${counts.action} unread`] : []),
          ...(counts.information > 0 ? [`${counts.information} for information`] : []),
        ].join(' · ');

  return (
    <main>
      <PageHeader
        title="Notifications"
        subtitle={subtitle}
        actions={
          unread > 0 ? (
            <div className="flex flex-wrap gap-2">
              {counts.information > 0 && <MarkInformationReadButton />}
              <MarkAllReadButton />
            </div>
          ) : undefined
        }
      />
      <div className="p-4 sm:p-6">
        {notifications.length === 0 ? (
          <EmptyState
            title="Nothing here yet"
            description="Approvals, rejections and SLA alerts for you will show up here."
          />
        ) : (
          // grid-cols-1: one column no wider than the phone. An auto column took
          // the width of a whole title, which `truncate` keeps on one line.
          <ul className="grid grid-cols-1 gap-2">
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
