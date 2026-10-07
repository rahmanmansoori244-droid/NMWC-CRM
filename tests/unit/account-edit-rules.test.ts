/**
 * Owner decision 8 (2026-10-07): the rules of the Data Steward's Edit account
 * and of the leaver/joiner hand-over (lib/account-edit.ts), each on its own.
 * services/users.ts applies them; tests/integration/account-edit.test.ts proves
 * the action on Postgres.
 */
import { describe, it, expect } from 'vitest';
import {
  accountEditAudit,
  changedFields,
  retiredUsername,
  revokesSessions,
  routeHandover,
  routeMoveNotes,
  routeSignInName,
  supervisorCoverIssue,
  type EditableAccount,
  type SupervisorCandidate,
} from '@/lib/account-edit';

const salesman: EditableAccount = {
  role: 'SALESMAN',
  username: 'c4',
  route: 'C4',
  supervisor: 'mct-gt',
  regions: [],
  phone: '+96890000001',
};

describe('a salesman signs in with his route code', () => {
  it('the sign-in name is the code, lower-cased and trimmed', () => {
    expect(routeSignInName('C4')).toBe('c4');
    expect(routeSignInName(' SH01 ')).toBe('sh01');
    expect(routeSignInName('PDO-N')).toBe('pdo-n');
  });

  it('a leaver’s sign-in name is retired with the Oman date, and a counter on a second one that day', () => {
    expect(retiredUsername('c4', '2026-10-07')).toBe('c4.left.20261007');
    expect(retiredUsername('c4', '2026-10-07', 1)).toBe('c4.left.20261007');
    expect(retiredUsername('c4', '2026-10-07', 2)).toBe('c4.left.20261007.2');
    // Still a valid username (services/users.ts usernameRule) and never a demo prefix.
    expect(retiredUsername('pdo-n', '2026-10-07')).toMatch(/^[a-z0-9._-]+$/);
  });
});

describe('a route has one salesman (routeHandover)', () => {
  const leaver = { id: 'u-old', username: 'c4', fullName: 'Old Salesman', isActive: false };

  it('nobody holds it, or the account already does: free', () => {
    expect(
      routeHandover({ routeCode: 'C4', holder: null, targetId: 'u-new', mayHandOver: true })
    ).toEqual({ kind: 'free' });
    expect(
      routeHandover({
        routeCode: 'C4',
        holder: { ...leaver, id: 'u-new', isActive: true },
        targetId: 'u-new',
        mayHandOver: false,
      })
    ).toEqual({ kind: 'free' });
  });

  it('an active holder is never displaced: disable him or move him first', () => {
    const v = routeHandover({
      routeCode: 'C4',
      holder: { ...leaver, isActive: true },
      targetId: 'u-new',
      mayHandOver: true,
    });
    expect(v.kind).toBe('refused');
    if (v.kind === 'refused') {
      expect(v.message).toContain('Old Salesman (c4)');
      expect(v.message).toMatch(
        /disable him first if he has left, or move him to another route first/
      );
    }
  });

  it('a disabled holder (the leaver) hands the route over when the actor may hand routes over', () => {
    expect(
      routeHandover({ routeCode: 'C4', holder: leaver, targetId: null, mayHandOver: true })
    ).toEqual({
      kind: 'handover',
      from: leaver,
    });
  });

  it('a Manager does not hand a route over: that stays the Steward’s', () => {
    expect(
      routeHandover({ routeCode: 'C4', holder: leaver, targetId: null, mayHandOver: false })
    ).toEqual({
      kind: 'refused',
      message: 'That route is already assigned to another salesman.',
    });
  });
});

