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
 * Owner decisions 2026-10-11: photo views (PHOTO_VIEW) are left out of the
 * Steward's default list and its count, and shown when he picks that action; a
 * customer filter (an NMWC or Temix code) shows who opened that customer's photos
 * and documents. Neither reaches a Manager.
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
  /** What the customer filter's code lookup answers (lib/audit-scope.ts auditCustomersByCode). */
  customers: [] as Array<{ id: string; nmwcCode: string; temixCode: string | null; archived: boolean }>,
  /** What the documents query answers (customerDocumentIds). */
  docs: [] as string[],
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
      if (text.includes('FROM "Customer" c')) return h.customers;
      if (text.includes('FROM "Attachment" t')) return h.docs.map((id) => ({ id }));
      if (text.includes('count(*)')) return [{ n: h.logs.length }];
      return h.logs.map((l) => ({ id: l.id }));
    },
  },
}));

import AuditPage from '@/app/(app)/audit/page';
import {
  AUDIT_ENTITY_TYPES,
  MANAGER_AUDIT_ACTIONS,
  MANAGER_AUDIT_ENTITY_TYPES,
  STEWARD_HIDDEN_BY_DEFAULT,
} from '@/lib/audit-scope';
import { AuditAction, Role } from '@prisma/client';

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
  h.customers = [];
  h.docs = [];
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

describe('/audit filters are named', () => {
  it('launch browser suite: every filter is found by its label', async () => {
    // The search box had only a placeholder and the two selects only a first
    // option: a screen reader read three unnamed fields, and getByLabel found none.
    await open({ q: 'edit-1', action: 'APPROVE', entityType: 'CustomerEdit' });
    expect((screen.getByLabelText('Entity ID contains') as HTMLInputElement).value).toBe('edit-1');
    expect((screen.getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).value).toBe('APPROVE');
    expect((screen.getByRole('combobox', { name: 'Entity type' }) as HTMLSelectElement).value).toBe('CustomerEdit');
    expect(screen.getByLabelText('Entity ID contains').getAttribute('name')).toBe('q');
    expect(screen.getByLabelText('Action').getAttribute('name')).toBe('action');
    expect(screen.getByLabelText('Entity type').getAttribute('name')).toBe('entityType');
  });
});

