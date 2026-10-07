/**
 * Launch fix (2026-10-07): every role can reach Change password from its menu,
 * and Export is offered to exactly the roles the export page admits.
 *
 * What was wrong: only the salesman's phone tab bar linked /profile ('Me').
 * Managers, approvers, Stewards and Viewers — every one of them starting on a
 * shared temporary password — could change it only by typing the address. And
 * /export admits MANAGER, VIEWER and SUPERVISOR (lib/permissions.ts canExport),
 * but only the Steward's menu linked it.
 *
 * "Admits" is not a hand-kept list here, as in audit-menu.test.tsx: the export
 * page is rendered as every role with its session and database mocked, and a
 * role it sends to /home is one it refuses. The phone drawer reads the same
 * NAV_BY_ROLE as the desktop sidebar; both are rendered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Role } from '@prisma/client';

const h = vi.hoisted(() => ({ role: 'STEWARD' }));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u', role: h.role, username: 'u' } }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/customers',
}));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    region: { findMany: async () => [] },
    route: { findMany: async () => [] },
    user: { findMany: async () => [] },
  },
}));

import ExportPage from '@/app/(app)/export/page';
import { NAV_BY_ROLE, Sidebar, MobileNavDrawer, MobileTabBar } from '@/components/nmwc/Sidebar';

afterEach(cleanup);

const ROLES = Object.keys(NAV_BY_ROLE) as Role[];

async function exportAdmits(role: string): Promise<boolean> {
  h.role = role;
  try {
    render(await ExportPage());
  } catch (e) {
    if (String(e).includes('REDIRECT /home')) return false;
    throw e;
  }
  expect(screen.getByRole('heading', { name: 'Export to Excel' })).toBeTruthy();
  return true;
}

describe('every role reaches Change password from its menu', () => {
  it.each(ROLES)('%s: desktop sidebar', (role) => {
    render(<Sidebar role={role} />);
    expect(screen.getByRole('link', { name: 'Change password' }).getAttribute('href')).toBe('/profile/change-password');
  });

  it.each(ROLES.filter((r) => r !== 'SALESMAN'))('%s: phone drawer', (role) => {
    render(<MobileNavDrawer role={role} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = screen.getByRole('navigation');
    expect(within(drawer).getByRole('link', { name: 'Change password' }).getAttribute('href')).toBe(
      '/profile/change-password'
    );
  });

  it('SALESMAN: the phone tab bar keeps Me, the profile page with its Change password button', () => {
    render(<MobileTabBar role="SALESMAN" />);
    expect(screen.getByRole('link', { name: 'Me' }).getAttribute('href')).toBe('/profile');
  });
});

describe('the menu offers Export to exactly the roles the export page admits', () => {
  it.each(ROLES)('%s', async (role) => {
    const offered = NAV_BY_ROLE[role].some((i) => i.href === '/export');
    expect(offered).toBe(await exportAdmits(role));
  });

  it('a Manager finds it in the phone drawer', () => {
    render(<MobileNavDrawer role="MANAGER" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    expect(within(screen.getByRole('navigation')).getByRole('link', { name: 'Export' }).getAttribute('href')).toBe(
      '/export'
    );
  });
});