describe('a supervisor covers the route’s region (supervisorCoverIssue)', () => {
  const mgr = (over: Partial<SupervisorCandidate> = {}): SupervisorCandidate => ({
    id: 'm1',
    role: 'MANAGER',
    isActive: true,
    managedRegionIds: ['MCT'],
    teamRegionIds: [],
    ...over,
  });

  it('a Manager of the route’s region may supervise; one of other regions may not', () => {
    expect(
      supervisorCoverIssue({ supervisor: mgr(), targetId: 's1', routeRegionId: 'MCT' })
    ).toBeNull();
    expect(
      supervisorCoverIssue({
        supervisor: mgr(),
        targetId: 's1',
        routeRegionId: 'SLL',
        routeRegionCode: 'SLL',
      })
    ).toMatch(/does not manage SLL/);
  });

  it('a Supervisor covers the region his team works in, or any while he has no team', () => {
    const sup = (team: string[]) =>
      mgr({ role: 'SUPERVISOR', managedRegionIds: [], teamRegionIds: team });
    expect(
      supervisorCoverIssue({ supervisor: sup([]), targetId: 's1', routeRegionId: 'MCT' })
    ).toBeNull();
    expect(
      supervisorCoverIssue({ supervisor: sup(['MCT']), targetId: 's1', routeRegionId: 'MCT' })
    ).toBeNull();
    expect(
      supervisorCoverIssue({ supervisor: sup(['KHB']), targetId: 's1', routeRegionId: 'MCT' })
    ).toMatch(/works outside/);
  });

  it('refuses a missing, disabled or non-supervising account, and the account itself', () => {
    expect(
      supervisorCoverIssue({ supervisor: null, targetId: 's1', routeRegionId: 'MCT' })
    ).toMatch(/exist and be active/);
    expect(
      supervisorCoverIssue({
        supervisor: mgr({ isActive: false }),
        targetId: 's1',
        routeRegionId: 'MCT',
      })
    ).toMatch(/exist and be active/);
    expect(
      supervisorCoverIssue({
        supervisor: mgr({ role: 'ACCOUNTANT' }),
        targetId: 's1',
        routeRegionId: 'MCT',
      })
    ).toMatch(/Supervisor or a Manager/);
    expect(
      supervisorCoverIssue({ supervisor: mgr({ id: 's1' }), targetId: 's1', routeRegionId: 'MCT' })
    ).toMatch(/cannot report to itself/);
  });

  it('with no route (a Supervisor reporting to a Manager) only the role and state are judged', () => {
    expect(
      supervisorCoverIssue({
        supervisor: mgr({ managedRegionIds: [] }),
        targetId: 's1',
        routeRegionId: null,
      })
    ).toBeNull();
  });
});

describe('the audit row (accountEditAudit)', () => {
  it('holds the before and after of each value that changed, and nothing else', () => {
    const after = { ...salesman, route: 'C5', username: 'c5', supervisor: 'mct-mt' };
    expect(accountEditAudit(salesman, after)).toEqual({
      before: { username: 'c4', route: 'C4', supervisor: 'mct-gt' },
      after: { username: 'c5', route: 'C5', supervisor: 'mct-mt' },
    });
    expect(changedFields(salesman, after)).toEqual(['username', 'route', 'supervisor']);
  });

  it('names a phone change and never copies the number (AuditLog is append-only)', () => {
    const after = { ...salesman, phone: '+96890000002' };
    const row = accountEditAudit(salesman, after)!;
    expect(row).toEqual({ before: {}, after: { changed: ['phone'] } });
    expect(JSON.stringify(row)).not.toMatch(/9000000/);
    expect(accountEditAudit(salesman, { ...salesman, phone: null })).toEqual({
      before: {},
      after: { changed: ['phone'] },
    });
  });

  it('a role change with its regions, as values', () => {
    const mgr: EditableAccount = {
      ...salesman,
      role: 'MANAGER',
      route: null,
      supervisor: null,
      regions: ['KHB', 'MCT'],
    };
    expect(accountEditAudit(salesman, mgr)).toEqual({
      before: { role: 'SALESMAN', route: 'C4', supervisor: 'mct-gt', regions: [] },
      after: { role: 'MANAGER', route: null, supervisor: null, regions: ['KHB', 'MCT'] },
    });
  });

  it('is null when nothing changed, so a save that changes nothing records nothing', () => {
    expect(accountEditAudit(salesman, { ...salesman })).toBeNull();
    expect(changedFields(salesman, { ...salesman })).toEqual([]);
  });
});

describe('sessions end on a change of role or regions (revokesSessions)', () => {
  it('a role change or a region change ends them', () => {
    expect(revokesSessions(salesman, { ...salesman, role: 'VIEWER' })).toBe(true);
    const acc: EditableAccount = { ...salesman, role: 'ACCOUNTANT', regions: ['MCT'] };
    expect(revokesSessions(acc, { ...acc, regions: ['KHB', 'MCT'] })).toBe(true);
  });

  it('a route, supervisor, sign-in name or phone change does not: his scope is read live', () => {
    expect(
      revokesSessions(salesman, {
        ...salesman,
        route: 'C5',
        username: 'c5',
        supervisor: 'x',
        phone: null,
      })
    ).toBe(false);
  });
});

describe('what the Steward is told about open requests (routeMoveNotes)', () => {
  it('requests in review stay with the same approvers; sent-back ones he clears', () => {
    const notes = routeMoveNotes({ who: 'Ali', fromRoute: 'C4', inReview: 2, sentBack: 1 });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/2 request\(s\) in review\. They stay with the same approvers/);
    expect(notes[1]).toMatch(
      /clears it on Needs correction, and the salesman of C4 sends a fresh one/
    );
  });

  it('a leaver sends nothing again', () => {
    const notes = routeMoveNotes({
      who: 'Ali',
      fromRoute: 'C4',
      inReview: 0,
      sentBack: 3,
      leaver: true,
    });
    expect(notes).toEqual([
      expect.stringMatching(/3 request\(s\) sent back to him, which nobody will send again/),
    ]);
  });

  it('says nothing when there is nothing open', () => {
    expect(routeMoveNotes({ who: 'Ali', fromRoute: 'C4', inReview: 0, sentBack: 0 })).toEqual([]);
  });
});
