// @vitest-environment node
/**
 * F1 (2026-10-05): which outbox rows are e-mailed (lib/email/eligibility.ts),
 * decided on the recipient and the request as they are at send time.
 */
import { describe, it, expect } from 'vitest';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { canActOnStep } from '@/lib/permissions';
import {
  escalationReaches,
  planRun,
  rowVerdict,
  waitsOn,
  type OutboxRow,
  type RecentSends,
  type Recipient,
  type RequestNow,
} from '@/lib/email/eligibility';
import { EMAIL_ACT_ONLY_ROLES, EMAIL_DELIVERY, EMAIL_KINDS, EMAIL_ROLES } from '@/lib/notify-policy';
import { escalationPlan } from '@/lib/escalation';

const NOW = new Date('2026-10-05T08:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);
const REGION = 'g-north';
const OTHER = 'g-south';
const none = (): RecentSends => ({ any: new Set(), action: new Set() });

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: 'n1',
  userId: 'u1',
  kind: 'EDIT_SUBMITTED',
  editId: 'e1',
  createdAt: ago(5),
  readAt: null,
  ...over,
});
const who = (role: Role, over: Partial<Recipient> = {}): Recipient => ({
  id: 'u1',
  role,
  isActive: true,
  email: 'person@example.test',
  username: 'person.x',
  managedRegionIds: [REGION],
  ...over,
});
const req = (over: Partial<RequestNow> = {}): RequestNow => ({
  id: 'e1',
  state: 'SUBMITTED',
  process: 'UPDATE',
  target: 'CUSTOMER',
  isReactivation: false,
  approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
  currentStepIndex: 0,
  pendingRole: null,
  submittedById: 's1',
  submitterSupervisorId: 'u1',
  otherStepActorIds: [],
  scopeRegionIds: [REGION],
  ...over,
});

describe('the allowlists', () => {
  it('information goes to MANAGER, SUPERVISOR, ACCOUNTANT and FINANCE_MANAGER only — never the GM, whatever the row', () => {
    for (const role of Object.values(Role)) {
      const v = rowVerdict(row({ kind: 'REQUEST_FYI' }), who(role), req(), NOW);
      const allowed = ([Role.MANAGER, Role.SUPERVISOR, Role.ACCOUNTANT, Role.FINANCE_MANAGER] as Role[]).includes(role);
      expect(v.send ? 'send' : (v as { status: string }).status, role).toBe(allowed ? 'send' : 'SKIPPED_ROLE');
    }
    // Owner decision 6 (2026-10-07): the GM is e-mailed, for work waiting on him only.
    expect([...EMAIL_ROLES].sort()).toEqual(['ACCOUNTANT', 'FINANCE_MANAGER', 'GM', 'MANAGER', 'SUPERVISOR']);
    expect([...EMAIL_ACT_ONLY_ROLES]).toEqual(['GM']);
  });

  it('a Steward, a Viewer or a salesman is never e-mailed, even a row that would ask him to act', () => {
    for (const role of [Role.STEWARD, Role.VIEWER, Role.SALESMAN]) {
      for (const kind of ['EDIT_SUBMITTED', 'EDIT_STAGE_ADVANCED', 'REACTIVATION_REQUESTED', 'SLA_BREACH']) {
        expect(rowVerdict(row({ kind }), who(role), req(), NOW), `${role} ${kind}`).toEqual({ send: false, status: 'SKIPPED_ROLE' });
      }
    }
  });

  it('only the e-mailed kinds — SLA breaches now among them (owner decision 6); the salesman-facing kinds are not', () => {
    expect([...EMAIL_KINDS].sort()).toEqual(['EDIT_STAGE_ADVANCED', 'EDIT_SUBMITTED', 'REACTIVATION_REQUESTED', 'REQUEST_FYI', 'SLA_BREACH']);
    for (const kind of ['EDIT_APPROVED_FINAL', 'EDIT_NEEDS_CORRECTION', 'TEMIX_UPLOAD_READY', 'TEMIX_SYNC_ACKED']) {
      expect(rowVerdict(row({ kind }), who(Role.MANAGER), req(), NOW), kind).toEqual({ send: false, status: 'SKIPPED_KIND' });
    }
  });
});

