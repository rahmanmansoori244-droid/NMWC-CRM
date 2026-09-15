import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { TopBar } from '@/components/nmwc/TopBar';
import { Sidebar, MobileTabBar } from '@/components/nmwc/Sidebar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  // Bell badge — one indexed count per page render (RSC freshness model; a
  // client poller is a deliberate non-goal on Vercel serverless for v1).
  const unreadCount = await prisma.notification.count({
    where: { userId: session.user.id, readAt: null },
  });

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <TopBar
        user={{
          fullName: session.user.name,
          username: session.user.username,
          role: session.user.role,
        }}
        unreadCount={unreadCount}
      />
      <div className="mx-auto flex w-full max-w-screen-2xl flex-1">
        <Sidebar role={session.user.role} />
        <div
          className={`flex-1 ${session.user.role === 'SALESMAN' ? 'pb-16 md:pb-0' : ''}`}
        >
          {children}
        </div>
      </div>
      <MobileTabBar role={session.user.role} />
    </div>
  );
}
