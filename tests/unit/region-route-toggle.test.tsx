/**
 * Owner decision 5 (2026-10-07): only the Data Steward switches a REGION off or
 * on. Before it, services/routes.ts let any Manager of the region do it, and a
 * region is shared — the four Muscat Managers all manage MCT, and the two
 * fallback approvers cover most of the others — so one Manager could switch a
 * region off for the rest.
 *
 * Routes had the same problem: a Manager could switch off any route of his
 * region, including one worked by another Manager's salesman, whose salesman then
 * can add no customer (services/creates.ts "Your route is inactive"). So the same
 * rule applies where the route's region has more than one active Manager; a
 * Manager who manages a region alone keeps the switch for its routes.
 *
 * Proved three ways: the pure rule (lib/permissions.ts), the server actions with
 * a stand-in database (a Manager's call is refused and nothing is written), and
 * the /routes page (the buttons are offered exactly where the action would act).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { Role } from '@prisma/client';

const h = vi.hoisted(() => ({
  session: { id: 'm1', role: 'MANAGER', username: 'mct-gt' } as {
    id: string;
    role: string;
    username: string;
  },
  managed: ['solo', 'shared'] as string[],
  regions: new Map<string, { id: string; isActive: boolean }>(),
  routes: new Map<string, { id: string; regionId: string; isActive: boolean }>(),
  /** Active Managers per region id. */
  regionManagers: new Map<string, string[]>(),
  writes: [] as string[],
  /** What the /routes page's region query returns. */
  pageRegions: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/session', () => ({ requireActor: async () => h.session }));
vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: h.session }) }));
vi.mock('@/lib/access', () => ({
  loadScope: async () => ({ ownedRouteId: null, teamRouteIds: [], managedRegionIds: h.managed }),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async () => ({ actorId: h.session.id, ip: null, userAgent: null }),
  writeAudit: async () => {
    h.writes.push('audit');
  },
}));
vi.mock('@/lib/db', () => {
  const client = {
    region: {
      findUnique: async ({ where }: { where: { id: string } }) => h.regions.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { isActive: boolean } }) => {
        h.writes.push(`region:${where.id}`);
        const r = { ...h.regions.get(where.id)!, ...data };
        h.regions.set(where.id, r);
        return r;
      },
      findMany: async () => h.pageRegions,
    },
    route: {
      findUnique: async ({ where }: { where: { id: string } }) => h.routes.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { isActive: boolean } }) => {
        h.writes.push(`route:${where.id}`);
        const r = { ...h.routes.get(where.id)!, ...data };
        h.routes.set(where.id, r);
        return r;
      },
    },
    user: {
      findMany: async ({
        where,
      }: {
        where: { role: string; isActive: boolean; managedRegions: { some: { id: string } } };
      }) => {
        expect(where).toMatchObject({ role: 'MANAGER', isActive: true });
        return (h.regionManagers.get(where.managedRegions.some.id) ?? []).map((id) => ({ id }));
      },
    },
  };
  const prisma = { ...client, $transaction: async (fn: (tx: unknown) => unknown) => fn(client) };
  return { prisma, directPrisma: prisma };
});
// The page's forms are client components with actions; not what is tested here.
vi.mock('@/app/(app)/routes/forms', () => ({
  CreateRegionForm: () => null,
  CreateRouteForm: () => null,
  ToggleButton: ({ id, kind }: { id: string; kind: string }) => (
    <button type="button" data-toggle={`${kind}:${id}`}>
      Toggle
    </button>
  ),
}));

import { canToggleRegion, canToggleRoute } from '@/lib/permissions';
import { toggleRegionActiveAction, toggleRouteActiveAction } from '@/services/routes';
import RoutesPage from '@/app/(app)/routes/page';

const MANAGER = { id: 'm1', role: 'MANAGER', username: 'mct-gt' };
const STEWARD = { id: 's1', role: 'STEWARD', username: 'data.steward' };
const form = (id: string) => {
  const fd = new FormData();
  fd.set('id', id);
  return fd;
};

beforeEach(() => {
  h.session = MANAGER;
  h.managed = ['solo', 'shared'];
  h.writes = [];
  h.regions = new Map([
    ['solo', { id: 'solo', isActive: true }],
    ['shared', { id: 'shared', isActive: true }],
  ]);
  h.routes = new Map([
    ['r-solo', { id: 'r-solo', regionId: 'solo', isActive: true }],
    ['r-shared', { id: 'r-shared', regionId: 'shared', isActive: true }],
  ]);
  // m1 manages SLL alone; MCT is shared with m2 (and a disabled m3 not listed).
  h.regionManagers = new Map([
    ['solo', ['m1']],
    ['shared', ['m1', 'm2']],
  ]);
});
afterEach(cleanup);

