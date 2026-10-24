/**
 * The customer's History page (app/(app)/customers/[id]/history), rendered with
 * its session and database mocked: the Data Steward only, checked before any
 * read; the four sections; a personal value never on the page; an unknown shop
 * is not found; the pager keeps the shop. And the customer page's way in: the
 * History and Shop history links, for the Steward only.
 *
 * The pure assembly is in customer-history.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Role } from '@prisma/client';

const h = vi.hoisted(() => ({
  role: 'STEWARD' as string,
  signedIn: true,
  profile: null as null | Record<string, unknown>,
}));

vi.mock('@/lib/auth', () => ({
  auth: async () => (h.signedIn ? { user: { id: 'stw', role: h.role, username: 'data.steward' } } : null),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
  notFound: () => {
    throw new Error('notFound');
  },
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode; [k: string]: unknown }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
// The customer page's own collaborators (as temix-code-visible.test.tsx mocks them).
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: 'r1', teamRouteIds: [], managedRegionIds: ['g1'] }),
  canSeeCustomer: () => true,
  filterBranchesByScope: (_u: unknown, b: unknown[]) => b,
}));
vi.mock('@/lib/returned-work', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/returned-work')>()),
  openReturnedIds: vi.fn(async () => []),
}));
vi.mock('@/app/(app)/customers/[id]/ArchiveCustomerButton', () => ({
  ArchiveCustomerButton: () => <button type="button">Archive</button>,
}));
vi.mock('@/components/nmwc/BranchStatusActions', () => ({ BranchStatusActions: () => null }));

const PHONE = '+96899991234';
const T0 = new Date('2026-03-01T06:00:00Z');
const T1 = new Date('2026-10-16T08:00:00Z');

let seq = 0n;
const meta = (o: Record<string, unknown>) => ({
  id: ++seq,
  changeKind: 'UPDATE',
  changedFields: [] as string[],
  validFrom: T0,
  recordedAt: (o.validFrom as Date | undefined) ?? T0,
  effectiveRequested: null,
  actorId: null,
  source: 'e2e:run1',
  sourceKind: 'e2e',
  txId: ++seq,
  ...o,
});
const customerRow = (o: Record<string, unknown>) =>
  meta({
    nmwcCode: 'NMWC-2026-000123',
    paymentTerms: 'CASH',
    creditLimit: null,
    paymentTermDays: null,
    temixCode: null,
    status: 'ACTIVE',
    channelId: null,
    subChannelId: null,
    crPhotoId: null,
    deletedAt: null,
    mergedIntoId: null,
    // What a careless select would bring along: never read.
    primaryPhone: PHONE,
    ...o,
  });
const branchRow = (o: Record<string, unknown>) =>
  meta({
    branchId: 'b1',
    branchCode: 'NMWC-2026-000123-01',
    customerId: 'c1',
    routeId: 'r1',
    regionId: 'g1',
    dayOfVisit: 'SUN',
    status: 'ACTIVE',
    deletedAt: null,
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    equipmentConfirmed: false,
    shopPhotoId: null,
    signboardPhotoId: null,
    ...o,
  });

const birth = customerRow({ changeKind: 'CREATE', validFrom: T0 });

function freshDb() {
  return {
    customer: {
      findUnique: vi.fn(async () => ({
        id: 'c1',
        nmwcCode: 'NMWC-2026-000123',
        legalName: 'Al Noor Trading',
        deletedAt: null,
        mergedIntoId: null,
        importBatchId: null,
        createdById: null,
        primaryPhone: PHONE,
      })),
      findMany: vi.fn(async () => [{ id: 'c1', nmwcCode: 'NMWC-2026-000123' }]),
      findFirst: vi.fn(async () => h.profile),
    },
    customerHistory: {
      findMany: vi.fn(async () => [
        customerRow({
          changedFields: ['primaryPhone', 'contactPerson'],
          validFrom: T1,
          actorId: 'stw',
          source: 'edit:e1',
          sourceKind: 'edit',
        }),
        birth,
      ]),
      findFirst: vi.fn(async () => birth),
    },
    $queryRaw: vi.fn(async () => [
      {
        branch_id: 'b1',
        branch_code: 'NMWC-2026-000123-01',
        route_id: 'r1',
        route_code: 'MCT-01',
        salesman_id: 's1',
        salesman_username: 'mct01',
        valid_from: T0,
        valid_to: null,
        from_inferred: false,
        merged_into_id: null,
        note: null,
      },
    ]),
    branchHistory: {
      groupBy: vi.fn(async () => [{ branchId: 'b1' }]),
      findMany: vi.fn(async () => [branchRow({ changeKind: 'CREATE', validFrom: T0 })]),
    },
    attachmentHistory: { findMany: vi.fn(async () => []) },
    branch: {
      findMany: vi.fn(async () => [
        { id: 'b1', customerId: 'c1', branchCode: 'NMWC-2026-000123-01', branchName: 'Main shop', deletedAt: null },
      ]),
    },
    user: {
      findMany: vi.fn(async () => [
        { id: 'stw', fullName: 'Aisha Al Hinai', role: 'STEWARD' },
        { id: 's1', fullName: 'Salim Al Balushi', role: 'SALESMAN' },
      ]),
    },
    userHistory: { findMany: vi.fn(async () => []) },
    route: { findMany: vi.fn(async () => [{ id: 'r1', code: 'MCT-01', name: 'Muscat 01' }]) },
    region: { findMany: vi.fn(async () => [{ id: 'g1', code: 'MCT', name: 'Muscat' }]) },
    channel: { findMany: vi.fn(async () => []) },
    subChannel: { findMany: vi.fn(async () => []) },
    importBatch: { findMany: vi.fn(async () => []) },
    customerEdit: {
      findMany: vi.fn(async () => [
        {
          id: 'e1',
          process: 'UPDATE',
          target: 'CUSTOMER',
          isReactivation: false,
          state: 'APPROVED',
          submittedById: 'stw',
          reviewedById: 'stw',
          customerId: 'c1',
          submittedBy: { fullName: 'Aisha Al Hinai' },
        },
      ]),
      findUnique: vi.fn(async () => null),
    },
    routeHistory: { findMany: vi.fn(async () => []) },
    regionHistory: { findMany: vi.fn(async () => []) },
  };
}

const db = vi.hoisted(() => ({ prisma: {} as Record<string, unknown>, touched: new Set<string>() }));
/** The client, recording every model and method the code reaches for ("customer.findUnique", "$queryRaw"). */
vi.mock('@/lib/db', () => ({
  get prisma() {
    return new Proxy(db.prisma, {
      get(target, model) {
        const v = target[model as string];
        if (typeof model !== 'string') return v;
        if (v && typeof v === 'object') {
          return new Proxy(v as Record<string, unknown>, {
            get(m, method) {
              if (typeof method === 'string') db.touched.add(`${model}.${method}`);
              return m[method as string];
            },
          });
        }
        db.touched.add(model);
        return v;
      },
    });
  },
}));