describe('owner decision 6: the GM is e-mailed work waiting on him', () => {
  const credit = (step: number, over: Partial<RequestNow> = {}) =>
    req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT), currentStepIndex: step, ...over });
  const gm = who(Role.GM, { id: 'gm', managedRegionIds: [] });

  it('a credit request at the GM step is e-mailed to him, as "now at your approval step"', () => {
    const atGm = credit(2, { pendingRole: Role.GM });
    expect(rowVerdict(row({ userId: 'gm', kind: 'EDIT_STAGE_ADVANCED' }), gm, atGm, NOW)).toEqual({
      send: true,
      item: { kind: 'EDIT_STAGE_ADVANCED', editId: 'e1', requestType: 'CREATE' },
    });
  });

  it('not before it reaches him, not once it moved past him, not if he decided another step, not information', () => {
    for (const step of [0, 1, 3]) {
      expect(rowVerdict(row({ userId: 'gm', kind: 'EDIT_STAGE_ADVANCED' }), gm, credit(step), NOW), `step ${step}`).toEqual({
        send: false,
        status: 'SKIPPED_RESOLVED',
      });
    }
    expect(rowVerdict(row({ userId: 'gm', kind: 'EDIT_STAGE_ADVANCED' }), gm, credit(2, { state: 'APPROVED' }), NOW)).toEqual({
      send: false,
      status: 'SKIPPED_RESOLVED',
    });
    expect(rowVerdict(row({ userId: 'gm', kind: 'EDIT_STAGE_ADVANCED' }), gm, credit(2, { otherStepActorIds: ['gm'] }), NOW)).toEqual({
      send: false,
      status: 'SKIPPED_RESOLVED',
    });
    // An update or a cash request never waits on the GM.
    expect(rowVerdict(row({ userId: 'gm' }), gm, req(), NOW)).toEqual({ send: false, status: 'SKIPPED_RESOLVED' });
    expect(rowVerdict(row({ userId: 'gm', kind: 'REQUEST_FYI' }), gm, credit(2), NOW)).toEqual({ send: false, status: 'SKIPPED_ROLE' });
  });
});

