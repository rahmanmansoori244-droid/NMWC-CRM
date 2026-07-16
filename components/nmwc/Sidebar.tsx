'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import type { Role } from '@prisma/client';
import {
  LayoutDashboard,
  Users,
  Map,
  Upload,
  Download,
  ListChecks,
  AlertTriangle,
  Inbox,
  ScrollText,
  CalendarCheck,
  Search,
  Home as HomeIcon,
} from 'lucide-react';

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const NAV_BY_ROLE: Record<Role, NavItem[]> = {
  SALESMAN: [
    { href: '/today', label: 'Today', icon: CalendarCheck },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/work', label: 'Work items', icon: Inbox },
    { href: '/rejected', label: 'Needs correction', icon: AlertTriangle },
  ],
  SUPERVISOR: [
    { href: '/approvals', label: 'Approvals', icon: ListChecks },
    { href: '/team', label: 'My team', icon: Users },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/work', label: 'Work items', icon: Inbox },
  ],
  MANAGER: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/users', label: 'Users', icon: Users },
    { href: '/routes', label: 'Routes & regions', icon: Map },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/reactivations', label: 'Reactivations', icon: AlertTriangle },
    { href: '/audit', label: 'Audit log', icon: ScrollText },
    { href: '/work', label: 'Work items', icon: Inbox },
  ],
  STEWARD: [
    { href: '/import', label: 'Import', icon: Upload },
    { href: '/export', label: 'Export', icon: Download },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/duplicates', label: 'Duplicates', icon: AlertTriangle },
    { href: '/work', label: 'Work items', icon: Inbox },
  ],
  VIEWER: [
    { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/customers', label: 'Customers', icon: Search },
  ],
  ACCOUNTANT: [
    { href: '/approvals', label: 'Approvals', icon: ListChecks },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/work', label: 'Work items', icon: Inbox },
  ],
  FINANCE_MANAGER: [
    { href: '/approvals', label: 'Approvals', icon: ListChecks },
    { href: '/customers', label: 'Customers', icon: Search },
  ],
  GM: [
    { href: '/approvals', label: 'Approvals', icon: ListChecks },
    { href: '/customers', label: 'Customers', icon: Search },
  ],
};

export function Sidebar({ role }: { role: Role }) {
  const pathname = usePathname();
  const items = NAV_BY_ROLE[role] ?? [];
  return (
    <nav className="hidden w-56 shrink-0 border-r border-slate-200 bg-white py-4 md:block">
      <ul className="flex flex-col gap-1 px-2">
        {items.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + '/');
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href as string}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function MobileTabBar({ role }: { role: Role }) {
  const pathname = usePathname();
  // Salesman gets the bottom tab bar; other roles use the desktop sidebar (and hamburger TBD)
  if (role !== 'SALESMAN') return null;
  const items = [
    { href: '/today', label: 'Today', icon: CalendarCheck },
    { href: '/customers', label: 'Customers', icon: Search },
    { href: '/work', label: 'Work', icon: Inbox },
    { href: '/profile', label: 'Me', icon: HomeIcon },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-slate-200 bg-white md:hidden">
      {items.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/');
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href as string}
            className={cn(
              'flex flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium',
              active ? 'text-brand-700' : 'text-slate-600'
            )}
          >
            <Icon className="h-5 w-5" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
