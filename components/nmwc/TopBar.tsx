import Link from 'next/link';
import { Bell } from 'lucide-react';
import { logoutAction } from '@/app/actions/auth';
import type { Role } from '@prisma/client';
import { MobileNavDrawer } from '@/components/nmwc/Sidebar';
import { bellLabel } from '@/lib/notification-bell';

const ROLE_LABEL: Record<Role, string> = {
  SALESMAN: 'Salesman',
  SUPERVISOR: 'Supervisor',
  MANAGER: 'Manager',
  STEWARD: 'Data Steward',
  VIEWER: 'Viewer',
  ACCOUNTANT: 'Accountant',
  FINANCE_MANAGER: 'Finance Manager',
  GM: 'GM',
};

export function TopBar({
  user,
  unreadCount = 0,
  infoCount = 0,
}: {
  user: { fullName?: string | null; username: string; role: Role };
  /** Unread in-app notifications that may ask for action — server-computed per render (RSC model). */
  unreadCount?: number;
  /** Unread information-only notifications (F1 REQUEST_FYI): a muted count, never the red one. */
  infoCount?: number;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-blue-800 bg-brand-900 text-white">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between px-4">
        {/* UAT-02: the only navigation non-salesman roles have on a phone. */}
        <div className="flex items-center gap-1">
          <MobileNavDrawer role={user.role} />
          <Link href="/" className="text-lg font-bold tracking-tight">
            NMWC
          </Link>
        </div>
        <div className="flex items-center gap-4">
          <Link
            href="/notifications"
            aria-label={bellLabel({ action: unreadCount, information: infoCount })}
            className="relative rounded-full p-2 hover:bg-blue-800"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold leading-none">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            ) : infoCount > 0 ? (
              // F1: information only — muted, so the red badge keeps meaning "waits on you".
              <span
                data-bell="information"
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-200 px-1 text-[10px] font-bold leading-none text-blue-900"
              >
                {infoCount > 9 ? '9+' : infoCount}
              </span>
            ) : null}
          </Link>
          <div className="hidden text-right text-xs sm:block">
            <div className="font-semibold">{user.fullName ?? user.username}</div>
            <div className="text-blue-200">{ROLE_LABEL[user.role]}</div>
          </div>
          <form action={logoutAction}>
            <button
              type="submit"
              className="rounded-md bg-blue-800 px-3 py-1.5 text-xs font-medium text-white ring-1 ring-blue-700 hover:bg-blue-700"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
