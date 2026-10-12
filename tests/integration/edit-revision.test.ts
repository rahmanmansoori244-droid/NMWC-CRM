// @vitest-environment node
/**
 * Gaps 12 and 27 (data audit 2026-10-10, lossless paths) on Postgres: a
 * new-customer request keeps every round, and what was known when it was sent.
 *
 *   - each submit writes an EditRevision row in its transaction: cycle 1, then a
 *     resubmit after a send-back is cycle 2 — the first round is still there, as
 *     sent, with its own fingerprint; a draft writes none;
 *   - the round holds the terms, chain and documents, and personal values only as
 *     fingerprints;
 *   - a send-back keeps its category on the decision row and in the ledger;
 *   - the submit's audit row carries the duplicate signals and the round's hash;
 *   - a submit refused as an exact duplicate is recorded (CustomerCreateAttempt);
 *   - EditRevision refuses an update and a delete outside the owner's window.
 *
 *   RUN_LOSSLESS=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/edit-revision.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createFlowFixture } from '../support/create-flow-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ENABLED = process.env.RUN_LOSSLESS === '1' && !!process.env.DATABASE_URL;
const REFUSED = /append-only|insufficient_privilege|permission denied/;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const fx = createFlowFixture('zzrv', (u) => {
  current = u;
});

describe.skipIf(!ENABLED)('every round of a new-customer request is kept (gap 12)', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let creates: typeof import('@/services/creates');
  let editId = '';
  const name = `ZZ Rounds ${fx.tag}`;

  beforeAll(async () => {
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    if ((process.env.DIRECT_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    creates = await import('@/services/creates');
    await fx.setup(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      await fx.cleanup();
    } finally {
      await prisma.$disconnect();
    }
  });

  it('a draft keeps no round; the first submit keeps round 1, as sent, personal values as fingerprints', async () => {
    fx.as(fx.ids.salesman, 'SALESMAN');
    const draft = await creates.submitCreateAction({ ...(await fx.cashBody(name, 11)), isDraft: true });
    expect(draft.ok, JSON.stringify(draft)).toBe(true);
    if (!draft.ok) return;
    editId = draft.data.editId;
    expect(await prisma.editRevision.count({ where: { editId } })).toBe(0);

    const sent = await creates.submitCreateAction(await fx.cashBody(name, 11, { editId }));
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    const [r1] = await prisma.editRevision.findMany({ where: { editId }, orderBy: { id: 'asc' } });
    expect(r1).toMatchObject({ cycle: 1, process: 'CREATE', submittedById: fx.ids.salesman, paymentTerms: 'CASH', source: `edit:${editId}` });
    const text = JSON.stringify(r1!.payload);
    expect(text).not.toContain(name);
    expect(text).not.toContain('ZZ Contact');
    expect(text).toContain('"dayOfVisit":"THU"');
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'CustomerEdit', entityId: editId, after: { path: ['state'], equals: 'SUBMITTED' } },
      orderBy: { at: 'desc' },
    });
    expect(audit.after).toMatchObject({ revisionSha256: r1!.payloadSha256, duplicateSignals: { crMatch: false } });
  });

  it('a send-back keeps its category; the resubmit is round 2, and round 1 is untouched', async () => {
    fx.as(fx.ids.supervisor, 'SUPERVISOR');
    const back = await fx.decide('reject', editId, { reason: 'Visit day is wrong, check with the shop.', category: 'wrong_info' });
    expect(back.ok, JSON.stringify(back)).toBe(true);
    const step = await prisma.editApproval.findFirstOrThrow({ where: { editId, decision: 'REJECTED' } });
    expect(step.category).toBe('wrong_info');
    const reject = await prisma.auditLog.findFirstOrThrow({ where: { action: 'REJECT', entityId: editId } });
    expect(reject.after).toMatchObject({ decisionCategory: 'wrong_info' });

    const [r1before] = await prisma.editRevision.findMany({ where: { editId }, orderBy: { id: 'asc' } });
    fx.as(fx.ids.salesman, 'SALESMAN');
    const again = await creates.submitCreateAction(await fx.cashBody(name, 11, { editId, dayOfVisit: 'MON' }));
    expect(again.ok, JSON.stringify(again)).toBe(true);
    const rounds = await prisma.editRevision.findMany({ where: { editId }, orderBy: { id: 'asc' } });
    expect(rounds.map((r) => r.cycle)).toEqual([1, 2]);
    expect(rounds[0]).toEqual(r1before);
    expect(rounds[1]!.payloadSha256).not.toBe(rounds[0]!.payloadSha256);
    expect(JSON.stringify(rounds[1]!.payload)).toContain('"dayOfVisit":"MON"');
  });

  it('a submit refused as an exact duplicate (same CR) is recorded, by attempt', async () => {
    fx.as(fx.ids.salesman, 'SALESMAN');
    const first = await prisma.editCustomerDraft.findUniqueOrThrow({ where: { editId }, select: { crNumber: true } });
    const body = await fx.cashBody(`ZZ Duplicate ${fx.tag}`, 77);
    const res = await creates.submitCreateAction({ ...body, customer: { ...body.customer, crNumber: first.crNumber! } });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.code).toBe('DUPLICATE_CR');
    const attempt = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: fx.ids.salesman, entityType: 'CustomerCreateAttempt' },
    });
    expect(attempt).toMatchObject({ action: 'REJECT', reason: 'refused: duplicate' });
    expect(attempt.after).toMatchObject({ rule: 'DUPLICATE_CR' });
    expect(JSON.stringify(attempt.after)).not.toContain(first.crNumber!);
  });

  it('a round cannot be changed or removed outside the owner’s maintenance window', async () => {
    const r = await prisma.editRevision.findFirstOrThrow({ where: { editId } });
    await expect(prisma.editRevision.update({ where: { id: r.id }, data: { cycle: 9 } })).rejects.toThrow(REFUSED);
    await expect(prisma.editRevision.delete({ where: { id: r.id } })).rejects.toThrow(REFUSED);
  });
});
