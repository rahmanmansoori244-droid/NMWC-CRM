// @vitest-environment node
/**
 * Gap 22 (data audit 2026-10-10), on Postgres: the losing side of two people
 * deciding at once is recorded.
 *
 *   - two reviewers approve one request from the same page: one lands, the
 *     other is answered NOT_PENDING exactly as before — and leaves one CONFLICT
 *     audit row under his own name, a conflict:edit.approve:<id> source, the
 *     stage he decided on and what the winner left;
 *   - a decision made on a page the request has moved past (STALE_VIEW) is
 *     recorded the same way;
 *   - nothing else of the losing decision is written.
 *
 *   RUN_ACCOUNTABILITY=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/conflict-record.test.ts
 *
 * Synthetic rows only, removed again.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { freshDecisionToken } from '../support/decision-token';
import { assertNotProductionEnv, buildWorld, submittedUpdate, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_ACCOUNTABILITY === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

describe.skipIf(!ENABLED)('gap 22: a lost race is recorded', () => {
  let prisma: PrismaClient;
  let edits: typeof import('@/services/edits');
  let w: World;
  const decide = (editId: string, token: string, kind: 'approve' | 'reject' = 'approve') => {
    const fd = new FormData();
    fd.set('editId', editId);
    fd.set('decisionToken', token);
    if (kind === 'reject') {
      fd.set('reason', 'Synthetic send-back for the conflict test');
      fd.set('category', 'other');
      return edits.rejectEditAction(fd);
    }
    return edits.approveEditAction(fd);
  };
  const conflicts = (entityId: string) =>
    prisma.auditLog.findMany({ where: { action: 'CONFLICT', entityId }, orderBy: { at: 'asc' } });
  /** The row is written within runAction's budget; a slow link is waited for, not failed. */
  const settled = async (entityId: string, n: number) => {
    await expect.poll(async () => (await conflicts(entityId)).length, { timeout: 15_000 }).toBe(n);
    return conflicts(entityId);
  };

  beforeAll(async () => {
    assertNotProductionEnv();
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    w = await buildWorld(prisma, 'conflict');
  });

  afterAll(async () => {
    if (prisma && w) await tearDownWorld(prisma, w);
    await prisma?.$disconnect();
  });

  it('two approvals of one request from the same page: one lands, the other is a 409 and one CONFLICT row', async () => {
    const id = await submittedUpdate(prisma, w, '06:00-22:00');
    const page = await freshDecisionToken(prisma, id);
    current = { id: w.sup, role: 'SUPERVISOR', username: w.sup };
    expect(await decide(id, page)).toMatchObject({ ok: true });
    current = { id: w.manager, role: 'MANAGER', username: w.manager };
    const lost = await decide(id, page);
    expect(lost).toEqual({ ok: false, code: 'NOT_PENDING', message: 'Edit is in state APPROVED.' });

    const rows = await settled(id, 1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      actorId: w.manager,
      entityType: 'CustomerEdit',
      reason: 'NOT_PENDING: edit.approve',
      source: `conflict:edit.approve:${id}`,
    });
    expect(row.txId).not.toBeNull();
    expect(row.after).toMatchObject({
      code: 'NOT_PENDING',
      path: 'edit.approve',
      liveVersion: 'APPROVED',
      live: { state: 'APPROVED', reviewedById: w.sup },
    });
    // The loser wrote nothing else: one decision, the winner's.
    expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: id, actorId: w.manager, action: { not: 'CONFLICT' } } })).toBe(0);
  });

  it('a decision on a page the request has moved past (STALE_VIEW) is recorded the same way', async () => {
    const id = await submittedUpdate(prisma, w, '06:30-22:00');
    const page = await freshDecisionToken(prisma, id);
    // The request moves on under the page: a new stage visit (as a step-back and
    // a re-advance leave it), so the page's token no longer matches.
    await prisma.customerEdit.update({ where: { id }, data: { stageEnteredAt: new Date(Date.now() + 1000) } });
    current = { id: w.sup, role: 'SUPERVISOR', username: w.sup };
    const lost = await decide(id, page, 'reject');
    expect(lost).toMatchObject({ ok: false, code: 'STALE_VIEW' });
    const rows = await settled(id, 1);
    expect(rows.map((r) => [r.actorId, r.reason, r.source])).toEqual([
      [w.sup, 'STALE_VIEW: edit.reject', `conflict:edit.reject:${id}`],
    ]);
    expect(rows[0]!.after).toMatchObject({ code: 'STALE_VIEW', expectedVersion: 'cycle 1 step 0', liveVersion: 'cycle 1 step 0' });
    expect(await prisma.editApproval.count({ where: { editId: id } })).toBe(0);
    // Decided properly from a fresh page, so the world tears down cleanly.
    expect(await decide(id, await freshDecisionToken(prisma, id), 'reject')).toMatchObject({ ok: true });
  });
});
