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
 *  - Owner decisions 2026-10-24: mixed test scaffolding, and a missed run of a
 *    job not listed as alerting (keep-warm, the e-mail drain, photo-gc, the
 *    retention sweep), are information: no in-app alert, no webhook.
 *  - The kind is never e-mailed (the outbox marks it SKIPPED_KIND) and links to
 *    /status/integrity.
 *  - The operators' webhook gets counts only, critical when the seal chain or
 *    the protection itself failed.
 *  - A check that throws is an error (the run's heartbeat goes red), not a pass,
 *    and an errored result never moves the next run's window or baseline.
 *  - A seal finding is alerted once, the night it is new: a deletion the totals
 *    find stays the same event though the last seal moves every night, a range
 *    mismatch whose seal is not rechecked tonight is carried (never a pass), and
 *    one that is resolved and found again is new again.
 *  - The whole of seals/ is listed: an object no seal of the chain has is a
 *    finding, critical when new.
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
  /** When the rechecked seals were made. */
  sealedAt: '2026-10-20T02:30:00.000Z',
  /** The seals the recheck read tonight, the rotation it was given, and the slice it did. */
  windowSeqs: [1, 2, 3] as number[],
  rotatedSeqs: [] as number[],
  rotation: null as null | { cursor: number | null; nights: number },
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
  recheckSeals: async (_db: unknown, opts: { rotation?: { cursor: number | null; nights: number } }) => {
    h.rotation = opts.rotation ? { cursor: opts.rotation.cursor, nights: opts.rotation.nights } : null;
    return {
      // No genesis among them: each copy's key is the one its row names (lib/seal/chain.ts expectedSealKey).
      seals: [1, 2, 3].map((seq) => ({ seq, day: `2026-10-2${seq}`, r2Key: `seals/${seq}`, bodyText: '{}', hash: 'd'.repeat(64), sealedAt: h.sealedAt })),
      windowSeqs: h.windowSeqs,
      rotatedSeqs: h.rotatedSeqs,
      rotationCursor: h.rotatedSeqs.at(-1) ?? opts.rotation?.cursor ?? null,
      olderSeals: 0,
      rangesRecomputed: 0,
      mismatches: h.mismatches,
    };
  },
}));

import { runIntegrityWatch, integrityAlertAudience } from '@/lib/integrity/run';
import { INTEGRITY_INAPP_ALERTS_ENABLED } from '@/lib/integrity/policy';
import { scheduledJobFindings } from '@/lib/integrity/classify';
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
  // loadPrevious: the latest result of each check, of the statuses its SQL asks for.
  const previous = async (q: { sql?: string }) => {
    const ran = /"status" IN \('pass', 'fail', 'info'\)/.test(q.sql ?? '');
    const latest = new Map<string, Record<string, unknown>>();
    for (const r of h.previous) {
      if (ran && r.status === 'error') continue;
      const cur = latest.get(r.checkId as string);
      if (!cur || (r.runAt as Date) > (cur.runAt as Date)) latest.set(r.checkId as string, r);
    }
    return [...latest.values()];
  };
  return { $transaction: async (fn: (t: unknown) => unknown) => fn(tx), $queryRaw: previous } as never;
}