/** Every mocked database call, for "nothing was read". */
function allCalls(): number {
  let n = 0;
  for (const v of Object.values(db.prisma)) {
    if (typeof v === 'function' && 'mock' in v) n += (v as ReturnType<typeof vi.fn>).mock.calls.length;
    else if (v && typeof v === 'object') {
      for (const f of Object.values(v)) if (typeof f === 'function' && 'mock' in f) n += (f as ReturnType<typeof vi.fn>).mock.calls.length;
    }
  }
  return n;
}

beforeEach(() => {
  db.prisma = freshDb();
  db.touched.clear();
  h.role = 'STEWARD';
  h.signedIn = true;
  h.profile = null;
});
afterEach(() => cleanup());

async function renderHistory(search: Record<string, string> = {}) {
  const { default: Page } = await import('@/app/(app)/customers/[id]/history/page');
  return render(await Page({ params: Promise.resolve({ id: 'c1' }), searchParams: Promise.resolve(search) }));
}

describe('who may open a customer’s History', () => {
  const others = Object.values(Role).filter((r) => r !== Role.STEWARD);

  it('there are eight other roles', () => {
    expect(others).toHaveLength(8);
  });

  it.each(others)('a %s is sent home, and nothing is read', async (role) => {
    h.role = role;
    await expect(renderHistory()).rejects.toThrow('REDIRECT /home');
    expect(allCalls()).toBe(0);
  });

  it('signed out: the sign-in page, and nothing is read', async () => {
    h.signedIn = false;
    await expect(renderHistory()).rejects.toThrow('REDIRECT /login');
    expect(allCalls()).toBe(0);
  });

  it('an unknown customer is not found', async () => {
    (db.prisma.customer as { findUnique: ReturnType<typeof vi.fn> }).findUnique.mockResolvedValueOnce(null);
    await expect(renderHistory()).rejects.toThrow('notFound');
  });

  it('a ?shop= that was never one of its shops is not found', async () => {
    await expect(renderHistory({ shop: 'b-somebody-elses' })).rejects.toThrow('notFound');
  });
});