describe('the rule (lib/permissions.ts)', () => {
  it('a region is switched by the Steward only', () => {
    expect(canToggleRegion(Role.STEWARD)).toBe(true);
    for (const role of Object.values(Role).filter((r) => r !== Role.STEWARD)) {
      expect(canToggleRegion(role), role).toBe(false);
    }
  });

  it('a route: the Steward always; a Manager only in a region he manages alone', () => {
    expect(canToggleRoute({ id: 's1', role: Role.STEWARD }, ['m1', 'm2'])).toBe(true);
    expect(canToggleRoute({ id: 's1', role: Role.STEWARD }, [])).toBe(true);
    expect(canToggleRoute({ id: 'm1', role: Role.MANAGER }, ['m1'])).toBe(true);
    expect(canToggleRoute({ id: 'm1', role: Role.MANAGER }, ['m1', 'm2'])).toBe(false);
    // Not his region at all, or a region with no active Manager.
    expect(canToggleRoute({ id: 'm1', role: Role.MANAGER }, ['m2'])).toBe(false);
    expect(canToggleRoute({ id: 'm1', role: Role.MANAGER }, [])).toBe(false);
    expect(canToggleRoute({ id: 'v1', role: Role.VIEWER }, ['v1'])).toBe(false);
  });
});

describe('the actions (services/routes.ts)', () => {
  it('a Manager cannot switch a region, even one he manages alone, and nothing is written', async () => {
    for (const id of ['solo', 'shared']) {
      const res = await toggleRegionActiveAction(form(id));
      expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
      if (!res.ok) expect(res.message).toMatch(/Data Steward/);
    }
    expect(h.writes).toEqual([]);
    expect(h.regions.get('solo')!.isActive).toBe(true);
  });

  it('the Steward switches a region off, with its audit row', async () => {
    h.session = STEWARD;
    expect(await toggleRegionActiveAction(form('shared'))).toEqual({ ok: true, data: undefined });
    expect(h.regions.get('shared')!.isActive).toBe(false);
    expect(h.writes).toEqual(['region:shared', 'audit']);
  });

  it('a Manager cannot switch a route in a region another active Manager shares', async () => {
    const res = await toggleRouteActiveAction(form('r-shared'));
    expect(res).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    if (!res.ok) expect(res.message).toMatch(/only the Data Steward/);
    expect(h.writes).toEqual([]);
    expect(h.routes.get('r-shared')!.isActive).toBe(true);
  });

  it('a Manager still switches a route in a region he manages alone', async () => {
    expect(await toggleRouteActiveAction(form('r-solo'))).toEqual({ ok: true, data: undefined });
    expect(h.routes.get('r-solo')!.isActive).toBe(false);
  });

  it('the Steward switches a route in a shared region', async () => {
    h.session = STEWARD;
    expect(await toggleRouteActiveAction(form('r-shared'))).toEqual({ ok: true, data: undefined });
    expect(h.routes.get('r-shared')!.isActive).toBe(false);
  });
});

describe('the /routes page offers the switches exactly where the action acts', () => {
  const route = (id: string, owner: Record<string, unknown> | null = null) => ({
    id,
    code: id.toUpperCase(),
    name: `Route ${id}`,
    isActive: true,
    owner,
  });
  beforeEach(() => {
    h.pageRegions = [
      {
        id: 'solo',
        code: 'SLL',
        name: 'Salalah',
        isActive: true,
        routes: [route('r-solo', { fullName: 'Old Salesman', username: 'sl01', isActive: false })],
        managers: [{ id: 'm1' }],
      },
      {
        id: 'shared',
        code: 'MCT',
        name: 'Muscat',
        isActive: false,
        routes: [route('r-shared')],
        managers: [{ id: 'm1' }, { id: 'm2' }],
      },
    ];
  });

  async function renderPage() {
    return render(await RoutesPage());
  }

  it('for a Manager: no region switch, a route switch only in the region he manages alone', async () => {
    const { container } = await renderPage();
    const toggles = [...container.querySelectorAll('[data-toggle]')].map((b) =>
      b.getAttribute('data-toggle')
    );
    expect(toggles).toEqual(['route:r-solo']);
    // The switched-off region still says so, without a button.
    expect(container.textContent).toContain('Region off');
    expect(container.textContent).toMatch(/Only the Data Steward switches a region off or on/);
  });

  it('for the Steward: every region and every route', async () => {
    h.session = STEWARD;
    const { container } = await renderPage();
    const toggles = [...container.querySelectorAll('[data-toggle]')].map((b) =>
      b.getAttribute('data-toggle')
    );
    expect(toggles).toEqual(['region:solo', 'route:r-solo', 'region:shared', 'route:r-shared']);
    expect(container.textContent).not.toMatch(/Ask the Steward/);
  });

  it('marks a route whose salesman is disabled, so the Steward knows to hand it over', async () => {
    h.session = STEWARD;
    const { container } = await renderPage();
    const row = [...container.querySelectorAll('tr')].find((tr) =>
      tr.textContent?.includes('R-SOLO')
    )!;
    expect(within(row).getByText('(disabled)')).toBeTruthy();
  });
});
