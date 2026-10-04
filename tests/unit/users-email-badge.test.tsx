/**
 * F1 (2026-10-05): /users says whether an account has an e-mail on file and
 * lets the Steward set or clear it, without the address ever reaching the page
 * (RBAC-05-023 keeps e-mail and phone off the listing).
 *
 * The page is rendered with its session and database mocked; the mocked query
 * honours the page's `select`, so the badge depends on the page really reading
 * the column. The row-actions client component is replaced by a probe that
 * records its props, which is exactly what the server serialises to the browser.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';

const h = vi.hoisted(() => ({
  user: { id: 'stw', role: 'STEWARD', username: 'steward.x' },
  rows: [] as Array<Record<string, unknown>>,
  rowProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.user }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: ['g1'] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('@/app/(app)/users/UserRowActions', () => ({
  UserRowActions: (props: Record<string, unknown>) => {
    h.rowProps.push(props);
    return null;
  },
  UsersFeedback: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock('@/app/(app)/users/CreateUserForm', () => ({ CreateUserForm: () => null }));

function project(row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const nested = row[k] as Record<string, unknown> | Array<Record<string, unknown>> | null | undefined;
      const inner = (v as { select: Record<string, unknown> }).select;
      out[k] = nested == null ? nested : Array.isArray(nested) ? nested.map((n) => project(n, inner)) : project(nested, inner);
    }
  }
  return out;
}
vi.mock('@/lib/db', () => ({
  prisma: {
    user: {
      findMany: async (args: { select: Record<string, unknown> }) => h.rows.map((r) => project(r, args.select)),
    },
    route: { findMany: async () => [] },
  },
}));

import UsersPage from '@/app/(app)/users/page';

const ADDRESS = 'accounts.north@example.test';

function account(id: string, role: string, email: string | null, over: Record<string, unknown> = {}) {
  return {
    id,
    username: id,
    fullName: `Person ${id}`,
    role,
    isActive: true,
    lastLoginAt: null,
    mustChangePassword: false,
    email,
    ownedRouteId: null,
    supervisorId: null,
    supervisor: null,
    ownedRoute: null,
    reports: [],
    managedRegions: [{ id: 'g1' }],
    ...over,
  };
}

beforeEach(() => {
  h.user = { id: 'stw', role: 'STEWARD', username: 'steward.x' };
  h.rowProps = [];
  h.rows = [
    account('stw', 'STEWARD', 'steward.own@example.test'),
    account('acc', 'ACCOUNTANT', ADDRESS),
    account('fm', 'FINANCE_MANAGER', null),
    account('sal', 'SALESMAN', null, {
      ownedRouteId: 'r1',
      ownedRoute: { code: 'R1', name: 'Route 1', regionId: 'g1' },
      managedRegions: [],
    }),
  ];
});
afterEach(cleanup);

describe('/users and e-mail addresses', () => {
  it('shows a badge where an address is on file, and never the address', async () => {
    const { container } = render(await UsersPage({ searchParams: Promise.resolve({}) }));
    const html = container.innerHTML;
    expect(html).not.toContain(ADDRESS);
    expect(html).not.toContain('steward.own@example.test');
    expect(container.textContent).toContain('E-mail on file');
    expect(container.querySelectorAll('span[title^="An e-mail address is on file"]')).toHaveLength(2);
  });

  it('hands the row actions a boolean, never the address', async () => {
    render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(JSON.stringify(h.rowProps)).not.toContain('@');
    const acc = h.rowProps.find((p) => p.userId === 'acc')!;
    expect(acc).toMatchObject({ hasEmail: true, canEditEmail: true });
    expect(h.rowProps.find((p) => p.userId === 'fm')).toMatchObject({ hasEmail: false, canEditEmail: true });
  });

  it('the Steward is not offered his own address here; a Manager is offered none', async () => {
    render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(h.rowProps.find((p) => p.userId === 'stw')).toMatchObject({ canEditEmail: false });

    cleanup();
    h.rowProps = [];
    h.user = { id: 'mgr', role: 'MANAGER', username: 'manager.x' };
    h.rows.push(account('mgr', 'MANAGER', null));
    render(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(h.rowProps.length).toBeGreaterThan(0);
    for (const p of h.rowProps) expect(p.canEditEmail).toBe(false);
  });
});
