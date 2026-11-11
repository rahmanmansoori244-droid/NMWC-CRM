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
import { render, cleanup, within, screen, fireEvent, waitFor } from '@testing-library/react';
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
    // Gap 24: the change context each transaction sets first (lib/change-context.ts).
    $executeRaw: async () => 1,
    region: {
      findUnique: async ({ where }: { where: { id: string } }) => h.regions.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: { isActive: boolean } }) => {
        h.writes.push(`region:${where.id}`);
        const r = { ...h.regions.get(where.id)!, ...data };
        h.regions.set(where.id, r);
        return r;
      },
      // Finding 9: the switch writes only from the opposite state.
      updateMany: async ({ where, data }: { where: { id: string; isActive: boolean }; data: { isActive: boolean } }) => {
        const r = h.regions.get(where.id);
        if (!r || r.isActive !== where.isActive) return { count: 0 };
        h.writes.push(`region:${where.id}`);
        h.regions.set(where.id, { ...r, ...data });
        return { count: 1 };
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
      updateMany: async ({ where, data }: { where: { id: string; isActive: boolean }; data: { isActive: boolean } }) => {
        const r = h.routes.get(where.id);
        if (!r || r.isActive !== where.isActive) return { count: 0 };
        h.writes.push(`route:${where.id}`);
        h.routes.set(where.id, { ...r, ...data });
        return { count: 1 };
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
import { ACTIVE_MISSING } from '@/lib/active-switch';
import { toggleRegionActiveAction, toggleRouteActiveAction } from '@/services/routes';
import RoutesPage from '@/app/(app)/routes/page';

const MANAGER = { id: 'm1', role: 'MANAGER', username: 'mct-gt' };
const STEWARD = { id: 's1', role: 'STEWARD', username: 'data.steward' };
/** A click on Disable (the default) or Enable: it says the state it wants (finding 9). */
const form = (id: string, active: 'true' | 'false' | null = 'false') => {
  const fd = new FormData();
  fd.set('id', id);
  if (active !== null) fd.set('active', active);
  return fd;
};
const OFF = { ok: true, data: { isActive: false, changed: true } };

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
    expect(await toggleRegionActiveAction(form('shared'))).toEqual(OFF);
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
    expect(await toggleRouteActiveAction(form('r-solo'))).toEqual(OFF);
    expect(h.routes.get('r-solo')!.isActive).toBe(false);
  });

  it('the Steward switches a route in a shared region', async () => {
    h.session = STEWARD;
    expect(await toggleRouteActiveAction(form('r-shared'))).toEqual(OFF);
    expect(h.routes.get('r-shared')!.isActive).toBe(false);
  });
});

// Code review 2026-11-10, finding 9: the switches used to flip whatever they
// found, so a second click from an old screen switched a route or region back.
describe('finding 9: a switch sets the state the click wants, and only once', () => {
  const ALREADY_OFF = { ok: true, data: { isActive: false, changed: false } };

  it('a double click on Disable: the second click changes nothing and writes nothing', async () => {
    h.session = STEWARD;
    expect(await toggleRouteActiveAction(form('r-shared'))).toEqual(OFF);
    h.writes = [];
    expect(await toggleRouteActiveAction(form('r-shared'))).toEqual(ALREADY_OFF);
    expect(h.routes.get('r-shared')!.isActive).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it('two admins on stale screens both click Disable on a region: it stays off, one audit row', async () => {
    h.session = STEWARD;
    const a = await toggleRegionActiveAction(form('solo'));
    const b = await toggleRegionActiveAction(form('solo'));
    expect([a, b]).toEqual([OFF, ALREADY_OFF]);
    expect(h.regions.get('solo')!.isActive).toBe(false);
    expect(h.writes).toEqual(['region:solo', 'audit']);
  });

  it('Enable from a screen that still shows the route off, after someone else enabled it: already on, nothing written', async () => {
    h.routes.set('r-solo', { ...h.routes.get('r-solo')!, isActive: true });
    expect(await toggleRouteActiveAction(form('r-solo', 'true'))).toEqual({
      ok: true,
      data: { isActive: true, changed: false },
    });
    expect(h.writes).toEqual([]);
  });

  it('Enable on a route that is off switches it on, with its audit row', async () => {
    h.routes.set('r-solo', { ...h.routes.get('r-solo')!, isActive: false });
    expect(await toggleRouteActiveAction(form('r-solo', 'true'))).toEqual({
      ok: true,
      data: { isActive: true, changed: true },
    });
    expect(h.routes.get('r-solo')!.isActive).toBe(true);
    expect(h.writes).toEqual(['route:r-solo', 'audit']);
  });

  it('a click that does not say what it wants is refused, and nothing is written', async () => {
    h.session = STEWARD;
    for (const res of [
      await toggleRegionActiveAction(form('solo', null)),
      await toggleRouteActiveAction(form('r-solo', null)),
    ]) {
      // Second round of the review: the message is the reason too, since the
      // /routes button shows only the message (it was the bare "Validation failed").
      expect(res).toMatchObject({ ok: false, code: 'VALIDATION_FAILED', message: ACTIVE_MISSING, fields: { active: ACTIVE_MISSING } });
    }
    expect(h.writes).toEqual([]);
    expect(h.regions.get('solo')!.isActive).toBe(true);
    expect(h.routes.get('r-solo')!.isActive).toBe(true);
  });

  // Third round: the /routes button and the real action together. A tab still
  // running the code from before the deploy sends no wanted state; the button
  // shows only the server's message, so the alert must say to reload. The second
  // round's test mocked the action's answer and passed on the old code too.
  it('the /routes button from a screen older than the deploy, through the real action: the alert says to reload', async () => {
    const { ToggleButton: RealToggleButton } = await vi.importActual<typeof import('@/app/(app)/routes/forms')>(
      '@/app/(app)/routes/forms'
    );
    h.session = STEWARD;
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    // The older screen's form: everything but the wanted state.
    const set = FormData.prototype.set;
    const strip = vi.spyOn(FormData.prototype, 'set').mockImplementation(function (this: FormData, ...args: unknown[]) {
      if (args[0] === 'active') return;
      return (set as (...a: unknown[]) => void).apply(this, args);
    });
    try {
      render(<RealToggleButton id="r-solo" kind="route" isActive />);
      fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
      await waitFor(() => expect(alert).toHaveBeenCalledWith(ACTIVE_MISSING));
      expect(alert).not.toHaveBeenCalledWith('Validation failed');
      expect(h.writes).toEqual([]);
      expect(h.routes.get('r-solo')!.isActive).toBe(true);
    } finally {
      strip.mockRestore();
      vi.restoreAllMocks();
    }
  });

  it('the permission rule still comes first: a Manager’s stale click on a shared region is FORBIDDEN, not "already"', async () => {
    h.regions.set('shared', { id: 'shared', isActive: false });
    expect(await toggleRegionActiveAction(form('shared'))).toMatchObject({ ok: false, code: 'FORBIDDEN' });
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