describe('the Data Steward’s view', () => {
  it('shows the four sections, by name', async () => {
    await renderHistory();
    expect(screen.getByRole('heading', { level: 1, name: 'History' })).toBeInTheDocument();
    for (const name of ['Created', 'Routes that served this customer', 'Terms over time', 'Every change']) {
      expect(screen.getByRole('region', { name }), name).toBeInTheDocument();
    }
    const routes = screen.getByRole('region', { name: 'Routes that served this customer' });
    const list = within(routes).getByRole('list', { name: 'Routes of shop NMWC-2026-000123-01' });
    expect(list).toHaveTextContent('MCT-01');
    expect(list).toHaveTextContent('Salim Al Balushi');
    expect(list).toHaveTextContent('signed in as mct01 then');
    expect(list).toHaveTextContent('01/03/2026 – now');
    expect(screen.getByRole('link', { name: 'Back to customer' })).toHaveAttribute('href', '/customers/c1');
  });

  it('a personal field reads "changed", and its value is nowhere on the page', async () => {
    const { container } = await renderHistory();
    const changes = screen.getByRole('list', { name: 'Changes' });
    const first = within(changes).getAllByRole('listitem')[0];
    expect(first).toHaveTextContent('Aisha Al Hinai (Data Steward)');
    expect(first).toHaveTextContent('Primary phone: changed');
    expect(first).toHaveTextContent('Contact person: changed');
    expect(first).toHaveTextContent('16/10/2026, 12:00:00');
    expect(first).not.toHaveTextContent('recorded');
    expect(within(first).getByRole('link', { name: /Direct change by Aisha Al Hinai/ })).toHaveAttribute(
      'href',
      '/audit?entityType=Customer&q=c1'
    );
    expect(container.textContent).not.toContain('99991234');
    expect(container.innerHTML).not.toContain('99991234');
  });

  it('a cause typed straight into the database (not SOURCE_RE) is not printed, only a neutral label', async () => {
    // nmwc_change_ctx keeps any nmwc.source text up to 200 characters, one typed in psql say.
    const typed = 'fixed per Ahmed Al Balushi, call +968 7777 1234';
    (db.prisma.customerHistory as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
      customerRow({ changedFields: ['temixCode'], temixCode: 'T-42', validFrom: T1, source: typed, sourceKind: 'fixed' }),
      birth,
    ]);
    const { container } = await renderHistory();
    const first = within(screen.getByRole('list', { name: 'Changes' })).getAllByRole('listitem')[0];
    expect(first).toHaveTextContent("A cause not in the app's list (its text is not shown)");
    expect(first).toHaveTextContent('T-42');
    for (const leak of ['Ahmed', '7777', 'call']) {
      expect(container.textContent, leak).not.toContain(leak);
      expect(container.innerHTML, leak).not.toContain(leak);
    }
  });

  it('only reads — no write, no transaction — and never the audit log', async () => {
    await renderHistory();
    const touched = [...db.touched].sort();
    expect(touched.length).toBeGreaterThan(10);
    const READ = new Set(['findUnique', 'findFirst', 'findMany', 'groupBy']);
    for (const t of touched) {
      const [model, method] = t.split('.');
      expect(t === '$queryRaw' || READ.has(method), `${t} is a read`).toBe(true);
      expect(model, 'AuditLog values can hold personal data').not.toBe('auditLog');
    }
    expect(touched).toContain('customerHistory.findMany');
    expect(touched).toContain('$queryRaw');
  });

  it("a shop's view: that shop only, no terms, and the pager keeps the shop", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      branchRow({ changedFields: ['coolersCount'], coolersCount: i + 1, validFrom: new Date(T0.getTime() + (i + 1) * 86_400_000) })
    );
    (db.prisma.branchHistory as { findMany: ReturnType<typeof vi.fn> }).findMany.mockResolvedValue([
      ...many.reverse(),
      branchRow({ changeKind: 'CREATE', validFrom: T0 }),
    ]);
    await renderHistory({ shop: 'b1' });
    expect(screen.getByRole('region', { name: 'Routes that served this shop' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Terms over time' })).toBeNull();
    expect(screen.getByRole('link', { name: /NMWC-2026-000123-01/ })).toHaveAttribute('aria-current', 'page');
    const pager = screen.getByRole('navigation', { name: 'Pages of changes' });
    expect(pager).toHaveTextContent('Page 1 of 2');
    expect(within(pager).getByRole('link', { name: 'Older →' })).toHaveAttribute('href', '/customers/c1/history?shop=b1&page=2');
    expect(within(pager).getByRole('link', { name: '← Newer' })).toHaveAttribute('aria-disabled', 'true');
    // Only that shop's rows are read, and documents (customer-level) not at all.
    expect((db.prisma.branchHistory as { findMany: ReturnType<typeof vi.fn> }).findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { branchId: 'b1' } })
    );
    expect((db.prisma.attachmentHistory as { findMany: ReturnType<typeof vi.fn> }).findMany).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const profile = () => ({
  id: 'c1',
  nmwcCode: 'NMWC-2026-000123',
  temixCode: null,
  legalName: 'Al Noor Trading',
  paymentTerms: 'CASH',
  crNumber: null,
  crPhoto: null,
  channel: null,
  subChannel: null,
  primaryPhone: null,
  altPhone: null,
  contactPerson: null,
  contactRole: null,
  status: 'ACTIVE',
  notes: null,
  completenessScore: 60,
  edits: [],
  branches: ['01', '02'].map((n) => ({
    id: `b${n}`,
    branchName: `Shop ${n}`,
    branchCode: `NMWC-2026-000123-${n}`,
    address: 'Way 1, Ruwi',
    gpsLat: null,
    gpsLng: null,
    dayOfVisit: null,
    openingHours: null,
    deliveryWindow: null,
    coolersCount: 0,
    standsCount: 0,
    emptyBottlesCount: 0,
    completenessScore: 50,
    status: 'ACTIVE',
    shopPhoto: null,
    signboardPhoto: null,
    routeId: 'r1',
    regionId: 'g1',
    deletedAt: null,
    region: { name: 'Muscat' },
    route: { code: 'MCT-01', name: 'MCT-01', isActive: true },
  })),
});

describe('the customer page leads there, for the Data Steward only', () => {
  it.each(Object.values(Role))('as %s', async (role) => {
    h.role = role;
    h.profile = profile();
    const { default: Page } = await import('@/app/(app)/customers/[id]/page');
    render(await Page({ params: Promise.resolve({ id: 'c1' }) }));
    const history = screen.queryByRole('link', { name: 'History' });
    const shops = screen.queryAllByRole('link', { name: /^Shop history: / });
    if (role === Role.STEWARD) {
      expect(history).toHaveAttribute('href', '/customers/c1/history');
      expect(shops.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
        ['Shop history', '/customers/c1/history?shop=b01'],
        ['Shop history', '/customers/c1/history?shop=b02'],
      ]);
    } else {
      expect(history).toBeNull();
      expect(shops).toEqual([]);
    }
  });
});