const LISTED = ['seals/1', 'seals/2', 'seals/3'];
const store = { get: async () => '{}', put: async () => undefined, list: async () => LISTED };
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
  h.sealedAt = '2026-10-20T02:30:00.000Z';
  h.windowSeqs = [1, 2, 3];
  h.rotatedSeqs = [];
  h.rotation = null;
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

  it('an errored result between two good runs moves neither the window nor the baseline', async () => {
    const seen = new Map<string, unknown>();
    const watching = (id: string) => ({
      id,
      version: 1,
      policy: 'alert',
      title: id,
      run: async (_db: unknown, ctx: { previous: Map<string, { runAt: Date; detail: unknown }> }) => {
        seen.set(id, ctx.previous.get(id));
        return { count: 0, sampleIds: [] };
      },
    });
    h.checks = [watching('history-unattributed-since-last-run'), watching('test-flags-changed')];
    const good = new Date('2026-10-22T02:30:00.000Z');
    const errored = new Date('2026-10-23T02:30:00.000Z');
    h.previous = [
      { checkId: 'history-unattributed-since-last-run', runAt: good, status: 'pass', count: 0, detail: { since: '2026-10-21T02:30:00.000Z' } },
      { checkId: 'history-unattributed-since-last-run', runAt: errored, status: 'error', count: null, detail: { error: 'canceling statement due to statement timeout' } },
      { checkId: 'test-flags-changed', runAt: good, status: 'pass', count: 0, detail: { hashes: { Customer: 'abc' } } },
      { checkId: 'test-flags-changed', runAt: errored, status: 'error', count: null, detail: { error: 'not started: the run’s check budget was spent' } },
      { checkId: 'seal-chain-intact', runAt: good, status: 'info', count: 0, detail: { rotationCursor: 41, open: [] } },
      { checkId: 'seal-chain-intact', runAt: errored, status: 'error', count: null, detail: { error: 'the run’s deadline passed during the recheck' } },
    ];
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: vi.fn(async () => true), inAppAlerts: false });
    // "Since the last run" is since the last run that RAN: the errored night's window is checked tonight.
    expect(seen.get('history-unattributed-since-last-run')).toMatchObject({ runAt: good });
    // The baseline is the last good one, not an error row without hashes (which would re-baseline as a first run).
    expect(seen.get('test-flags-changed')).toMatchObject({ runAt: good, detail: { hashes: { Customer: 'abc' } } });
    // And the seals' rotation goes on from where the last good run stopped.
    expect(h.rotation).toEqual({ cursor: 41, nights: 28 });
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

  it('owner decision 2026-10-24: mixed test scaffolding and a housekeeping job’s missed run are information, never alerted', async () => {
    // The registry's own policies and titles, with tonight's findings faked.
    const real = await vi.importActual<typeof import('@/lib/integrity/checks')>('@/lib/integrity/checks');
    const registered = (id: string, run: () => Promise<Record<string, unknown>>) => {
      const c = real.CHECK_BY_ID.get(id)!;
      return { id: c.id, version: c.version, policy: c.policy, title: c.title, run };
    };
    const day = '2026-10-23';
    const housekeeping = [
      { key: 'keep-warm', kind: 'gap' as const, day, gaps: 2 },
      { key: 'email-drain', kind: 'gap' as const, day, gaps: 1 },
      { key: 'photo-gc', kind: 'no-run' as const, day },
      { key: 'retention-sweep', kind: 'stale' as const },
    ];
    h.checks = [
      registered('test-scaffolding-mixed', async () => ({ count: 3, sampleIds: ['c1', 'r1', 'u1'] })),
      registered('scheduled-jobs-on-time', async () => scheduledJobFindings(housekeeping)),
    ];
    const alert = vi.fn(async () => true);
    const s = await runIntegrityWatch(fakeDb(), { store, now: NOW, alert, inAppAlerts: true });
    expect(h.results.slice(0, 2).map((r) => [r.checkId, r.status, r.count])).toEqual([
      ['test-scaffolding-mixed', 'info', 3],
      ['scheduled-jobs-on-time', 'info', 0],
    ]);
    expect((h.results[1]!.detail as { info: string[] }).info).toEqual(['keep-warm', 'email-drain', 'photo-gc', 'retention-sweep']);
    expect(s.failing).toBe(0);
    expect(alert).not.toHaveBeenCalled();
    expect(h.notes).toEqual([]);

    // The SLA sweep missing as well: it alone is counted, and alerted.
    h.results = [];
    h.checks = [registered('scheduled-jobs-on-time', async () => scheduledJobFindings([{ key: 'sla-escalate', kind: 'gap', day, gaps: 1 }, ...housekeeping]))];
    const again = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: NOW, alert: again, inAppAlerts: true });
    expect(h.results[0]).toMatchObject({ checkId: 'scheduled-jobs-on-time', status: 'fail', count: 1, sampleIds: ['sla-escalate'] });
    expect(again).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn', counts: { failing: 1, errors: 0 } }));
    expect(h.notes.map((n) => n.body)).toEqual([
      'Every scheduled job ran as its schedule says: 1. Open Service status, Integrity, for what each means and what to do.',
      'Every scheduled job ran as its schedule says: 1. Open Service status, Integrity, for what each means and what to do.',
    ]);
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

