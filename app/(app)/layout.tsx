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
        {/* --nmwc-tabbar-h is how much of the screen bottom MobileTabBar covers
            (its h-14 below md, nothing from md). The forms' sticky Submit bars
            sit at bottom-[var(--nmwc-tabbar-h,0px)]: at bottom-0 a salesman's
            Submit was 70% under the tab bar, and a tap on it hit "Today" and
            left the form (production walk, 2026-10-05). Other roles have no
            tab bar, so the variable is unset and the bars stay at 0. */}
        <div
          className={`flex-1 ${session.user.role === 'SALESMAN' ? 'pb-16 md:pb-0 [--nmwc-tabbar-h:3.5rem] md:[--nmwc-tabbar-h:0px]' : ''}`}
        >
          {children}
        </div>
      </div>
      <MobileTabBar role={session.user.role} />
    </div>
  );
}