describe('/audit ?actor=', () => {
  it('rides along on Apply, is named, and can be cleared', async () => {
    await open({ actor: 'u-ali', entityType: 'CustomerEdit' });
    const hidden = document.querySelector('input[type="hidden"][name="actor"]') as HTMLInputElement;
    expect(hidden.value).toBe('u-ali');
    expect(screen.getByText(/Showing what/).textContent).toContain('Ali Salesman');
    expect(screen.getByRole('link', { name: 'Show everyone' }).getAttribute('href')).toBe('?entityType=CustomerEdit');
    expect(h.count).toHaveBeenCalledWith({
      where: { actorId: 'u-ali', action: { notIn: ['PHOTO_VIEW'] }, entityType: 'CustomerEdit' },
    });
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

describe('photo views are the Data Steward’s alone (data audit 2026-10-10 gap 2; owner decision 2026-10-11)', () => {
  const actions = () =>
    [...(document.querySelector('select[name="action"]') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);
  const view = (id: string): Log => ({ ...log(id, 'u-mgr', 'Mona Manager'), action: 'PHOTO_VIEW', entityType: 'Attachment', entityId: `ph-${id}-000000` });

  const HIDDEN = 'Photo views are not in this list.';

  it('the Steward is offered “Photo views” and can filter the log to it, with the viewer and the photo shown', async () => {
    h.logs = [view('cr1')];
    await open({ action: 'PHOTO_VIEW' });
    expect(actions()).toEqual(Object.values(AuditAction));
    const picked = screen.getByRole('combobox', { name: 'Action' }) as HTMLSelectElement;
    expect(picked.value).toBe('PHOTO_VIEW');
    expect(picked.selectedOptions[0]!.textContent).toBe('Photo views (PHOTO_VIEW)');
    expect(h.count).toHaveBeenCalledWith({ where: { action: 'PHOTO_VIEW' } });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { action: 'PHOTO_VIEW' } }));
    expect(screen.getByText('PHOTO_VIEW', { selector: 'td' })).toBeTruthy();
    expect(screen.getByText('Attachment/ph-cr1-0…')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mona Manager' }).getAttribute('href')).toBe('?action=PHOTO_VIEW&actor=u-mgr');
    expect(screen.queryByText(HIDDEN, { exact: false })).toBeNull();
  });

  it('owner decisions 2026-10-11: the Steward’s default list and its count leave photo views out, and say so', async () => {
    expect(STEWARD_HIDDEN_BY_DEFAULT).toEqual([AuditAction.PHOTO_VIEW]);
    await open();
    const hidden = { action: { notIn: ['PHOTO_VIEW'] } };
    expect(h.count).toHaveBeenCalledWith({ where: hidden });
    expect(h.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: hidden }));
    expect(h.raw).toEqual([]);
    const first = (screen.getByRole('combobox', { name: 'Action' }) as HTMLSelectElement).options[0]!;
    expect([first.value, first.textContent]).toEqual(['', 'All actions but photo views']);
    expect(screen.getByText(HIDDEN, { exact: false })).toBeTruthy();
  });

  it('they stay out under every other filter: only the Photo views action (or a customer code) brings them in', async () => {
    const asks: Record<string, string>[] = [{ entityType: 'Attachment' }, { q: 'ph-' }, { actor: 'u-mgr' }, { entityType: 'Attachment', q: 'ph-', actor: 'u-mgr' }];
    for (const sp of asks) {
      h.count.mockClear();
      await open(sp);
      expect(h.count.mock.calls[0]![0].where.action, JSON.stringify(sp)).toEqual({ notIn: ['PHOTO_VIEW'] });
      cleanup();
    }
    // Another action is the Steward's pick as before, and cannot match a photo view anyway.
    h.count.mockClear();
    await open({ action: 'APPROVE' });
    expect(h.count).toHaveBeenCalledWith({ where: { action: 'APPROVE' } });
    expect(screen.queryByText(HIDDEN, { exact: false })).toBeNull();
  });

  it('a Manager is never offered PHOTO_VIEW, and every read he makes leaves it out — whatever the address asks', async () => {
    h.role = 'MANAGER';
    expect(MANAGER_AUDIT_ACTIONS).toEqual(Object.values(AuditAction).filter((a) => a !== 'PHOTO_VIEW'));
    const asks: Record<string, string>[] = [{}, { action: 'PHOTO_VIEW' }, { entityType: 'Attachment' }, { action: 'PHOTO_VIEW', entityType: 'Attachment', q: 'ph-' }];
    for (const sp of asks) {
      cleanup();
      h.raw = [];
      await open(sp);
      expect(actions(), JSON.stringify(sp)).toEqual([...MANAGER_AUDIT_ACTIONS]);
      // The count and the page of ids: both carry the exclusion, bound as a value.
      expect(h.raw, JSON.stringify(sp)).toHaveLength(2);
      for (const sql of h.raw) {
        expect(sql).toContain('a."action" NOT IN (?::"AuditAction") AND (');
        expect(sql).toContain('["PHOTO_VIEW",');
      }
      expect(h.count).not.toHaveBeenCalled();
    }
  });

  it('a Manager is never offered the customer filter; an address that carries one is ignored and not carried on', async () => {
    h.role = 'MANAGER';
    h.customers = [{ id: 'cust-1', nmwcCode: 'NMWC-2026-000123', temixCode: null, archived: false }];
    h.docs = ['att-1'];
    await open({ customer: 'NMWC-2026-000123', actor: 'sm-mine' });
    expect(document.querySelector('input[name="customer"]')).toBeNull();
    expect(screen.queryByText(/Showing who opened/)).toBeNull();
    // His two reads, through his scope; no customer lookup, no documents query.
    expect(h.raw).toHaveLength(2);
    for (const sql of h.raw) {
      expect(sql).toContain('a."action" NOT IN (?::"AuditAction") AND (');
      expect(sql).not.toContain('FROM "Customer" c');
      expect(sql).not.toContain('FROM "Attachment" t');
      expect(sql).not.toContain('att-1');
    }
    expect(screen.getByRole('link', { name: 'Show everyone' }).getAttribute('href')).toBe('?');
    expect(screen.getByRole('link', { name: 'Ali Salesman' }).getAttribute('href')).toBe('?actor=u-ali');
  });

  it('no other role reaches the page, so none reads the log', async () => {
    for (const role of Object.values(Role).filter((r) => r !== 'MANAGER' && r !== 'STEWARD')) {
      h.role = role;
      await expect(open(), role).rejects.toThrow('REDIRECT /home');
    }
    expect(h.raw).toEqual([]);
    expect(h.count).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
  });
});

describe('owner decisions 2026-10-11 (part C): every print is an ordinary audit row', () => {
  const actions = () =>
    [...(document.querySelector('select[name="action"]') as HTMLSelectElement).options].map((o) => o.value).filter(Boolean);
  const print = (id: string, entityType: 'Customer' | 'CustomerEdit'): Log => ({
    ...log(id, 'u-mgr', 'Mona Manager'),
    action: 'PRINT',
    entityType,
    entityId: `${entityType === 'Customer' ? 'cu' : 'ed'}-${id}-000000`,
  });

  it('the Steward is offered PRINT and sees who printed which customer or request', async () => {
    h.logs = [print('p1', 'Customer'), print('p2', 'CustomerEdit')];
    await open({ action: 'PRINT' });
    expect(actions()).toContain('PRINT');
    expect(h.count).toHaveBeenCalledWith({ where: { action: 'PRINT' } });
    expect(screen.getAllByText('PRINT', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText('Customer/cu-p1-00…')).toBeTruthy();
    expect(screen.getByText('CustomerEdit/ed-p2-00…')).toBeTruthy();
  });

  it('a Manager is offered PRINT too, read through his regional scope (Customer and CustomerEdit rows of his regions)', async () => {
    h.role = 'MANAGER';
    expect(MANAGER_AUDIT_ACTIONS).toContain('PRINT');
    expect(MANAGER_AUDIT_ENTITY_TYPES).toEqual(expect.arrayContaining(['Customer', 'CustomerEdit']));
    await open({ action: 'PRINT' });
    expect(actions()).toContain('PRINT');
    expect(h.raw).toHaveLength(2);
    for (const sql of h.raw) {
      expect(sql).toContain(`a."entityType" = 'Customer' AND EXISTS`);
      expect(sql).toContain(`a."entityType" = 'CustomerEdit' AND EXISTS`);
    }
  });
});

describe('the Steward’s customer filter: who viewed this customer’s documents (owner decisions 2026-10-11)', () => {
  const view = (id: string): Log => ({ ...log(id, 'u-mgr', 'Mona Manager'), action: 'PHOTO_VIEW', entityType: 'Attachment', entityId: `att-${id}-00000` });
  const live = { id: 'cust-1', nmwcCode: 'NMWC-2026-000123', temixCode: 'CAA0367', archived: false };
  const lookup = () => h.raw.find((t) => t.includes('FROM "Customer" c'));
  const documents = () => h.raw.find((t) => t.includes('FROM "Attachment" t'));
  const ledger = () => h.raw.filter((t) => t.includes('FROM "AuditLog" a'));
  /** The photo-view condition the page builds, as the mock prints it (lib/audit-scope.ts photoViewsOfDocumentsSql). */
  const VIEWS_OF = `(a."action" = ?::"AuditAction" AND a."entityType" = 'Attachment' AND (a."entityId" = ANY(?::text[])`;

  beforeEach(() => {
    h.customers = [live];
    h.docs = ['att-cr', 'att-shop', 'att-free', 'att-request'];
    h.logs = [view('cr'), view('request')];
  });

  it('an NMWC code, typed as it comes: the views of every document of that customer, through the ledger’s indexes', async () => {
    await open({ customer: '  nmwc-2026-000123 ' });
    // The code is folded (ends, case) and looked up as an NMWC code or a Temix code.
    expect(lookup()).toContain('UPPER(c."nmwcCode") = ?');
    expect(lookup()).toContain('UPPER(c."temixCode") = ?');
    expect(lookup()).toContain('"NMWC-2026-000123"');
    // Its documents by where each one is wired: on the customer (CR, guarantee), on
    // its branches (shop, signboard, extra photos: their view rows carry no customer
    // id), and on its requests (photos viewed before the final approval bound them).
    const docs = documents()!;
    expect(docs).toContain('t."customerId" = ANY(?::text[])');
    expect(docs).toContain('JOIN "Branch" b ON b."id" = t."branchId"');
    expect(docs).toContain('JOIN "Branch" b ON b."id" = t."branchExtraId"');
    expect(docs).toContain('JOIN "CustomerEdit" e ON e."id" = t."editId"');
    expect(docs).toContain('e."customerId" = ANY(?::text[])');
    expect(docs).toContain('["cust-1"] ["cust-1"] ["cust-1"] ["cust-1"]');
    // The count and the page: PHOTO_VIEW rows of exactly those documents, as one bound
    // array (an index probe per document on AuditLog(entityType, entityId, at)).
    expect(ledger()).toHaveLength(2);
    for (const sql of ledger()) {
      expect(sql).toContain(`${VIEWS_OF}))`);
      expect(sql).toContain('["PHOTO_VIEW",["att-cr","att-shop","att-free","att-request"]]');
      // A live customer needs no scan of the views' JSON.
      expect(sql).not.toContain('after');
    }
    expect(h.count).not.toHaveBeenCalled();
    expect(screen.getByText('2 matching events')).toBeTruthy();
    expect(screen.getAllByText('PHOTO_VIEW', { selector: 'td' })).toHaveLength(2);
    expect(screen.getByText(/Showing who opened the photos and documents of/).textContent).toContain('NMWC-2026-000123');
    expect(screen.queryByText('Photo views are not in this list.', { exact: false })).toBeNull();
    // Kept on Apply, and in every link, until cleared.
    expect((screen.getByLabelText('Customer code (NMWC or Temix)') as HTMLInputElement).value).toBe('  nmwc-2026-000123 ');
    expect(screen.getByLabelText('Customer code (NMWC or Temix)').getAttribute('name')).toBe('customer');
    expect(screen.getAllByRole('link', { name: 'Mona Manager' })[0]!.getAttribute('href')).toContain('customer=');
    expect(screen.getByRole('link', { name: 'Show the whole log' }).getAttribute('href')).toBe('?');
  });

  it('a Temix code finds the customer too, whatever case it is typed in', async () => {
    await open({ customer: 'caa0367' });
    expect(lookup()).toContain('"CAA0367"');
    expect(ledger()).toHaveLength(2);
  });

  it('request-stage photos count: a request’s photo is found through the request that names the customer', async () => {
    // The request photo's view row says only { editId } (the route copies the photo's
    // wiring as it stood); the documents query reaches it through CustomerEdit.customerId.
    h.docs = ['att-request'];
    h.logs = [view('request')];
    await open({ customer: 'NMWC-2026-000123' });
    expect(documents()).toMatch(
      /SELECT t\."id" FROM "Attachment" t JOIN "CustomerEdit" e ON e\."id" = t\."editId"\s+WHERE e\."customerId" = ANY/
    );
    for (const sql of ledger()) expect(sql).toContain('["PHOTO_VIEW",["att-request"]]');
    expect(screen.getByText('Attachment/att-requ…')).toBeTruthy();
  });

  it('an archived customer also matches the views that name him: a merged-away customer’s documents moved on', async () => {
    h.customers = [{ ...live, id: 'cust-gone', nmwcCode: 'NMWC-2026-000099', archived: true }];
    h.docs = [];
    await open({ customer: 'NMWC-2026-000099' });
    expect(ledger()).toHaveLength(2);
    for (const sql of ledger()) {
      expect(sql).toContain(`${VIEWS_OF} OR a."after"->>'customerId' = ANY(?::text[])))`);
      expect(sql).toContain('["PHOTO_VIEW",[],["cust-gone"]]');
    }
    expect(screen.getByText(/Showing who opened/).textContent).toContain('NMWC-2026-000099 (archived)');
  });

  it('a code shared by several customers (a Temix code is not unique) shows all of them', async () => {
    h.customers = [live, { ...live, id: 'cust-2', nmwcCode: 'NMWC-2026-000124' }];
    await open({ customer: 'CAA0367' });
    expect(documents()).toContain('["cust-1","cust-2"]');
    expect(screen.getByText(/Showing who opened/).textContent).toContain('NMWC-2026-000123, NMWC-2026-000124');
  });

  it('a code that names no customer, or a customer with no documents, reads nothing from the ledger', async () => {
    h.customers = [];
    await open({ customer: 'NMWC-0000' });
    expect(h.raw).toHaveLength(1);
    expect(ledger()).toEqual([]);
    expect(h.findMany).not.toHaveBeenCalled();
    expect(screen.getByText('0 matching events')).toBeTruthy();
    expect(screen.getByText(/No customer has the code/).textContent).toContain('NMWC-0000');

    cleanup();
    h.raw = [];
    h.customers = [live];
    h.docs = [];
    await open({ customer: 'NMWC-2026-000123' });
    expect(ledger()).toEqual([]);
    expect(screen.getByText('0 matching events')).toBeTruthy();
  });

  it('works with the other filters, which narrow it further', async () => {
    await open({ customer: 'NMWC-2026-000123', actor: 'u-mgr', q: 'att-cr' });
    expect(ledger()).toHaveLength(2);
    for (const sql of ledger()) {
      expect(sql).toContain(`${VIEWS_OF})) AND a."actorId" = ? AND strpos(a."entityId", ?) > 0`);
    }
    expect(screen.getByText(/Showing what/).textContent).toContain('Mona Manager');
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