describe('seal findings: alerted once per event', () => {
  const chainResult = () => h.results.find((r) => r.checkId === 'seal-chain-intact')!;
  /** Tonight's run, with last night's results as the previous ones. */
  async function night(n: number) {
    h.previous = h.results.map((r) => ({ ...r }));
    h.results = [];
    const alert = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: new Date(NOW.getTime() + n * 86_400_000), alert, inAppAlerts: false });
    return alert;
  }

  beforeEach(() => {
    h.checks = [];
  });

  it('a deletion the totals find is one event, though the last seal it is shown at moves every night', async () => {
    h.mismatches = [{ kind: 'rows-deleted', seq: 3, day: '2026-10-23', table: 'AuditLog', totals: true, delta: 1 }];
    await night(0);
    expect(chainResult()).toMatchObject({ status: 'fail', sampleIds: ['totals:AuditLog'] });
    h.mismatches = [{ kind: 'rows-deleted', seq: 4, day: '2026-10-24', table: 'AuditLog', totals: true, delta: 1 }];
    expect(await night(1)).not.toHaveBeenCalled();
    expect(chainResult()).toMatchObject({ status: 'info', count: 1, detail: { new: 0 } });
    h.mismatches = [{ kind: 'rows-deleted', seq: 5, day: '2026-10-25', table: 'AuditLog', totals: true, delta: 1 }];
    expect(await night(2)).not.toHaveBeenCalled();
    // A second deletion is a new event (two rows short now).
    h.mismatches = [{ kind: 'rows-deleted', seq: 6, day: '2026-10-26', table: 'AuditLog', totals: true, delta: 2 }];
    const fourth = await night(3);
    expect(chainResult()).toMatchObject({ status: 'fail', detail: { new: 1 } });
    expect(fourth).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('a range mismatch whose seal leaves the window is carried as information, never dropped to a pass', async () => {
    h.mismatches = [{ kind: 'rows-changed', seq: 1, day: '2026-10-21', table: 'AuditLog' }];
    await night(0);
    expect(chainResult()).toMatchObject({ status: 'fail', count: 1 });
    // Seal 1 is no longer recomputed: tonight's recheck cannot see it.
    h.windowSeqs = [2, 3];
    h.mismatches = [];
    await night(1);
    expect(chainResult()).toMatchObject({ status: 'info', count: 1, sampleIds: ['1:AuditLog'], detail: { carried: 1 } });
    await night(2);
    expect(chainResult()).toMatchObject({ status: 'info', count: 1 });
    // The rotation recomputes it and finds it again: the same event.
    h.rotatedSeqs = [1];
    h.mismatches = [{ kind: 'rows-changed', seq: 1, day: '2026-10-21', table: 'AuditLog' }];
    await night(3);
    expect(chainResult()).toMatchObject({ status: 'info', count: 1, detail: { carried: 0 } });
    // Recomputed and clean (the change was put back): resolved...
    h.mismatches = [];
    await night(4);
    expect(chainResult()).toMatchObject({ status: 'pass', count: 0 });
    // ...so changed again, it is new again.
    h.mismatches = [{ kind: 'rows-changed', seq: 1, day: '2026-10-21', table: 'AuditLog' }];
    await night(5);
    expect(chainResult()).toMatchObject({ status: 'fail' });
  });

  it('a deletion the totals reported, found later in its seal’s range by the rotation, is not alerted again', async () => {
    h.windowSeqs = [5, 6, 7];
    h.mismatches = [{ kind: 'rows-deleted', seq: 7, day: '2026-10-27', table: 'AuditLog', totals: true, delta: 1 }];
    await night(0);
    expect(chainResult()).toMatchObject({ status: 'fail' });
    h.rotatedSeqs = [1];
    h.mismatches = [
      { kind: 'rows-deleted', seq: 1, day: '2026-10-21', table: 'AuditLog' },
      { kind: 'rows-deleted', seq: 8, day: '2026-10-28', table: 'AuditLog', totals: true, delta: 1 },
    ];
    expect(await night(1)).not.toHaveBeenCalled();
    expect(chainResult()).toMatchObject({ status: 'info', count: 2, detail: { new: 0 } });
    // A rows-changed in that range is no deletion: new.
    h.mismatches = [...h.mismatches, { kind: 'rows-changed', seq: 1, day: '2026-10-21', table: 'EditApproval' }];
    await night(2);
    expect(chainResult()).toMatchObject({ status: 'fail', detail: { new: 1 } });
  });

  it('a seal-chain finding carried across an errored night is still known', async () => {
    h.mismatches = [{ kind: 'body-edited', seq: 2, day: '2026-10-22' }];
    await night(0);
    expect(chainResult()).toMatchObject({ status: 'fail' });
    const good = h.results.map((r) => ({ ...r }));
    h.previous = [...good, { ...good.find((r) => r.checkId === 'seal-chain-intact')!, runAt: new Date(NOW.getTime() + 86_400_000), status: 'error', detail: { error: 'x' } }];
    h.results = [];
    const alert = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), { store, now: new Date(NOW.getTime() + 2 * 86_400_000), alert, inAppAlerts: false });
    expect(chainResult()).toMatchObject({ status: 'info' });
    expect(alert).not.toHaveBeenCalled();
  });
});