describe('owner decision 6: a late request (SLA_BREACH) goes to the people the escalation tells', () => {
  const sla = (userId: string) => row({ userId, kind: 'SLA_BREACH' });
  const verdict = (r: Recipient, edit: RequestNow) => {
    const v = rowVerdict(sla(r.id), r, edit, NOW);
    return v.send ? 'send' : v.status;
  };
  const manager = who(Role.MANAGER, { id: 'm-in' });
  const farManager = who(Role.MANAGER, { id: 'm-far', managedRegionIds: [OTHER] });
  const gm = who(Role.GM, { id: 'gm', managedRegionIds: [] });
  const fm = who(Role.FINANCE_MANAGER, { id: 'fm', managedRegionIds: [] });
  const acc = who(Role.ACCOUNTANT, { id: 'acc' });

  it('late at the Supervisor step: the region’s Managers, then the GM; nobody else', () => {
    for (const pendingRole of [Role.SUPERVISOR, null]) {
      const e = req({ pendingRole });
      expect(verdict(manager, e)).toBe('send');
      expect(verdict(gm, e)).toBe('send');
      expect(verdict(farManager, e)).toBe('SKIPPED_RESOLVED');
      expect(verdict(fm, e)).toBe('SKIPPED_RESOLVED');
      expect(verdict(acc, e)).toBe('SKIPPED_RESOLVED');
    }
    const v = rowVerdict(sla('m-in'), manager, req(), NOW);
    expect(v).toEqual({ send: true, item: { kind: 'SLA_BREACH', editId: 'e1', requestType: 'UPDATE' } });
  });

  it('late at a later step, or a reactivation: the plan’s people for that step', () => {
    const credit = (step: number, pendingRole: Role) =>
      req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT), currentStepIndex: step, pendingRole });
    expect([fm, gm, manager].map((r) => verdict(r, credit(3, Role.ACCOUNTANT)))).toEqual(['send', 'send', 'SKIPPED_RESOLVED']);
    expect([gm, fm, manager].map((r) => verdict(r, credit(1, Role.FINANCE_MANAGER)))).toEqual(['send', 'SKIPPED_RESOLVED', 'SKIPPED_RESOLVED']);
    expect([manager, farManager, fm].map((r) => verdict(r, credit(2, Role.GM)))).toEqual(['send', 'SKIPPED_RESOLVED', 'SKIPPED_RESOLVED']);
    const react = req({ isReactivation: true, target: 'BRANCH', approvalChain: null, pendingRole: Role.MANAGER });
    expect([gm, manager].map((r) => verdict(r, react))).toEqual(['send', 'SKIPPED_RESOLVED']);
  });

  it('never once the request is decided, never the submitter', () => {
    for (const state of ['APPROVED', 'NEEDS_CORRECTION', 'REJECTED']) {
      expect(verdict(manager, req({ state })), state).toBe('SKIPPED_RESOLVED');
      expect(verdict(gm, req({ state })), state).toBe('SKIPPED_RESOLVED');
    }
    expect(verdict(who(Role.MANAGER, { id: 's1' }), req())).toBe('SKIPPED_RESOLVED');
  });

  it('answers as lib/escalation.ts plans, at either level, for every role and step', () => {
    const steps: Array<Role | null> = [null, Role.SUPERVISOR, Role.MANAGER, Role.ACCOUNTANT, Role.FINANCE_MANAGER, Role.GM];
    for (const pendingRole of steps) {
      const plans = [escalationPlan(pendingRole, 1), escalationPlan(pendingRole, 2)];
      for (const role of Object.values(Role)) {
        for (const managedRegionIds of [[REGION], [OTHER]]) {
          const r = who(role, { id: 'x9', managedRegionIds });
          const named = plans.some(
            (p) =>
              p.globalRoles.includes(role) ||
              (p.regionScopedRoles.includes(role) && managedRegionIds.includes(REGION)) ||
              // The sweep's fallback for a region nobody covers.
              (p.regionScopedRoles.length > 0 && role === Role.GM)
          );
          expect(escalationReaches(r, req({ pendingRole })), `${pendingRole} ${role} ${managedRegionIds}`).toBe(named);
        }
      }
    }
  });
});

describe('rowVerdict, in order', () => {
  it('too old', () => {
    expect(rowVerdict(row({ createdAt: new Date(NOW.getTime() - EMAIL_DELIVERY.maxAgeMs - 1) }), who(Role.MANAGER), req(), NOW)).toEqual({
      send: false,
      status: 'SKIPPED_STALE',
    });
  });
  it('a disabled account, or no usable address', () => {
    expect(rowVerdict(row(), who(Role.MANAGER, { isActive: false }), req(), NOW)).toEqual({ send: false, status: 'SKIPPED_INACTIVE' });
    expect(rowVerdict(row(), undefined, req(), NOW)).toEqual({ send: false, status: 'SKIPPED_INACTIVE' });
    for (const email of [null, '', '  ', 'not-an-address', 'a@b']) {
      expect(rowVerdict(row(), who(Role.MANAGER, { email }), req(), NOW), String(email)).toEqual({
        send: false,
        status: 'SKIPPED_NO_ADDRESS',
      });
    }
  });
  it('a seeded demo or test account, whatever its role', () => {
    for (const username of ['manager.a', 'supervisor.north', 'steward', 'admin']) {
      expect(rowVerdict(row(), who(Role.MANAGER, { username }), req(), NOW), username).toEqual({ send: false, status: 'SKIPPED_DEMO' });
    }
  });
  it('already read in the app', () => {
    expect(rowVerdict(row({ readAt: ago(1) }), who(Role.MANAGER), req(), NOW)).toEqual({ send: false, status: 'SKIPPED_READ' });
  });
  it('its request is gone', () => {
    expect(rowVerdict(row(), who(Role.MANAGER), undefined, NOW)).toEqual({ send: false, status: 'SKIPPED_RESOLVED' });
    expect(rowVerdict(row({ editId: null }), who(Role.MANAGER), req(), NOW)).toEqual({ send: false, status: 'SKIPPED_RESOLVED' });
  });
  it('a must-act row whose request was decided', () => {
    for (const state of ['APPROVED', 'NEEDS_CORRECTION', 'REJECTED']) {
      expect(rowVerdict(row(), who(Role.MANAGER), req({ state }), NOW), state).toEqual({ send: false, status: 'SKIPPED_RESOLVED' });
    }
  });
  it('an FYI row is sent while its request exists, decided or not', () => {
    const v = rowVerdict(row({ kind: 'REQUEST_FYI' }), who(Role.ACCOUNTANT), req({ state: 'APPROVED' }), NOW);
    expect(v).toEqual({ send: true, item: { kind: 'REQUEST_FYI', editId: 'e1', requestType: 'UPDATE' } });
  });
});

