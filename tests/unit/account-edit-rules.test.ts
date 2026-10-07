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
  compareCodes,
  importNameIssue,
  importRouteHolderIssue,
  importSupervisorCoverIssue,
  retiredUsername,
  revokesSessions,
  routeHandover,
  routeMoveNotes,
  routeSignInName,
  strandedCreatesImportIssue,
  strandedCreatesIssue,
  supervisorCoverIssue,
  supervisorStepNotes,
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
  email: null,
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

  // Security review: a new-customer request in review stays with its approvers,
  // but one sent back after the move cannot be sent again from his new route
  // (services/creates.ts refuses it); he withdraws it.
  it('new-customer requests in review: one sent back cannot be sent again from his new route', () => {
    const notes = routeMoveNotes({
      who: 'Ali',
      fromRoute: 'C4',
      inReview: 3,
      inReviewCreates: 2,
      sentBack: 0,
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/3 request\(s\) in review\. They stay with the same approvers/);
    expect(notes[0]).toMatch(
      /New-customer requests among them \(2\): if one is sent back to him, he cannot send it again from his new route — he withdraws it on Needs correction, and the salesman of C4 adds the shop afresh\./
    );
    // Updates only: nothing about new-customer requests.
    expect(
      routeMoveNotes({
        who: 'Ali',
        fromRoute: 'C4',
        inReview: 1,
        inReviewCreates: 0,
        sentBack: 0,
      })[0]
    ).not.toMatch(/new-customer/);
  });
});

