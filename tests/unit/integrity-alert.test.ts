// @vitest-environment node
/**
 * Gap 29: what one nightly run of the integrity watch does with what it found
 * (lib/integrity/run.ts), on fakes for the database, the checks and the seal.
 *
 *  - Every result is appended, ids and counts only (at most ten samples).
 *  - A failing alert check leaves ONE in-app INTEGRITY_ALERT per active,
 *    non-test Data Steward per Oman day — and none while the switch is off
 *    (the shipped default, until the reading build is the rollback target).
 *  - Its body is check titles and counts: no id, no name, no value.
 *  - The kind is never e-mailed (the outbox marks it SKIPPED_KIND) and links to
 *    /status/integrity.
 *  - The operators' webhook gets counts only, critical when the seal chain or
 *    the protection itself failed.
 *  - A check that throws is an error (the run's heartbeat goes red), not a pass.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Role } from '@prisma/client';

type Note = { userId: string; kind: string; title: string; body: string; createdAt: Date };

const h = vi.hoisted(() => ({
  notes: [] as Array<{ userId: string; kind: string; title: string; body: string; createdAt: Date }>,
  results: [] as Array<Record<string, unknown>>,
  stewards: [] as string[],
  checks: [] as Array<Record<string, unknown>>,
  seal: { status: 'sealed', seal: { seq: 4, hash: 'a'.repeat(64), bodyText: '{}', r2Key: 'seals/x', day: '2026-10-24', formatVersion: 1, prevHash: 'b'.repeat(64), snapshotXmax: '1', sealedAt: '2026-10-24T02:30:00.000Z' } } as Record<string, unknown>,
  mismatches: [] as Array<Record<string, unknown>>,
  /** The latest earlier results, as loadPrevious reads them. */
  previous: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/lib/integrity/checks', () => ({
  get CHECKS() {
    return h.checks;
  },
  get CHECK_BY_ID() {
    return new Map(
      [
        ...h.checks,
        { id: 'seal-written', policy: 'alert', title: 'Tonight’s seal was written' },
        { id: 'seal-chain-intact', policy: 'alert', title: 'The seal chain still matches the ledgers' },
        { id: 'seal-offsite-copies', policy: 'alert', title: 'The off-site copies of the seals are there' },
      ].map((c) => [c.id as string, c])
    );
  },
  CRITICAL_CHECKS: ['seal-chain-intact', 'protection-triggers', 'protection-functions'],
}));
vi.mock('@/lib/seal/seal', () => ({ writeSeal: async () => h.seal }));
vi.mock('@/lib/seal/verify', () => ({
  recheckSeals: async () => ({ seals: [], windowSeqs: [1, 2, 3], rangesRecomputed: 0, mismatches: h.mismatches }),
}));

import { runIntegrityWatch, integrityAlertAudience } from '@/lib/integrity/run';
import { INTEGRITY_INAPP_ALERTS_ENABLED } from '@/lib/integrity/policy';
import { hrefFor } from '@/lib/notification-links';
import { rowVerdict } from '@/lib/email/eligibility';

const NOW = new Date('2026-10-24T02:30:00.000Z'); // 06:30 Oman

function fakeDb() {
  const tx = {
    $executeRaw: async () => 1,
    $executeRawUnsafe: async () => 0,
    $queryRaw: async () => [],
    integrityCheckResult: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        h.results.push(...data);
        return { count: data.length };
      },
    },
    notification: {
      findFirst: async ({ where }: { where: { userId: string; kind: string; createdAt: { gte: Date } } }) =>
        h.notes.find((n) => n.userId === where.userId && n.kind === where.kind && n.createdAt >= where.createdAt.gte) ?? null,
      createMany: async ({ data }: { data: Note[] }) => {
        for (const d of data) h.notes.push({ ...d, createdAt: NOW });
        return { count: data.length };
      },
    },
    user: {
      findMany: async ({ where }: { where: { role: string; isActive: boolean; isTest: boolean } }) => {
        expect(where).toEqual({ role: Role.STEWARD, isActive: true, isTest: false });
        return h.stewards.map((id) => ({ id }));
      },
    },
  };
  return { $transaction: async (fn: (t: unknown) => unknown) => fn(tx), $queryRaw: async () => h.previous } as never;
}

const store = { get: async () => '{}', put: async () => undefined };
const check = (id: string, count: number, policy = 'alert', title = `Check ${id}`) => ({
  id,
  version: 1,
  policy,
  title,
  run: async () => ({ count, sampleIds: Array.from({ length: count + 20 }, (_, i) => `${id}-${i}`) }),
});

beforeEach(() => {
  h.notes = [];
  h.results = [];
  h.stewards = ['stw-1', 'stw-2'];
  h.mismatches = [];
  h.previous = [];
  h.checks = [check('shop-region-matches-route', 2, 'alert', 'Shop region matches its route'), check('exports-since-last-run', 5, 'info', 'Exports since the last run')];
});

