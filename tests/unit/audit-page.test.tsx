/**
 * Launch fix (2026-10-07): /audit — a Manager's scope, the entity filter, and
 * ?actor= kept on Apply.
 *
 * What was wrong:
 *   - a Manager's filter was region-scoped Customer and Branch rows OR every
 *     User and ImportBatch row, built from two IN lists of every customer id and
 *     every branch id of his regions: his regions' request decisions and Region
 *     and Route rows were hidden, every other region's people changes and every
 *     import were shown (lib/audit-scope.ts; the SQL itself is held to real
 *     Postgres by tests/integration/audit-manager-scope.test.ts);
 *   - the entity filter offered seven types, missing Region, Route, the Temix
 *     batches, duplicate pairs, import rows and the operator runs;
 *   - ?actor= was supported but had no control, and Apply dropped it.
 *
 * The page is rendered with its session and database mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { stripComments } from '../support/strip-comments';

type Log = { id: string; actorId: string; at: Date; action: string; entityType: string; entityId: string; reason: string | null; actor: { fullName: string; username: string } };
const h = vi.hoisted(() => ({
  role: 'STEWARD',
  regions: ['g-mine'] as string[],
  logs: [] as Log[],
  raw: [] as string[],
  count: vi.fn(),
  findMany: vi.fn(),
  customerFindMany: vi.fn(),
  branchFindMany: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: 'me', role: h.role, username: 'me' } }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.regions }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
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
    auditLog: { count: h.count, findMany: h.findMany },
    customer: { findMany: h.customerFindMany },
    branch: { findMany: h.branchFindMany },
    user: {
      findMany: async () => [
        { id: 'me', role: 'MANAGER', supervisorId: null, ownedRoute: null, reports: [], managedRegions: [{ id: 'g-mine' }] },
        { id: 'sm-mine', role: 'SALESMAN', supervisorId: 'me', ownedRoute: { regionId: 'g-mine' }, reports: [], managedRegions: [] },
        { id: 'sm-other', role: 'SALESMAN', supervisorId: null, ownedRoute: { regionId: 'g-other' }, reports: [], managedRegions: [] },
      ],
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // A tagged template: the fixed text, and the composed Prisma.sql fragments
      // (whose own text and bound values are read through .sql and .values).
      const show = (v: unknown) => {
        const sql = v as { sql?: unknown; values?: unknown[] } | null;
        return sql && typeof sql.sql === 'string' ? `${sql.sql} ${JSON.stringify(sql.values)}` : JSON.stringify(v);
      };
      const text = strings.join('?') + ' ' + values.map(show).join(' ');
      h.raw.push(text);
      if (text.includes('count(*)')) return [{ n: h.logs.length }];
      return h.logs.map((l) => ({ id: l.id }));
    },
  },
}));

import AuditPage from '@/app/(app)/audit/page';
import { AUDIT_ENTITY_TYPES, MANAGER_AUDIT_ENTITY_TYPES } from '@/lib/audit-scope';

const log = (id: string, actorId: string, fullName: string): Log => ({
  id,
  actorId,
  at: new Date('2026-10-01T08:00:00Z'),
  action: 'APPROVE',
  entityType: 'CustomerEdit',
  entityId: `edit-${id}`,
  reason: null,
  actor: { fullName, username: actorId },
});

beforeEach(() => {
  vi.clearAllMocks();
  h.role = 'STEWARD';
  h.regions = ['g-mine'];
  h.raw = [];
  h.logs = [log('l1', 'u-ali', 'Ali Salesman')];
  h.count.mockImplementation(async () => h.logs.length);
  h.findMany.mockImplementation(async () => h.logs);
});
afterEach(cleanup);

const open = async (sp: Record<string, string> = {}) => render(await AuditPage({ searchParams: Promise.resolve(sp) }));
const options = () =>
  [...(document.querySelector('select[name="entityType"]') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);

describe('/audit entity filter', () => {
  it('the Steward can pick every type the log holds', async () => {
    await open();
    expect(options()).toEqual([...AUDIT_ENTITY_TYPES]);
    for (const t of ['Region', 'Route', 'TemixSyncBatch', 'CustomerPair', 'ImportRow', 'VisitDaysFromSheets']) {
      expect(options()).toContain(t);
    }
  });

  it('a type from the address that the list lacks is kept, so Apply does not drop it', async () => {
    await open({ entityType: 'SomethingNew' });
    expect(options()).toContain('SomethingNew');
    expect((document.querySelector('select[name="entityType"]') as HTMLSelectElement).value).toBe('SomethingNew');
  });

  it('a Manager is offered only the types his log can show', async () => {
    h.role = 'MANAGER';
    await open();
    expect(options()).toEqual([...MANAGER_AUDIT_ENTITY_TYPES]);
    expect(options()).not.toContain('ImportBatch');
  });
});

describe('/audit ?actor=', () => {
  it('rides along on Apply, is named, and can be cleared', async () => {
    await open({ actor: 'u-ali', entityType: 'CustomerEdit' });
    const hidden = document.querySelector('input[type="hidden"][name="actor"]') as HTMLInputElement;
    expect(hidden.value).toBe('u-ali');
    expect(screen.getByText(/Showing what/).textContent).toContain('Ali Salesman');
    expect(screen.getByRole('link', { name: 'Show everyone' }).getAttribute('href')).toBe('?entityType=CustomerEdit');
    expect(h.count).toHaveBeenCalledWith({ where: { actorId: 'u-ali', entityType: 'CustomerEdit' } });
  });

  it('every actor cell sets it', async () => {
    await open();
    expect(screen.getByRole('link', { name: 'Ali Salesman' }).getAttribute('href')).toBe('?actor=u-ali');
    expect(document.querySelector('input[type="hidden"][name="actor"]')).toBeNull();
  });
});

describe('/audit for a Manager', () => {
  it('reads through the regional scope, not two IN lists of every customer and branch', async () => {
    h.role = 'MANAGER';
    await open({ actor: 'sm-mine' });
    expect(h.customerFindMany).not.toHaveBeenCalled();
    expect(h.branchFindMany).not.toHaveBeenCalled();
    expect(h.count).not.toHaveBeenCalled();
    const sql = h.raw.join('\n');
    expect(sql).toContain('CustomerEdit');
    expect(sql).toContain("'Region'");
    expect(sql).toContain("'Route'");
    expect(sql).not.toContain('ImportBatch');
    // His people: his own account and his region's salesman, not the other region's.
    expect(sql).toContain('sm-mine');
    expect(sql).not.toContain('sm-other');
    expect(screen.getByText('Ali Salesman')).toBeTruthy();
  });

  it('a Manager with no regions sees nothing and nothing is read', async () => {
    h.role = 'MANAGER';
    h.regions = [];
    await open();
    expect(h.raw).toEqual([]);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(screen.getByText('0 matching events')).toBeTruthy();
  });
});

describe('the Steward’s filter lists every entity type the code writes to the audit log', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === 'node_modules' ? [] : sources(full);
      return /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }
  it('no writer names a type the filter lacks', () => {
    const written = new Set<string>();
    for (const dir of ['app', 'services', 'lib', 'scripts', 'prisma']) {
      for (const file of sources(dir)) {
        const src = stripComments(readFileSync(file, 'utf8'), file);
        for (const m of src.matchAll(/entityType:\s*['"`]([A-Za-z]+)['"`]/g)) written.add(m[1]!);
        for (const m of src.matchAll(/LEDGER_ENTITY\s*=\s*['"`]([A-Za-z]+)['"`]/g)) written.add(m[1]!);
      }
    }
    expect(written.size).toBeGreaterThan(10);
    const missing = [...written].filter((t) => !(AUDIT_ENTITY_TYPES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
    for (const t of MANAGER_AUDIT_ENTITY_TYPES) expect(AUDIT_ENTITY_TYPES).toContain(t);
  });
});
