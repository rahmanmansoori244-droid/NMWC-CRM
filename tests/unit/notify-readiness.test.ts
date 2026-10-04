// @vitest-environment node
/**
 * F1 (2026-10-05): scripts/ops/notify-readiness.ts counts the gaps that would
 * make a salesman's request reach nobody, or reach someone who cannot open it.
 * Synthetic rows only; the script itself prints counts and fixed words, which
 * the last case checks against every id and address in the input.
 */
import { describe, it, expect } from 'vitest';
import { Role } from '@prisma/client';
import {
  formatReadiness,
  readinessReport,
  type ReadinessUser,
} from '../../scripts/ops/notify-readiness';

const u = (id: string, role: Role, over: Partial<ReadinessUser> = {}): ReadinessUser => ({
  id,
  role,
  isActive: true,
  email: null,
  supervisorId: null,
  routeRegionId: null,
  managedRegionIds: [],
  ...over,
});

const REGIONS = [
  { id: 'g1', isActive: true },
  { id: 'g2', isActive: true },
  { id: 'g3', isActive: false },
];

const USERS: ReadinessUser[] = [
  u('m1', Role.MANAGER, { email: 'mgr.one@example.test', managedRegionIds: ['g1'] }),
  u('m2', Role.MANAGER, { email: 'mgr-two-at-example', managedRegionIds: ['g1'] }),
  u('m3', Role.MANAGER, { isActive: false, email: 'old.mgr@example.test', managedRegionIds: ['g2'] }),
  u('a1', Role.ACCOUNTANT, { email: 'MGR.ONE@example.test', managedRegionIds: ['g1'] }),
  u('fm-1', Role.FINANCE_MANAGER),
  u('gm-1', Role.GM, { email: 'gm@example.test' }),
  u('stw-1', Role.STEWARD),
  // salesmen
  u('s-ok', Role.SALESMAN, { supervisorId: 'm1', routeRegionId: 'g1' }),
  u('s-none', Role.SALESMAN, { routeRegionId: 'g1' }),
  u('s-inactive', Role.SALESMAN, { supervisorId: 'm3', routeRegionId: 'g2' }),
  u('s-role', Role.SALESMAN, { supervisorId: 'gm-1', routeRegionId: 'g1' }),
  u('s-region', Role.SALESMAN, { supervisorId: 'm1', routeRegionId: 'g2' }),
  u('s-noroute', Role.SALESMAN, { supervisorId: 'm1' }),
  u('s-gone', Role.SALESMAN, { isActive: false, routeRegionId: 'g1' }),
];

describe('readinessReport', () => {
  const r = readinessReport(USERS, REGIONS);

  it('counts approvers with, without and with a malformed address, active accounts only', () => {
    expect(r.approvers.MANAGER).toEqual({ withEmail: 1, without: 0, malformed: 1 });
    expect(r.approvers.ACCOUNTANT).toEqual({ withEmail: 1, without: 0, malformed: 0 });
    expect(r.approvers.FINANCE_MANAGER).toEqual({ withEmail: 0, without: 1, malformed: 0 });
    expect(r.approvers.SUPERVISOR).toEqual({ withEmail: 0, without: 0, malformed: 0 });
    // GM and Steward are never e-mailed, so they are not readiness rows at all.
    expect(Object.keys(r.approvers).sort()).toEqual(['ACCOUNTANT', 'FINANCE_MANAGER', 'MANAGER', 'SUPERVISOR']);
  });

  it('names each way a salesman’s request would reach no usable supervisor', () => {
    expect(r.salesmen).toEqual({
      active: 6,
      noSupervisor: 1,
      supervisorInactive: 1,
      supervisorWrongRole: 1,
      managerNotOverRegion: 1,
      noRoute: 1,
    });
  });

  it('finds active regions with no active Accountant or Manager (an inactive holder does not count)', () => {
    expect(r.regions).toEqual({ active: 2, noAccountant: 1, noManager: 1 });
  });

  it('finds an address held twice once case is ignored', () => {
    expect(r.caseDuplicates).toEqual({ groups: 1, accounts: 2 });
  });

  it('prints counts and fixed words only: no id and no address from the input', () => {
    const text = formatReadiness(r).join('\n');
    for (const row of USERS) {
      expect(text).not.toContain(row.id);
      if (row.email) expect(text.toLowerCase()).not.toContain(row.email.toLowerCase());
    }
    expect(text).toContain('E-mail addresses held by more than one account');
  });
});

describe('the readiness address rule is the drain’s', () => {
  it('answers as lib/email/config.ts isEmailAddress does', async () => {
    const { isEmailAddress } = await import('@/lib/email/config');
    const { readinessAddress } = await import('../../scripts/ops/notify-readiness');
    const cases = ['a.b@example.test', 'a@b', 'a b@example.test', 'a@example.test, c@example.test', '<a@example.test>', 'a"b@example.test', `${'x'.repeat(250)}@example.test`];
    for (const c of cases) expect(readinessAddress(c), c).toBe(isEmailAddress(c));
  });
});
