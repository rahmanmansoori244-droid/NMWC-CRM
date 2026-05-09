import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { TopBar } from '@/components/nmwc/TopBar';
import { Sidebar, MobileTabBar } from '@/components/nmwc/Sidebar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <TopBar
        user={{
          fullName: session.user.name,
          username: session.user.username,
          role: session.user.role,
        }}
      />
      <div className="mx-auto flex w-full max-w-screen-2xl flex-1">
        <Sidebar role={session.user.role} />
        <div className="flex-1 pb-16 md:pb-0">{children}</div>
      </div>
      <MobileTabBar role={session.user.role} />
    </div>
  );
}