describe('the results', () => {
  it('every check and the three seal results are appended, with at most ten samples', async () => {
    const alert = vi.fn(async () => true);
    const s = await runIntegrityWatch(fakeDb(), { store, now: NOW, alert, inAppAlerts: false });
    expect(h.results.map((r) => [r.checkId, r.status])).toEqual([
      ['shop-region-matches-route', 'fail'],
      ['exports-since-last-run', 'info'],
      ['seal-written', 'pass'],
      ['seal-chain-intact', 'pass'],
      ['seal-offsite-copies', 'pass'],
    ]);
    for (const r of h.results) expect((r.sampleIds as string[]).length).toBeLessThanOrEqual(10);
    expect(h.results[0]!.day).toEqual(new Date('2026-10-24T00:00:00.000Z'));
    expect(s).toMatchObject({ checks: 5, failing: 1, info: 1, errors: 0, seal: 'sealed', sealSeq: 4, alerted: 0 });
  });

  it('a check that throws is an error, and the run reports it (the heartbeat goes red)', async () => {
    h.checks = [{ id: 'protection-triggers', version: 1, policy: 'alert', title: 't', run: async () => { throw new Error('canceling statement due to statement timeout'); } }];
    const s = await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true), inAppAlerts: false });
    expect(h.results[0]).toMatchObject({ checkId: 'protection-triggers', status: 'error', count: null });
    expect(s.errors).toBe(1);
  });

  it('a deferred seal fails seal-written; a genesis is information', async () => {
    h.seal = { status: 'deferred', reason: 'a transaction that was open at the last seal is still open', lastSeq: 3 };
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true), inAppAlerts: false });
    expect(h.results.find((r) => r.checkId === 'seal-written')).toMatchObject({ status: 'fail', count: 1 });
    h.results = [];
    h.seal = { status: 'genesis', seal: { seq: 0, hash: 'c'.repeat(64), bodyText: '{}', r2Key: 'seals/g', day: '2026-10-24', formatVersion: 1, prevHash: null, snapshotXmax: '1', sealedAt: NOW.toISOString() } };
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true), inAppAlerts: false });
    expect(h.results.find((r) => r.checkId === 'seal-written')).toMatchObject({ status: 'info' });
  });
});

describe('the Steward’s in-app alert', () => {
  it('is off in the shipped build (the reading build must be the rollback target first)', async () => {
    expect(INTEGRITY_INAPP_ALERTS_ENABLED).toBe(false);
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true) });
    expect(h.notes).toEqual([]);
  });

  it('when on: one per active non-test Steward, once per Oman day, titles and counts only', async () => {
    const s = await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true), inAppAlerts: true });
    expect(s.alerted).toBe(2);
    expect(h.notes.map((n) => [n.userId, n.kind])).toEqual([
      ['stw-1', 'INTEGRITY_ALERT'],
      ['stw-2', 'INTEGRITY_ALERT'],
    ]);
    const n = h.notes[0]!;
    expect(n.title).toBe('Nightly data check: 1 problem');
    expect(n.body).toBe('Shop region matches its route: 2. Open Service status, Integrity, for what each means and what to do.');
    // No id shape at all: no cuid, no sample, no code.
    expect(n.body).not.toMatch(/shop-region-matches-route-|c[a-z0-9]{20,}|NMWC-/);
    // A second run the same Oman day adds nothing.
    await runIntegrityWatch(fakeDb(), { store, now: new Date(NOW.getTime() + 3600_000), alert: vi.fn(async () => true), inAppAlerts: true });
    expect(h.notes).toHaveLength(2);
  });

  it('nothing failing, nothing sent', async () => {
    h.checks = [check('shop-region-matches-route', 0)];
    const alert = vi.fn(async () => true);
    const s = await runIntegrityWatch(fakeDb(), { store, now: NOW, alert, inAppAlerts: true });
    expect(s.alerted).toBe(0);
    expect(h.notes).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
  });

  it('the audience is the active, non-test Data Stewards', async () => {
    const tx = {
      user: {
        findMany: async (args: unknown) => {
          expect(args).toEqual({ where: { role: Role.STEWARD, isActive: true, isTest: false }, select: { id: true } });
          return [{ id: 's1' }];
        },
      },
    };
    expect(await integrityAlertAudience(tx as never)).toEqual(['s1']);
  });

  it('is never e-mailed, and opens the integrity page', () => {
    const row = { id: 'n1', userId: 'stw-1', kind: 'INTEGRITY_ALERT', editId: null, createdAt: NOW } as never;
    const steward = { id: 'stw-1', role: Role.STEWARD, isActive: true, username: 'steward.real', email: 'x@y.z' } as never;
    expect(rowVerdict(row, steward, undefined, NOW)).toEqual({ send: false, status: 'SKIPPED_KIND' });
    expect(hrefFor({ kind: 'INTEGRITY_ALERT', editId: null, customerId: null }, Role.STEWARD)).toBe('/status/integrity');
  });
});

describe('the operators’ webhook', () => {
  it('counts only; warn for a data problem', async () => {
    const alert = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert, inAppAlerts: false });
    expect(alert).toHaveBeenCalledWith({
      severity: 'warn',
      event: 'integrity.failed',
      message: 'The nightly integrity check found problems. Open Service status, Integrity.',
      counts: { failing: 1, errors: 0 },
    });
  });

  it('critical when the seal chain no longer matches; the same mismatches the next night are information', async () => {
    h.checks = [];
    h.mismatches = [{ kind: 'rows-changed', seq: 2, day: '2026-10-22', table: 'AuditLog' }];
    const alert = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert, inAppAlerts: false });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical', counts: { failing: 1, errors: 0 } }));
    const first = h.results.find((r) => r.checkId === 'seal-chain-intact')!;
    expect(first).toMatchObject({ status: 'fail', count: 1, sampleIds: ['2:AuditLog'] });
    expect(JSON.stringify(first.detail)).not.toMatch(/digest|bodyText/);
    // The next night, the same event: reported, not alerted again.
    h.previous = [{ checkId: 'seal-chain-intact', runAt: NOW, status: 'fail', count: 1, detail: first.detail }];
    h.results = [];
    const again = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: new Date(NOW.getTime() + 86_400_000), alert: again, inAppAlerts: false });
    expect(h.results.find((r) => r.checkId === 'seal-chain-intact')).toMatchObject({ status: 'info', count: 1 });
    expect(again).not.toHaveBeenCalled();
  });
});
