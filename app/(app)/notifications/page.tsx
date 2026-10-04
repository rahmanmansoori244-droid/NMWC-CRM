import { redirect } from 'next/navigation';
import Link from 'next/link';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/nmwc/PageHeader';
import { EmptyState } from '@/components/nmwc/EmptyState';
import { hrefFor } from '@/lib/notification-links';
import { MarkAllReadButton, NotificationRow } from './NotificationList';

export const metadata = { title: 'Notifications · NMWC' };
export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const notifications = await prisma.notification.findMany({
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
