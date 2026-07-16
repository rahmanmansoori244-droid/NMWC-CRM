import Link from 'next/link';
import { logoutAction } from '@/app/actions/auth';
import type { Role } from '@prisma/client';

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
}: {
  user: { fullName?: string | null; username: string; role: Role };
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-blue-800 bg-brand-900 text-white">
      <div className="mx-auto flex h-14 max-w-screen-2xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          NMWC
        </Link>
        <div className="flex items-center gap-4">
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
