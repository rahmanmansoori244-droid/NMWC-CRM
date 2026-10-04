// @vitest-environment node
/**
 * F1 (2026-10-05): which outbox rows are e-mailed (lib/email/eligibility.ts),
 * decided on the recipient and the request as they are at send time.
 */
import { describe, it, expect } from 'vitest';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { planRun, rowVerdict, waitsOn, type OutboxRow, type Recipient, type RequestNow } from '@/lib/email/eligibility';
import { EMAIL_DELIVERY, EMAIL_KINDS, EMAIL_ROLES } from '@/lib/notify-policy';

const NOW = new Date('2026-10-05T08:00:00.000Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000);

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
  ...over,
});

describe('the allowlists', () => {
  it('no role but MANAGER, SUPERVISOR, ACCOUNTANT and FINANCE_MANAGER is ever e-mailed — whatever the row', () => {
    for (const role of Object.values(Role)) {
      const v = rowVerdict(row({ kind: 'REQUEST_FYI' }), who(role), req(), NOW);
      const allowed = ([Role.MANAGER, Role.SUPERVISOR, Role.ACCOUNTANT, Role.FINANCE_MANAGER] as Role[]).includes(role);
      expect(v.send ? 'send' : (v as { status: string }).status, role).toBe(allowed ? 'send' : 'SKIPPED_ROLE');
    }
    expect([...EMAIL_ROLES].sort()).toEqual(['ACCOUNTANT', 'FINANCE_MANAGER', 'MANAGER', 'SUPERVISOR']);
  });

  it('only the e-mailed kinds; SLA breaches and the salesman-facing kinds are not', () => {
    expect([...EMAIL_KINDS].sort()).toEqual(['EDIT_STAGE_ADVANCED', 'EDIT_SUBMITTED', 'REACTIVATION_REQUESTED', 'REQUEST_FYI']);
    for (const kind of ['SLA_BREACH', 'EDIT_APPROVED_FINAL', 'EDIT_NEEDS_CORRECTION', 'TEMIX_UPLOAD_READY', 'TEMIX_SYNC_ACKED']) {
      expect(rowVerdict(row({ kind }), who(Role.MANAGER), req(), NOW), kind).toEqual({ send: false, status: 'SKIPPED_KIND' });
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

describe('waitsOn: has the request moved past him?', () => {
  const cash = () => req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CASH) });
  const credit = () => req({ process: 'CREATE', approvalChain: resolveChain(EditProcess.CREATE, PaymentTerms.CREDIT) });

  it('the supervisor, while the request is at the Supervisor step; not once it moved on, though it is still SUBMITTED', () => {
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', cash())).toBe(true);
    expect(waitsOn(who(Role.MANAGER), 'EDIT_SUBMITTED', { ...cash(), currentStepIndex: 1 })).toBe(false);
  });

  it('a Supervisor who is not the submitter’s supervisor does not; a region Manager (close fallback) does', () => {
    expect(waitsOn(who(Role.SUPERVISOR, { id: 'other' }), 'EDIT_SUBMITTED', req())).toBe(false);
    expect(waitsOn(who(Role.MANAGER, { id: 'm2' }), 'EDIT_SUBMITTED', req({ target: 'BRANCH' }))).toBe(true);
  });

  it('EDIT_STAGE_ADVANCED: the step that must act now, and nobody else', () => {
    const atFm = { ...credit(), currentStepIndex: 1 };
    expect(waitsOn(who(Role.FINANCE_MANAGER, { id: 'fm' }), 'EDIT_STAGE_ADVANCED', atFm)).toBe(true);
    expect(waitsOn(who(Role.FINANCE_MANAGER, { id: 'fm' }), 'EDIT_STAGE_ADVANCED', { ...atFm, currentStepIndex: 2 })).toBe(false);
    expect(waitsOn(who(Role.ACCOUNTANT, { id: 'a' }), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 1 })).toBe(true);
    // Returned to the Supervisor step by a step-back: his row again.
    expect(waitsOn(who(Role.MANAGER), 'EDIT_STAGE_ADVANCED', { ...cash(), currentStepIndex: 0 })).toBe(true);
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

  it('REACTIVATION_REQUESTED: a Manager while it is open', () => {
    const r = req({ isReactivation: true, target: 'BRANCH', approvalChain: null });
    expect(waitsOn(who(Role.MANAGER), 'REACTIVATION_REQUESTED', r)).toBe(true);
    expect(waitsOn(who(Role.ACCOUNTANT), 'REACTIVATION_REQUESTED', r)).toBe(false);
    expect(waitsOn(who(Role.MANAGER), 'REACTIVATION_REQUESTED', { ...r, state: 'APPROVED' })).toBe(false);
  });
});

describe('planRun', () => {
  const recipients = new Map<string, Recipient>([
    ['m1', who(Role.MANAGER, { id: 'm1', email: 'm1@example.test' })],
    ['m2', who(Role.MANAGER, { id: 'm2', email: 'm2@example.test' })],
    ['a1', who(Role.ACCOUNTANT, { id: 'a1', email: 'a1@example.test' })],
    ['gm', who(Role.GM, { id: 'gm', email: 'gm@example.test' })],
  ]);
  const edits = new Map<string, RequestNow>([
    ['e1', req({ id: 'e1', submitterSupervisorId: 'm1' })],
    ['e2', req({ id: 'e2', submitterSupervisorId: 'm2' })],
  ]);

  it('one digest per recipient, one line per request (action beats information), skips recorded', () => {
    const plan = planRun({
      rows: [
        row({ id: 'r1', userId: 'm1', kind: 'EDIT_SUBMITTED', editId: 'e1' }),
        row({ id: 'r2', userId: 'm1', kind: 'REQUEST_FYI', editId: 'e1' }),
        row({ id: 'r3', userId: 'a1', kind: 'REQUEST_FYI', editId: 'e1' }),
        row({ id: 'r4', userId: 'a1', kind: 'REQUEST_FYI', editId: 'e2' }),
        row({ id: 'r5', userId: 'gm', kind: 'EDIT_STAGE_ADVANCED', editId: 'e1' }),
      ],
      recipients,
      edits,
      now: NOW,
      recentlySent: new Set(),
      sentLast24h: 0,
    });
    expect(plan.skips).toEqual([{ id: 'r5', status: 'SKIPPED_ROLE' }]);
    expect(plan.digests.map((d) => [d.userId, d.rowIds, d.items.map((i) => `${i.kind}:${i.editId}`)])).toEqual([
      ['m1', ['r1', 'r2'], ['EDIT_SUBMITTED:e1']],
      ['a1', ['r3', 'r4'], ['REQUEST_FYI:e1', 'REQUEST_FYI:e2']],
    ]);
    expect(plan.digests[0]!.address).toBe('m1@example.test');
    expect(plan.capped).toBe(false);
  });

  it('a recipient e-mailed within the gap waits; his rows go back', () => {
    const plan = planRun({
      rows: [row({ id: 'r1', userId: 'm1' }), row({ id: 'r2', userId: 'a1', kind: 'REQUEST_FYI' })],
      recipients,
      edits,
      now: NOW,
      recentlySent: new Set(['m1']),
      sentLast24h: 0,
    });
    expect(plan.deferred).toEqual(['r1']);
    expect(plan.digests.map((d) => d.userId)).toEqual(['a1']);
  });

  it('the caps hold back whole digests, newest first, and say so', () => {
    const rows = [
      row({ id: 'old', userId: 'a1', kind: 'REQUEST_FYI', createdAt: ago(50) }),
      row({ id: 'new', userId: 'm1', createdAt: ago(1) }),
    ];
    const perRun = planRun({ rows, recipients, edits, now: NOW, recentlySent: new Set(), sentLast24h: 0, policy: { ...EMAIL_DELIVERY, perRunCap: 1 } });
    expect(perRun.digests.map((d) => d.userId)).toEqual(['a1']);
    expect(perRun.deferred).toEqual(['new']);
    expect(perRun.capped).toBe(true);
    const daily = planRun({ rows, recipients, edits, now: NOW, recentlySent: new Set(), sentLast24h: EMAIL_DELIVERY.dailyCap });
    expect(daily.digests).toEqual([]);
    expect(daily.deferred.sort()).toEqual(['new', 'old']);
    expect(daily.capped).toBe(true);
  });
});