describe('waitsOn: has the request moved past him, and can he act on it?', () => {
  const cash = (over: Partial<RequestNow> = {}) =>
    req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH), ...over });
  const credit = () => req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT) });

  it('the supervisor, while the request is at the Supervisor step; not once it moved on, though it is still SUBMITTED', () => {
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', cash())).toBe(true);
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', { ...cash(), currentStepIndex: 1 })).toBe(false);
  });

  it('a Supervisor who is not the submitter’s supervisor does not; a Manager of the request’s region does (close fallback, RBAC-05-003)', () => {
    expect(waitsOn(who(Role.SUPERVISOR, { id: 'other' }), 'EDIT_SUBMITTED', req())).toBe(false);
    expect(waitsOn(who(Role.SUPERVISOR), 'EDIT_SUBMITTED', req())).toBe(true);
    expect(waitsOn(who(Role.MANAGER, { id: 'm2' }), 'EDIT_SUBMITTED', req({ target: 'BRANCH' }))).toBe(true);
  });

  it('a Manager outside the request’s region is not e-mailed, even as the salesman’s supervisor — the page refuses him', () => {
    // supervisorId points at him, but he does not manage the route region (the
    // readiness script's "Manager does not manage the route region"), or the
    // Steward moved the salesman after he submitted.
    expect(waitsOn(who(Role.MANAGER, { managedRegionIds: [OTHER] }), 'EDIT_SUBMITTED', req())).toBe(false);
    expect(waitsOn(who(Role.MANAGER, { managedRegionIds: [] }), 'EDIT_SUBMITTED', req())).toBe(false);
    expect(waitsOn(who(Role.MANAGER, { id: 'm2', managedRegionIds: [OTHER] }), 'EDIT_SUBMITTED', req({ target: 'BRANCH' }))).toBe(false);
    // A request whose scope reads nothing (its customer gone) waits on no Manager.
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', req({ scopeRegionIds: [] }))).toBe(false);
    // A new-customer request is scoped by its DRAFT routes' region.
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', cash({ scopeRegionIds: [OTHER] }))).toBe(false);
  });

  it('EDIT_STAGE_ADVANCED: the step that must act now, in scope, and nobody else', () => {
    const atFm = { ...credit(), currentStepIndex: 1 };
    expect(waitsOn(who(Role.FINANCE_MANAGER, { id: 'fm', managedRegionIds: [] }), 'EDIT_STAGE_ADVANCED', atFm)).toBe(true);
    expect(waitsOn(who(Role.FINANCE_MANAGER, { id: 'fm' }), 'EDIT_STAGE_ADVANCED', { ...atFm, currentStepIndex: 2 })).toBe(false);
    expect(waitsOn(who(Role.ACCOUNTANT, { id: 'a' }), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 1 })).toBe(true);
    // The Accountant step is region-scoped: another region's Accountant cannot act on it.
    expect(waitsOn(who(Role.ACCOUNTANT, { id: 'a', managedRegionIds: [OTHER] }), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 1 })).toBe(false);
    // Returned to the Supervisor step by a step-back: his row again.
    expect(waitsOn(who(Role.MANAGER), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 0 })).toBe(true);
  });

  it('answers as canActOnStep does — the rule the decision applies — for every role and scope', () => {
    const chains = [cash(), { ...cash(), currentStepIndex: 1 }, credit(), { ...credit(), currentStepIndex: 1 }, { ...credit(), currentStepIndex: 2 }, { ...credit(), currentStepIndex: 3 }, req()];
    for (const edit of chains) {
      for (const role of EMAIL_ROLES) {
        for (const managedRegionIds of [[REGION], [OTHER], []]) {
          for (const id of ['u1', 'x9']) {
            const r = who(role, { id, managedRegionIds });
            const step = (edit.approvalChain as Array<{ role: Role; scope: 'SUPERVISOR_OF_SUBMITTER' | 'REGION_OVERLAP' | 'GLOBAL' }>)[edit.currentStepIndex]!;
            const expected = canActOnStep(r, step, { id: edit.submittedById, supervisorId: edit.submitterSupervisorId }, {
              customerBranches: edit.scopeRegionIds.map((regionId) => ({ regionId, deletedAt: null })),
              managedRegionIds,
              priorStepActorIds: edit.otherStepActorIds,
            });
            expect(waitsOn(r, 'EDIT_STAGE_ADVANCED', edit), `${role} ${id} ${managedRegionIds} step ${edit.currentStepIndex}`).toBe(expected);
          }
        }
      }
    }
  });

  it('the recorded pending role must agree with the step the pointer names', () => {
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', { ...cash(), pendingRole: Role.SUPERVISOR })).toBe(true);
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', { ...cash(), pendingRole: Role.ACCOUNTANT })).toBe(false);
  });

  it('never the submitter, never someone who decided another step this cycle, never a reactivation on /approvals', () => {
    expect(waitsOn(who(Role.MANAGER, { id: 's1' }), 'EDIT_SUBMITTED', req())).toBe(false);
    expect(waitsOn(who(Role.ACCOUNTANT, { id: 'a' }), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 1, otherStepActorIds: ['a'] })).toBe(false);
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', req({ isReactivation: true }))).toBe(false);
  });

  it('REACTIVATION_REQUESTED: a Manager of the branch’s region while it is open — the decide gate', () => {
    const r = req({ isReactivation: true, target: 'BRANCH', approvalChain: null });
    expect(waitsOn(who(Role.MANAGER), 'REACTIVATION_REQUESTED', r)).toBe(true);
    expect(waitsOn(who(Role.ACCOUNTANT), 'REACTIVATION_REQUESTED', r)).toBe(false);
    expect(waitsOn(who(Role.MANAGER), 'REACTIVATION_REQUESTED', { ...r, state: 'APPROVED' })).toBe(false);
    // The branch's region moved, or he never managed it: approveReactivationCore refuses him.
    expect(waitsOn(who(Role.MANAGER, { managedRegionIds: [OTHER] }), 'REACTIVATION_REQUESTED', r)).toBe(false);
    expect(waitsOn(who(Role.MANAGER), 'REACTIVATION_REQUESTED', { ...r, scopeRegionIds: [] })).toBe(false);
    expect(waitsOn(who(Role.MANAGER, { id: 's1' }), 'REACTIVATION_REQUESTED', r)).toBe(false);
  });
});

