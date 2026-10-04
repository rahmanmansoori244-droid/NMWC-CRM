// @vitest-environment node
/**
 * F1 (2026-10-05): one run of the e-mail drain (lib/email/drain.ts) with an
 * in-memory outbox and a fake transport. The store keeps the same columns the
 * table does — title and body included, carrying a customer's legal name — so
 * "the e-mail never contains a name" is tested where a name is right there.
 * The same run against Postgres: tests/integration/email-drain.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { EditProcess, PaymentTerms, Role } from '@prisma/client';
import { resolveChain } from '@/lib/approval-chains';
import { runEmailDrain } from '@/lib/email/drain';
import type { OutboxStore } from '@/lib/email/outbox-store';
import type { MailTransport, OutgoingMail, SendResult } from '@/lib/email/transport';
import type { Recipient, RequestNow } from '@/lib/email/eligibility';
import { EMAIL_DELIVERY } from '@/lib/notify-policy';

const NOW = new Date('2026-10-05T08:00:00.000Z');
const LEGAL_NAME = 'Al Noor Trading Est';
const CODE = 'NMWC-000123';

type Row = {
  id: string;
  userId: string;
  kind: string;
  editId: string | null;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  emailedAt: Date | null;
  emailStatus: string | null;
  emailAttempts: number;
  emailLeaseUntil: Date | null;
};

class MemoryStore implements OutboxStore {
  rows: Row[] = [];
  users = new Map<string, Recipient>();
  edits = new Map<string, RequestNow>();

  add(r: Partial<Row> & Pick<Row, 'id' | 'userId'>) {
    this.rows.push({
      kind: 'EDIT_SUBMITTED',
      editId: 'e1',
      title: `Edit awaiting your review`,
      body: `${LEGAL_NAME} (${CODE}) — changes submitted for approval.`,
      createdAt: new Date(NOW.getTime() - 5 * 60_000),
      readAt: null,
      emailedAt: null,
      emailStatus: null,
      emailAttempts: 0,
      emailLeaseUntil: null,
      ...r,
    });
  }
  get(id: string) {
    return this.rows.find((r) => r.id === id)!;
  }
  free(r: Row, now: Date) {
    return !r.emailLeaseUntil || r.emailLeaseUntil < now;
  }
  async markStale(cutoff: Date, now: Date, limit: number) {
    const hit = this.rows.filter((r) => !r.emailedAt && r.createdAt < cutoff && this.free(r, now)).slice(0, limit);
    for (const r of hit) Object.assign(r, { emailStatus: 'SKIPPED_STALE', emailedAt: now, emailLeaseUntil: null });
    return hit.length;
  }
  async markIneligible(a: { kinds: readonly string[]; roles: readonly string[]; now: Date; limit: number }) {
    const open = () => this.rows.filter((r) => !r.emailedAt && this.free(r, a.now));
    const byKind = open().filter((r) => !a.kinds.includes(r.kind)).slice(0, a.limit);
    for (const r of byKind) Object.assign(r, { emailStatus: 'SKIPPED_KIND', emailedAt: a.now, emailLeaseUntil: null });
    const byRole = open().filter((r) => !a.roles.includes(this.users.get(r.userId)?.role ?? '')).slice(0, a.limit);
    for (const r of byRole) Object.assign(r, { emailStatus: 'SKIPPED_ROLE', emailedAt: a.now, emailLeaseUntil: null });
    return { kind: byKind.length, role: byRole.length };
  }
  async markExhausted(max: number, now: Date, limit: number) {
    const hit = this.rows.filter((r) => !r.emailedAt && r.emailAttempts >= max && this.free(r, now)).slice(0, limit);
    for (const r of hit) Object.assign(r, { emailStatus: 'FAILED', emailedAt: now, emailLeaseUntil: null });
    return hit.length;
  }
  async claim(a: { now: Date; cutoff: Date; leaseUntil: Date; limit: number; maxAttempts: number }) {
    const hit = this.rows
      .filter((r) => !r.emailedAt && r.createdAt >= a.cutoff && this.free(r, a.now) && r.emailAttempts < a.maxAttempts)
      .sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())
      .slice(0, a.limit);
    for (const r of hit) Object.assign(r, { emailLeaseUntil: a.leaseUntil, emailAttempts: r.emailAttempts + 1 });
    // As the real store: ids, kind and times only.
    return hit.map(({ id, userId, kind, editId, createdAt, readAt }) => ({ id, userId, kind, editId, createdAt, readAt }));
  }
  async loadRecipients(ids: string[]) {
    return ids.map((id) => this.users.get(id)).filter((u): u is Recipient => !!u);
  }
  async loadRequests(ids: string[]) {
    return ids.map((id) => this.edits.get(id)).filter((e): e is RequestNow => !!e);
  }
  async recentlySent(ids: string[], since: Date) {
    return new Set(this.rows.filter((r) => ids.includes(r.userId) && r.emailStatus === 'SENT' && r.emailedAt! >= since).map((r) => r.userId));
  }
  async sentDigestsSince(since: Date) {
    return new Set(this.rows.filter((r) => r.emailStatus === 'SENT' && r.emailedAt! >= since).map((r) => `${r.userId}|${r.emailedAt!.getTime()}`)).size;
  }
  async finish(ids: string[], status: string, at: Date) {
    for (const r of this.rows) if (ids.includes(r.id) && !r.emailedAt) Object.assign(r, { emailStatus: status, emailedAt: at, emailLeaseUntil: null });
  }
  async release(ids: string[]) {
    for (const r of this.rows) {
      if (ids.includes(r.id) && !r.emailedAt) Object.assign(r, { emailLeaseUntil: null, emailAttempts: Math.max(0, r.emailAttempts - 1) });
    }
  }
}

class FakeTransport implements MailTransport {
  sent: OutgoingMail[] = [];
  outcomes: SendResult[] = [];
  closed = 0;
  hang = false;
  async send(mail: OutgoingMail): Promise<SendResult> {
    if (this.hang) return new Promise<SendResult>(() => {});
    const o = this.outcomes.shift() ?? { ok: true };
    if (o.ok) this.sent.push(mail);
    return o;
  }
  close() {
    this.closed += 1;
  }
}

const CONFIG = { linkOrigin: 'https://crm.example.test', redirectTo: null, subjectPrefix: '' };
let store: MemoryStore;
let transport: FakeTransport;
let clock: number;
const run = (extra: Partial<Parameters<typeof runEmailDrain>[0]> = {}) =>
  runEmailDrain({ store, transport, config: CONFIG, now: () => new Date(clock), ...extra });

const person = (id: string, role: Role, over: Partial<Recipient> = {}): Recipient => ({
  id,
  role,
  isActive: true,
  email: `${id}@example.test`,
  username: id,
  ...over,
});
const update = (id: string, over: Partial<RequestNow> = {}): RequestNow => ({
  id,
  state: 'SUBMITTED',
  process: 'UPDATE',
  target: 'CUSTOMER',
  isReactivation: false,
  approvalChain: resolveChain(EditProcess.UPDATE, PaymentTerms.CASH),
  currentStepIndex: 0,
  pendingRole: null,
  submittedById: 'sal',
  submitterSupervisorId: 'mgr',
  otherStepActorIds: [],
  ...over,
});

beforeEach(() => {
  store = new MemoryStore();
  transport = new FakeTransport();
  clock = NOW.getTime();
  for (const u of [
    person('mgr', Role.MANAGER),
    person('acc', Role.ACCOUNTANT),
    person('gm', Role.GM),
    person('stw', Role.STEWARD),
    person('sal', Role.SALESMAN),
    person('off', Role.MANAGER, { isActive: false }),
    person('nomail', Role.ACCOUNTANT, { email: null }),
  ]) {
    store.users.set(u.id, u);
  }
  store.edits.set('e1', update('e1'));
});

describe('runEmailDrain', () => {
  it('sends one digest per recipient and never a name, even though every row carries one', async () => {
    store.add({ id: 'n1', userId: 'mgr' });
    store.add({ id: 'n2', userId: 'acc', kind: 'REQUEST_FYI', title: `For your information: ${LEGAL_NAME}` });
    const r = await run();
    expect(r).toMatchObject({ claimed: 2, sent: 2, skipped: 0, sendErrors: 0, authErrors: 0 });
    expect(transport.sent.map((m) => m.to).sort()).toEqual(['acc@example.test', 'mgr@example.test']);
    for (const m of transport.sent) {
      const all = `${m.subject}\n${m.text}\n${JSON.stringify(m.headers)}`;
      expect(all).not.toContain(LEGAL_NAME);
      expect(all).not.toContain('Al Noor');
      expect(all).not.toContain(CODE);
    }
    expect(store.get('n1')).toMatchObject({ emailStatus: 'SENT', emailLeaseUntil: null });
    expect(store.get('n1').emailedAt).toEqual(NOW);
    expect(transport.closed).toBe(1);
  });

  it('never e-mails the GM, a Steward or a salesman; records why each row was not sent', async () => {
    store.add({ id: 'g', userId: 'gm', kind: 'EDIT_STAGE_ADVANCED' });
    store.add({ id: 's', userId: 'stw', kind: 'REQUEST_FYI' });
    store.add({ id: 'x', userId: 'sal', kind: 'EDIT_STAGE_ADVANCED' });
    store.add({ id: 'o', userId: 'off' });
    store.add({ id: 'q', userId: 'nomail', kind: 'REQUEST_FYI' });
    store.add({ id: 'k', userId: 'mgr', kind: 'SLA_BREACH' });
    store.add({ id: 'r', userId: 'mgr', readAt: NOW });
    const r = await run();
    expect(transport.sent).toEqual([]);
    expect(r.skippedBy).toEqual({ SKIPPED_ROLE: 3, SKIPPED_INACTIVE: 1, SKIPPED_NO_ADDRESS: 1, SKIPPED_KIND: 1, SKIPPED_READ: 1 });
    for (const id of ['g', 's', 'x']) expect(store.get(id).emailStatus).toBe('SKIPPED_ROLE');
  });

  it('a must-act row whose request moved on is not sent; one still waiting on him is', async () => {
    store.edits.set('e2', update('e2', { state: 'APPROVED' }));
    store.add({ id: 'done', userId: 'mgr', editId: 'e2' });
    store.add({ id: 'open', userId: 'mgr', editId: 'e1' });
    await run();
    expect(store.get('done').emailStatus).toBe('SKIPPED_RESOLVED');
    expect(store.get('open').emailStatus).toBe('SENT');
  });

  it('rows past the maximum age are marked and never claimed — no backlog flood when the switch goes on', async () => {
    store.add({ id: 'old', userId: 'mgr', createdAt: new Date(NOW.getTime() - EMAIL_DELIVERY.maxAgeMs - 60_000) });
    store.add({ id: 'pre', userId: 'mgr', emailedAt: new Date(0), emailStatus: 'PRE_FEATURE' });
    const r = await run();
    expect(r.staleMarked).toBe(1);
    expect(store.get('old').emailStatus).toBe('SKIPPED_STALE');
    expect(store.get('pre').emailStatus).toBe('PRE_FEATURE');
    expect(transport.sent).toEqual([]);
  });

  it('a second run inside the gap holds the recipient’s new rows back, unspent; after the gap they go', async () => {
    store.add({ id: 'a', userId: 'mgr' });
    await run();
    store.edits.set('e3', update('e3'));
    store.add({ id: 'b', userId: 'mgr', editId: 'e3', createdAt: new Date(NOW.getTime() + 60_000) });
    clock = NOW.getTime() + 10 * 60_000;
    const second = await run();
    expect(second).toMatchObject({ claimed: 1, sent: 0, deferred: 1 });
    expect(store.get('b')).toMatchObject({ emailedAt: null, emailLeaseUntil: null, emailAttempts: 0 });
    clock = NOW.getTime() + 31 * 60_000;
    expect((await run()).sent).toBe(1);
    expect(transport.sent).toHaveLength(2);
  });

  it('the per-run cap holds back whole digests and says so', async () => {
    for (let i = 0; i < 5; i += 1) {
      const id = `m${i}`;
      store.users.set(id, person(id, Role.ACCOUNTANT));
      store.add({ id: `r${i}`, userId: id, kind: 'REQUEST_FYI', createdAt: new Date(NOW.getTime() - (10 - i) * 60_000) });
    }
    const r = await run({ policy: { ...EMAIL_DELIVERY, perRunCap: 2 } });
    expect(r).toMatchObject({ sent: 2, deferred: 3, capped: true });
    expect(transport.sent.map((m) => m.to)).toEqual(['m0@example.test', 'm1@example.test']);
  });

  it('the rolling daily cap counts digests already sent', async () => {
    for (let i = 0; i < 3; i += 1) store.add({ id: `s${i}`, userId: 'acc', emailStatus: 'SENT', emailedAt: new Date(NOW.getTime() - (i + 1) * 3600_000), kind: 'REQUEST_FYI' });
    store.add({ id: 'new', userId: 'mgr' });
    const r = await run({ policy: { ...EMAIL_DELIVERY, dailyCap: 3 } });
    expect(r).toMatchObject({ sent: 0, capped: true, deferred: 1 });
  });

  it('a refused login stops the run and hands every unsent row back, unspent', async () => {
    store.add({ id: 'a', userId: 'mgr' });
    store.add({ id: 'b', userId: 'acc', kind: 'REQUEST_FYI' });
    transport.outcomes = [{ ok: false, label: 'EAUTH', kind: 'auth' }];
    const r = await run();
    expect(r).toMatchObject({ sent: 0, authErrors: 1, sendErrors: 0, deferred: 2, errorLabels: { EAUTH: 1 } });
    for (const id of ['a', 'b']) expect(store.get(id)).toMatchObject({ emailedAt: null, emailLeaseUntil: null, emailAttempts: 0 });
  });

  it('a permanent refusal marks FAILED; a transient one leaves the rows leased for a later run', async () => {
    store.add({ id: 'perm', userId: 'mgr' });
    store.add({ id: 'temp', userId: 'acc', kind: 'REQUEST_FYI', createdAt: new Date(NOW.getTime() - 60_000) });
    transport.outcomes = [
      { ok: false, label: 'SMTP_5XX', kind: 'permanent' },
      { ok: false, label: 'ETIMEDOUT', kind: 'transient' },
    ];
    const r = await run();
    expect(r).toMatchObject({ sent: 0, failed: 1, sendErrors: 2 });
    expect(store.get('perm').emailStatus).toBe('FAILED');
    expect(store.get('temp')).toMatchObject({ emailedAt: null, emailAttempts: 1 });
    expect(store.get('temp').emailLeaseUntil!.getTime()).toBe(NOW.getTime() + EMAIL_DELIVERY.leaseMs);
  });

  it('a row that keeps failing becomes FAILED after the attempt cap', async () => {
    store.add({ id: 'tired', userId: 'mgr', emailAttempts: EMAIL_DELIVERY.maxAttempts });
    const r = await run();
    expect(r.exhaustedMarked).toBe(1);
    expect(store.get('tired').emailStatus).toBe('FAILED');
  });

  it('no send starts after the budget; the rest go back', async () => {
    store.add({ id: 'a', userId: 'mgr' });
    store.add({ id: 'b', userId: 'acc', kind: 'REQUEST_FYI' });
    let calls = 0;
    const r = await runEmailDrain({
      store,
      transport,
      config: CONFIG,
      // Every reading of the clock after the plan is past the budget.
      now: () => new Date(NOW.getTime() + (calls++ > 0 ? EMAIL_DELIVERY.sendBudgetMs + 1 : 0)),
    });
    expect(r).toMatchObject({ sent: 0, budgetStopped: true, deferred: 2 });
  });

  it('a send that never answers is given up at the hard stop, and the run still ends', async () => {
    store.add({ id: 'a', userId: 'mgr' });
    store.add({ id: 'b', userId: 'acc', kind: 'REQUEST_FYI' });
    transport.hang = true;
    const r = await run({ policy: { ...EMAIL_DELIVERY, hardStopMs: 20 } });
    expect(r).toMatchObject({ sent: 0, sendErrors: 1, budgetStopped: true, errorLabels: { DEADLINE: 1 } });
    expect(transport.closed).toBe(1);
  });

  it('a redirect sends every digest to the one test inbox, marked', async () => {
    store.add({ id: 'a', userId: 'mgr' });
    store.add({ id: 'b', userId: 'acc', kind: 'REQUEST_FYI' });
    await run({ config: { ...CONFIG, redirectTo: 'tester@example.test', subjectPrefix: '[UAT] ' } });
    expect(transport.sent.map((m) => m.to)).toEqual(['tester@example.test', 'tester@example.test']);
    for (const m of transport.sent) expect(m.subject.startsWith('[UAT] ')).toBe(true);
  });

  it('closes the transport even when the store throws', async () => {
    store.claim = async () => {
      throw new Error('db down');
    };
    await expect(run()).rejects.toThrow('db down');
    expect(transport.closed).toBe(1);
  });
});