describe('the off-site copies of the last seals', () => {
  type Store = { get: (k: string) => Promise<string | null>; put: (k: string, b: string) => Promise<void>; list?: (p: string) => Promise<string[]> };
  const run = (s: Store, alert = vi.fn(async () => true)) =>
    runIntegrityWatch(fakeDb(), { store: { list: async () => LISTED, ...s }, now: NOW, alert, inAppAlerts: false });
  const copies = () => h.results.find((r) => r.checkId === 'seal-offsite-copies')!;

  it('a copy missing for a seal at most two days old is written again: information', async () => {
    h.sealedAt = '2026-10-23T02:30:00.000Z';
    const put = vi.fn(async () => undefined);
    const s = await run({ get: async (k) => (k === 'seals/2' ? null : '{}'), put });
    expect(copies()).toMatchObject({ status: 'info', count: 0, detail: { rewritten: 1 } });
    expect(put).toHaveBeenCalledWith('seals/2', '{}', 'd'.repeat(64));
    expect(s.r2Errors).toBe(0);
  });

  it('missing and older, or different: a failure named by seal; a copy that differs is critical', async () => {
    const alert = vi.fn(async () => true);
    await run({ get: async (k) => (k === 'seals/1' ? null : k === 'seals/3' ? '{"x":1}' : '{}'), put: async () => undefined }, alert);
    expect(copies()).toMatchObject({ status: 'fail', count: 2, sampleIds: ['1', '3'], detail: { missing: 1, differs: 1, critical: true } });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
  });

  it('the listing: an object no seal of the chain has is a new, critical finding once, then information', async () => {
    h.checks = [];
    const extra = 'seals/v1/0123456789abcdef/00000009.json';
    const alert = vi.fn(async () => true);
    await run({ get: async () => '{}', put: async () => undefined, list: async () => [...LISTED, extra] }, alert);
    expect(copies()).toMatchObject({ status: 'fail', count: 1, detail: { listed: true, objects: 4, unexpected: 1, critical: true } });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'critical' }));
    h.previous = h.results.map((r) => ({ ...r }));
    h.results = [];
    const again = vi.fn(async () => true);
    await runIntegrityWatch(fakeDb(), {
      store: { get: async () => '{}', put: async () => undefined, list: async () => [...LISTED, extra] },
      now: new Date(NOW.getTime() + 86_400_000),
      alert: again,
      inAppAlerts: false,
    });
    expect(copies()).toMatchObject({ status: 'info', count: 1, detail: { new: 0, critical: false } });
    expect(again).not.toHaveBeenCalled();
  });

  it('a copy missing that is only seen by the listing (an older seal) is a finding too, and warn, not critical', async () => {
    h.windowSeqs = [2, 3];
    const alert = vi.fn(async () => true);
    await run({ get: async () => '{}', put: async () => undefined, list: async () => ['seals/2', 'seals/3'] }, alert);
    expect(copies()).toMatchObject({ status: 'fail', count: 1, sampleIds: ['1'], detail: { missing: 1, critical: false } });
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ severity: 'warn' }));
  });

  it('R2 not answering is an R2 error (the run goes red), not a pass and not a failure of the chain', async () => {
    const fail = async () => {
      throw new Error('R2 timeout');
    };
    const s = await run({ get: fail, put: async () => undefined, list: fail });
    expect(copies()).toMatchObject({ status: 'error', count: null, detail: { unread: 3, listed: false } });
    expect(h.results.find((r) => r.checkId === 'seal-chain-intact')).toMatchObject({ status: 'pass' });
    // Tonight's own copy, the three read back, and the listing.
    expect(s.r2Errors).toBe(5);
  });
});
