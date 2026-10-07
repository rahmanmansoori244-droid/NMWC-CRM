/**
 * The audit log is offered in the menu to exactly the roles its page admits.
 *
 * RBAC-05-007 opened app/(app)/audit/page.tsx to the Steward (the global log; a
 * Manager's is regional), but only the Manager's menu linked to it, so the
 * Steward could reach it only by typing the address. A page is reachable only if
 * the menu offers it, and nothing else ties the two together — the same gap
 * tests/unit/status-page.test.tsx closes for Service status.
 *
 * "Admits" is not a hand-kept list here: the page is rendered as every role, with
 * its session and database mocked, and a role it sends to /home is one it
 * refuses. The phone drawer reads the same NAV_BY_ROLE as the desktop sidebar;
 * both are rendered for the Steward so that stays true.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Role } from '@prisma/client';

const h = vi.hoisted(() => ({ role: 'STEWARD' }));

vi.mock('@/lib/auth', () => ({
  auth: async () => ({ user: { id: 'u', role: h.role, username: 'u' } }),
}));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['r-north'] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  usePathname: () => '/customers',
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/db', () => ({
  prisma: {
    auditLog: { count: async () => 0, findMany: async () => [] },
    customer: { findMany: async () => [] },
    branch: { findMany: async () => [] },
    // A Manager's log reads through lib/audit-scope.ts: his people, then raw SQL.
    user: { findMany: async () => [] },
    $queryRaw: async () => [],
  },
}));

import AuditPage from '@/app/(app)/audit/page';
import { NAV_BY_ROLE, Sidebar, MobileNavDrawer } from '@/components/nmwc/Sidebar';

afterEach(cleanup);

async function pageAdmits(role: string): Promise<boolean> {
  h.role = role;
  try {
    render(await AuditPage({ searchParams: Promise.resolve({}) }));
  } catch (e) {
    if (String(e).includes('REDIRECT /home')) return false;
    throw e;
  }
  expect(screen.getByRole('heading', { name: 'Audit log' })).toBeTruthy();
  return true;
}

describe('the menu offers the audit log to exactly the roles the page admits', () => {
  it.each(Object.keys(NAV_BY_ROLE))('%s', async (role) => {
    const offered = NAV_BY_ROLE[role as Role].some((i) => i.href === '/audit');
    expect(offered).toBe(await pageAdmits(role));
  });

  it('the Steward is among them', async () => {
    expect(await pageAdmits('STEWARD')).toBe(true);
  });
});

describe("the Steward's Audit log link is in both navigations", () => {
  it('desktop sidebar', () => {
    render(<Sidebar role="STEWARD" />);
    expect(screen.getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe('/audit');
  });

  it('phone drawer', () => {
    render(<MobileNavDrawer role="STEWARD" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open menu' }));
    const drawer = screen.getByRole('navigation');
    expect(within(drawer).getByRole('link', { name: 'Audit log' }).getAttribute('href')).toBe(
      '/audit'
    );
  });
});
