import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import { canSeeCustomer, canEditCustomer } from '@/lib/access';

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
  it('Manager with NO managedRegions: defaults to global (until assigned)', () => {
    expect(
      canSeeCustomer(MGR(), customerOnRouteX, { ...baseScope, managedRegionIds: [] })
    ).toBe(true);
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