describe('planRun', () => {
  const recipients = new Map<string, Recipient>([
    ['m1', who(Role.MANAGER, { id: 'm1', email: 'm1@example.test' })],
    ['m2', who(Role.MANAGER, { id: 'm2', email: 'm2@example.test' })],
    ['a1', who(Role.ACCOUNTANT, { id: 'a1', email: 'a1@example.test' })],
    ['a2', who(Role.ACCOUNTANT, { id: 'a2', email: 'a2@example.test' })],
    ['a3', who(Role.ACCOUNTANT, { id: 'a3', email: 'a3@example.test' })],
    ['gm', who(Role.GM, { id: 'gm', email: 'gm@example.test' })],
  ]);
  const edits = new Map<string, RequestNow>([
    ['e1', req({ id: 'e1', submitterSupervisorId: 'm1' })],
    ['e2', req({ id: 'e2', submitterSupervisorId: 'm2' })],
    [
      'c1',
      req({ id: 'c1', process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH), currentStepIndex: 1, submitterSupervisorId: 'm1' }),
    ],
  ]);
  const plan = (rows: OutboxRow[], over: Partial<Parameters<typeof planRun>[0]> = {}) =>
    planRun({ rows, recipients, edits, now: NOW, recentlySent: none(), sentLast24h: 0, informationSentLast24h: 0, ...over });

  it('one digest per recipient, one line per request (action beats information), skips recorded', () => {
    const p = plan([
      row({ id: 'r1', userId: 'm1', kind: 'EDIT_SUBMITTED', editId: 'e1' }),
      row({ id: 'r2', userId: 'm1', kind: 'REQUEST_FYI', editId: 'e1' }),
      row({ id: 'r3', userId: 'a1', kind: 'REQUEST_FYI', editId: 'e1' }),
      row({ id: 'r4', userId: 'a1', kind: 'REQUEST_FYI', editId: 'e2' }),
      row({ id: 'r5', userId: 'gm', kind: 'EDIT_STAGE_ADVANCED', editId: 'e1' }),
    ]);
    // The GM is e-mailed now (owner decision 6), but an update never waits on him.
    expect(p.skips).toEqual([{ id: 'r5', status: 'SKIPPED_RESOLVED' }]);
    expect(p.digests.map((d) => [d.userId, d.rowIds, d.items.map((i) => `${i.kind}:${i.editId}`), d.informationOnly])).toEqual([
      ['m1', ['r1', 'r2'], ['EDIT_SUBMITTED:e1'], false],
      ['a1', ['r3', 'r4'], ['REQUEST_FYI:e1', 'REQUEST_FYI:e2'], true],
    ]);
    expect(p.digests[0]!.address).toBe('m1@example.test');
    expect(p.capped).toBe(false);
  });

  it('a recipient e-mailed within the gap waits; his rows go back', () => {
    const p = plan([row({ id: 'r1', userId: 'm1' }), row({ id: 'r2', userId: 'a1', kind: 'REQUEST_FYI' })], {
      recentlySent: { any: new Set(['m1']), action: new Set(['m1']) },
    });
    expect(p.deferred).toEqual(['r1']);
    expect(p.digests.map((d) => d.userId)).toEqual(['a1']);
  });

  it('the gap is per class: an FYI-only e-mail does not hold back a later "now at your step"', () => {
    // 10:00 the Accountant was sent information only; 10:01 a cash new-customer
    // request reached his step. It goes now, not at 10:40.
    const atHisStep = row({ id: 'act', userId: 'a1', kind: 'EDIT_STAGE_ADVANCED', editId: 'c1' });
    const moreInfo = row({ id: 'fyi', userId: 'a2', kind: 'REQUEST_FYI', editId: 'e1' });
    const p = plan([atHisStep, moreInfo], { recentlySent: { any: new Set(['a1', 'a2']), action: new Set() } });
    expect(p.digests.map((d) => d.userId)).toEqual(['a1']);
    expect(p.deferred).toEqual(['fyi']);
    // An e-mail that asked him to act still holds back the next one, of either class.
    const held = plan([atHisStep], { recentlySent: { any: new Set(['a1']), action: new Set(['a1']) } });
    expect(held.digests).toEqual([]);
    expect(held.deferred).toEqual(['act']);
  });

  it('a late request and a "please review" are one digest for the person, one line per request (no e-mail storm)', () => {
    const p = plan([
      row({ id: 's1', userId: 'm1', kind: 'SLA_BREACH', editId: 'e1' }),
      row({ id: 's2', userId: 'm1', kind: 'EDIT_SUBMITTED', editId: 'e1' }),
      row({ id: 's3', userId: 'm1', kind: 'SLA_BREACH', editId: 'e2' }),
      row({ id: 's4', userId: 'gm', kind: 'SLA_BREACH', editId: 'e1' }),
      row({ id: 's5', userId: 'gm', kind: 'SLA_BREACH', editId: 'e2' }),
    ]);
    expect(p.skips).toEqual([]);
    expect(p.digests.map((d) => [d.userId, d.rowIds, d.items.map((i) => `${i.kind}:${i.editId}`), d.informationOnly])).toEqual([
      ['m1', ['s1', 's2', 's3'], ['EDIT_SUBMITTED:e1', 'SLA_BREACH:e2'], false],
      ['gm', ['s4', 's5'], ['SLA_BREACH:e1', 'SLA_BREACH:e2'], false],
    ]);
  });

  it('the caps hold back whole digests — information before work, then newest first — and say so', () => {
    const rows = [
      row({ id: 'old', userId: 'a1', kind: 'REQUEST_FYI', createdAt: ago(50) }),
      row({ id: 'new', userId: 'm1', createdAt: ago(1) }),
    ];
    const perRun = plan(rows, { policy: { ...EMAIL_DELIVERY, perRunCap: 1 } });
    expect(perRun.digests.map((d) => d.userId)).toEqual(['m1']);
    expect(perRun.deferred).toEqual(['old']);
    expect(perRun.capped).toBe(true);
    const daily = plan(rows, { sentLast24h: EMAIL_DELIVERY.dailyCap });
    expect(daily.digests).toEqual([]);
    expect(daily.deferred.sort()).toEqual(['new', 'old']);
    expect(daily.capped).toBe(true);
    // Within a class, oldest first.
    const twoFyi = plan(
      [row({ id: 'y', userId: 'a2', kind: 'REQUEST_FYI', createdAt: ago(5) }), row({ id: 'x', userId: 'a1', kind: 'REQUEST_FYI', createdAt: ago(40) })],
      { policy: { ...EMAIL_DELIVERY, perRunCap: 1 } }
    );
    expect(twoFyi.digests.map((d) => d.userId)).toEqual(['a1']);
  });

  it('FYI-only digests beyond the cap never crowd out a must-act digest', () => {
    // Three Accountants' information, all older than one Manager's "please review".
    const rows = [
      row({ id: 'f1', userId: 'a1', kind: 'REQUEST_FYI', createdAt: ago(60) }),
      row({ id: 'f2', userId: 'a2', kind: 'REQUEST_FYI', createdAt: ago(50) }),
      row({ id: 'f3', userId: 'a3', kind: 'REQUEST_FYI', createdAt: ago(40) }),
      row({ id: 'act', userId: 'm1', kind: 'EDIT_SUBMITTED', editId: 'e1', createdAt: ago(1) }),
    ];
    const p = plan(rows, { policy: { ...EMAIL_DELIVERY, perRunCap: 2 } });
    expect(p.digests.map((d) => d.userId)).toEqual(['m1', 'a1']);
    expect(p.deferred.sort()).toEqual(['f2', 'f3']);
    expect(p.capped).toBe(true);
  });

  it('information-only digests stop at their share of the day; work still goes', () => {
    const rows = [
      row({ id: 'f1', userId: 'a1', kind: 'REQUEST_FYI', createdAt: ago(60) }),
      row({ id: 'act', userId: 'm1', kind: 'EDIT_SUBMITTED', editId: 'e1', createdAt: ago(1) }),
    ];
    const p = plan(rows, {
      sentLast24h: EMAIL_DELIVERY.informationDailyCap,
      informationSentLast24h: EMAIL_DELIVERY.informationDailyCap,
    });
    expect(p.digests.map((d) => d.userId)).toEqual(['m1']);
    expect(p.deferred).toEqual(['f1']);
    expect(p.capped).toBe(true);
    expect(EMAIL_DELIVERY.informationDailyCap).toBeLessThan(EMAIL_DELIVERY.dailyCap);
  });
});