describe('reviewer fixes (2026-10-07)', () => {
  it('the e-mail is named in the audit row like the phone, never copied', () => {
    const row = accountEditAudit(salesman, { ...salesman, email: 'ali@example.test' })!;
    expect(row).toEqual({ before: {}, after: { changed: ['email'] } });
    expect(JSON.stringify(row)).not.toContain('ali@');
    expect(changedFields(salesman, { ...salesman, email: 'ali@example.test' })).toEqual(['email']);
  });

  it('region codes sort one way before and after, so an unchanged set is no change', () => {
    // localeCompare puts "M_B" first, a bare sort() puts "MB" first: before the
    // fix the edit sorted its "before" one way and its "after" the other.
    const codes = ['MB', 'M_B', 'MA'];
    expect([...codes].sort(compareCodes)).toEqual([...codes].sort());
    const mgr: EditableAccount = {
      ...salesman,
      role: 'MANAGER',
      regions: [...codes].sort(compareCodes),
    };
    expect(revokesSessions(mgr, { ...mgr, regions: [...codes].reverse().sort(compareCodes) })).toBe(
      false
    );
  });

  it('a route change with new-customer requests not in review is refused, unless they are withdrawn with it', () => {
    const moved = strandedCreatesIssue({
      who: 'Ali',
      count: 2,
      fromRoutes: ['C4'],
      toRoute: 'C5',
      withdraw: false,
    });
    expect(moved).toMatch(
      /Ali has 2 new-customer request\(s\) started on route C4 that are not in review/
    );
    // Security review: sent again from C5 they are refused, not filed under it;
    // and one sent first stays with C4's approvers only while it is in review.
    expect(moved).toMatch(
      /After the move he cannot send them again from route C5, only withdraw them\./
    );
    expect(moved).not.toMatch(/filed under/);
    expect(moved).toMatch(
      /in review they stay with the approvers of route C4, but if one is sent back after the move he cannot send it again and withdraws it/
    );
    expect(moved).toMatch(/Withdraw them with this change/);
    expect(
      strandedCreatesIssue({
        who: 'Ali',
        count: 1,
        fromRoutes: ['C4'],
        toRoute: null,
        withdraw: false,
      })
    ).toMatch(/Without a route he can never send them again/);
    expect(
      strandedCreatesIssue({
        who: 'Ali',
        count: 2,
        fromRoutes: ['C4'],
        toRoute: 'C5',
        withdraw: true,
      })
    ).toBeNull();
    expect(
      strandedCreatesIssue({ who: 'Ali', count: 0, fromRoutes: [], toRoute: 'C5', withdraw: false })
    ).toBeNull();
    expect(strandedCreatesImportIssue('c4', 2)).toMatch(
      /"c4" has 2 new-customer request\(s\).*Nothing was written/
    );
    expect(strandedCreatesImportIssue('c4', 2)).toMatch(
      /Afterwards he could not send them again from his new route, only withdraw them\./
    );
  });

  it('the notes count withdrawn new-customer requests apart from sent-back updates', () => {
    expect(
      routeMoveNotes({ who: 'Ali', fromRoute: 'C4', inReview: 0, sentBack: 0, withdrawn: 2 })
    ).toEqual([
      expect.stringMatching(
        /^2 new-customer request\(s\) Ali had started on route C4 .* were withdrawn/
      ),
    ]);
  });

  it('a supervisor change moves the Supervisor step only when a Supervisor-role account is involved', () => {
    const mgrA = { name: 'Manager A', role: 'MANAGER' as const };
    const supS = { name: 'Supervisor S', role: 'SUPERVISOR' as const };
    expect(
      supervisorStepNotes({
        who: 'Ali',
        waiting: 3,
        from: mgrA,
        to: { ...mgrA, name: 'Manager B' },
      })
    ).toEqual([]);
    expect(supervisorStepNotes({ who: 'Ali', waiting: 0, from: supS, to: mgrA })).toEqual([]);
    const [lost] = supervisorStepNotes({ who: 'Ali', waiting: 3, from: supS, to: mgrA });
    expect(lost).toMatch(/3 of Ali's requests wait at the Supervisor step/);
    expect(lost).toMatch(/Supervisor S can no longer decide them/);
    expect(lost).toMatch(/Managers of each customer’s region can decide them either way/);
    expect(supervisorStepNotes({ who: 'Ali', waiting: 1, from: mgrA, to: supS })[0]).toMatch(
      /Supervisor S now can, wherever the customer is/
    );
  });

  it('the import holds back a row that names another person on a salesman’s account', () => {
    const base = {
      username: 'c4',
      storedRole: 'SALESMAN' as const,
      storedName: 'Joining  Salesman',
      wantsNameChange: false,
      retired: null,
    };
    // Spaces and case are not a different person.
    expect(importNameIssue({ ...base, rowName: 'joining salesman' })).toBeNull();
    expect(importNameIssue({ ...base, rowName: 'Leaving Salesman' })).toMatch(
      /full_name is not the name of the salesman who signs in as "c4"\. Nothing was written/
    );
    expect(
      importNameIssue({ ...base, rowName: 'Leaving Salesman', retired: 'c4.left.20261007' })
    ).toMatch(
      /"c4" was handed to a new salesman on Users \(the previous one now signs in as "c4\.left\.20261007"\)/
    );
    expect(
      importNameIssue({ ...base, rowName: 'Leaving Salesman', wantsNameChange: true })
    ).toBeNull();
    expect(importNameIssue({ ...base, storedRole: 'VIEWER', rowName: 'Someone Else' })).toBeNull();
  });

  it('the import takes a route from an active salesman only on change_route=yes', () => {
    const p = { username: 'new.one', routeCode: 'C4', wantsRouteChange: false };
    expect(importRouteHolderIssue({ ...p, holder: null })).toBeNull();
    expect(
      importRouteHolderIssue({ ...p, holder: { username: 'c4', isActive: false } })
    ).toBeNull();
    expect(
      importRouteHolderIssue({ ...p, holder: { username: 'new.one', isActive: true } })
    ).toBeNull();
    expect(importRouteHolderIssue({ ...p, holder: { username: 'c4', isActive: true } })).toMatch(
      /route C4 is worked by "c4", whose account is active\. Nothing was written for "new\.one"/
    );
    expect(
      importRouteHolderIssue({
        ...p,
        wantsRouteChange: true,
        holder: { username: 'c4', isActive: true },
      })
    ).toBeNull();
  });

  it('the import judges a supervisor’s cover of the route’s region in its own words', () => {
    const mgr: SupervisorCandidate = {
      id: 'm1',
      role: 'MANAGER',
      isActive: true,
      managedRegionIds: ['g-mct'],
      teamRegionIds: [],
    };
    const p = {
      username: 'c4',
      supervisorUsername: 'mct-gt',
      targetId: 's1',
      routeCode: 'K1',
      routeRegionId: 'g-khb',
      regionCode: 'KHB',
    };
    expect(importSupervisorCoverIssue({ ...p, supervisor: mgr })).toBe(
      'supervisor "mct-gt" does not cover region KHB, where route K1 is: a MANAGER must manage the region, and a SUPERVISOR\'s team must work in it. Nothing was written for "c4". Name a supervisor who covers region KHB in supervisor_username.'
    );
    expect(
      importSupervisorCoverIssue({ ...p, supervisor: { ...mgr, managedRegionIds: ['g-khb'] } })
    ).toBeNull();
    expect(importSupervisorCoverIssue({ ...p, supervisor: { ...mgr, isActive: false } })).toMatch(
      /^supervisor "mct-gt" is deactivated or missing/
    );
  });
});
