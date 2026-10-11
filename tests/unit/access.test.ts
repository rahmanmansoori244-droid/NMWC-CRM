import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { canSeeCustomer, canEditCustomer, filterBranchesByScope } from '@/lib/access';

const baseScope = {
  ownedRouteId: 'route-A',
  teamRouteIds: ['route-A', 'route-B'],
  managedRegionIds: ['region-Muscat'],
};

const customerOnRouteA = {
  branches: [{ routeId: 'route-A', regionId: 'region-Muscat', deletedAt: null }],
};
const customerOnRouteX = {
  branches: [{ routeId: 'route-X', regionId: 'region-Dhofar', deletedAt: null }],
};
const customerInScopeRegion = {
  branches: [{ routeId: 'route-A', regionId: 'region-Muscat', deletedAt: null }],
};

const SAL = (id = 'u1') =>
  ({ id, role: Role.SALESMAN, username: 'sal' }) as const;
const SUP = (id = 'u2') =>
  ({ id, role: Role.SUPERVISOR, username: 'sup' }) as const;
const MGR = (id = 'u3') =>
  ({ id, role: Role.MANAGER, username: 'mgr' }) as const;
const STW = (id = 'u4') =>
  ({ id, role: Role.STEWARD, username: 'stw' }) as const;
const VIEW = (id = 'u5') =>
  ({ id, role: Role.VIEWER, username: 'vw' }) as const;

describe('lib/access — canSeeCustomer', () => {
  it('Salesman: sees customers on their route', () => {
    expect(canSeeCustomer(SAL(), customerOnRouteA, baseScope)).toBe(true);
  });
  it('Salesman: cannot see customers off-route (the QA-001 IDOR)', () => {
    expect(canSeeCustomer(SAL(), customerOnRouteX, baseScope)).toBe(false);
  });
  it('Supervisor: sees only their team routes', () => {
    expect(canSeeCustomer(SUP(), customerOnRouteA, baseScope)).toBe(true);
    expect(canSeeCustomer(SUP(), customerOnRouteX, baseScope)).toBe(false);
  });
  it('Manager with regions: scoped by region', () => {
    expect(canSeeCustomer(MGR(), customerInScopeRegion, baseScope)).toBe(true);
    expect(canSeeCustomer(MGR(), customerOnRouteX, baseScope)).toBe(false);
  });
  // RBAC-05-012: an unscoped Manager used to default to "see everything" —
  // combined with imports auto-creating phantom regions (CHAIN-09) this turned
  // a freshly-created or mid-migration Manager into a global-read backdoor.
  // Now defaults to fail-closed.
  it('Manager with NO managedRegions: fail-closed (sees nothing until assigned)', () => {
    expect(
      canSeeCustomer(MGR(), customerOnRouteX, { ...baseScope, managedRegionIds: [] })
    ).toBe(false);
    expect(
      canSeeCustomer(MGR(), customerInScopeRegion, { ...baseScope, managedRegionIds: [] })
    ).toBe(false);
  });
  it('Steward and Viewer: see everything', () => {
    expect(canSeeCustomer(STW(), customerOnRouteX, baseScope)).toBe(true);
    expect(canSeeCustomer(VIEW(), customerOnRouteX, baseScope)).toBe(true);
  });
});

describe('lib/access — canEditCustomer', () => {
  it('Salesman edits only on-route', () => {
    expect(canEditCustomer(SAL(), customerOnRouteA, baseScope)).toBe(true);
    expect(canEditCustomer(SAL(), customerOnRouteX, baseScope)).toBe(false);
  });
  it('Supervisor cannot edit (they approve, not write)', () => {
    expect(canEditCustomer(SUP(), customerOnRouteA, baseScope)).toBe(false);
  });
  it('Viewer cannot edit', () => {
    expect(canEditCustomer(VIEW(), customerOnRouteA, baseScope)).toBe(false);
  });
  it('Steward and Manager (in scope) can edit', () => {
    expect(canEditCustomer(STW(), customerOnRouteX, baseScope)).toBe(true);
    expect(canEditCustomer(MGR(), customerInScopeRegion, baseScope)).toBe(true);
  });
});

// Owner decisions 2026-10-11: one Sales Director for every region in Oman, with
// the GM's access everywhere — org-wide read, every branch, and no direct edit.
describe('lib/access — the Sales Director mirrors the GM', () => {
  const SD = { id: 'u6', role: Role.SALES_DIRECTOR, username: 'sd' } as const;
  const GM = { id: 'u7', role: Role.GM, username: 'gm' } as const;
  const noScope = { ownedRouteId: null, teamRouteIds: [], managedRegionIds: [] };
  const twoRegions = {
    branches: [
      { routeId: 'route-A', regionId: 'region-Muscat', deletedAt: null },
      { routeId: 'route-X', regionId: 'region-Dhofar', deletedAt: null },
      { routeId: 'route-Y', regionId: 'region-Dhofar', deletedAt: new Date() },
    ],
  };

  it('sees every customer, with no region assigned, exactly as the GM does', () => {
    for (const c of [customerOnRouteA, customerOnRouteX, twoRegions]) {
      expect(canSeeCustomer(SD, c, noScope)).toBe(true);
      expect(canSeeCustomer(SD, c, noScope)).toBe(canSeeCustomer(GM, c, noScope));
    }
  });

  it('sees every live branch of a customer, as the GM does', () => {
    const sd = filterBranchesByScope(SD, twoRegions.branches, noScope);
    expect(sd.map((b) => b.routeId)).toEqual(['route-A', 'route-X']);
    expect(sd).toEqual(filterBranchesByScope(GM, twoRegions.branches, noScope));
  });

  it('never edits a customer directly (he approves his step, like the GM)', () => {
    expect(canEditCustomer(SD, customerOnRouteA, baseScope)).toBe(false);
    expect(canEditCustomer(GM, customerOnRouteA, baseScope)).toBe(false);
  });
});
