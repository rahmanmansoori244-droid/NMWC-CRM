// @vitest-environment node
/**
 * DG-03/04 regression — customer-bound attachments must follow a merge.
 *
 * A merge asserts the two rows are the SAME legal entity, so the loser's CR and
 * GUARANTEE documents are the winner's documents. Two bugs, both on the happy path:
 *
 *   1. `Customer.crPhotoId` is a NON-deferrable unique index. The old code set the
 *      winner's slot while the loser still held the same attachment id, so any merge
 *      where only the loser had a CR photo aborted with P2002.
 *   2. The slot pointer moved but `Attachment.customerId` did not, and GUARANTEE docs
 *      (bound by customerId) never moved at all — leaving them on a soft-deleted
 *      customer, where assertCanAccessAttachment 404s them for every role except
 *      STEWARD/VIEWER and services/temix.ts's live-GUARANTEE groupBy cannot see them.
 *
 * The third test pins the POLICY: a merge must never RELEASE (soft-delete) an
 * attachment. If a later pass turns merge into a release path, that test goes red and
 * the decision has to be made explicitly.
 *
 * GATED; isolated QA branch only; ZZREPAR- synthetic rows cleaned in afterAll.
 *   RUN_MERGE_TESTS=1 node scripts/qa/run-with-env.mjs vitest run \
 *     tests/integration/merge-attachment-reparent.test.ts
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { purgeAuditLog } from '../support/audit';
import { randomUUID } from 'node:crypto';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ENABLED = process.env.RUN_MERGE_TESTS === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const P = 'ZZREPAR';
const ids = {
  steward: `${P}-steward`,
  region: `${P}-region`,
  route: `${P}-route`,
  winner: `${P}-W`,
  loser: `${P}-L`,
  brW: `${P}-brW`,
  brL: `${P}-brL`,
  crW: `${P}-crW`,
  crL: `${P}-crL`,
  g1: `${P}-g1`,
  g2: `${P}-g2`,
  gDead: `${P}-gDead`,
};
const CUSTOMER_IDS = [ids.winner, ids.loser];
const ATTACHMENT_IDS = [ids.crW, ids.crL, ids.g1, ids.g2, ids.gDead];

describe.skipIf(!ENABLED)('DG-03/04: merge re-parents customer-bound attachments', () => {
  let prisma: import('@prisma/client').PrismaClient;
  let dups: typeof import('@/services/duplicates');

  async function cleanup() {
    await purgeAuditLog(prisma, { where: { actorId: ids.steward } });
    // Customer.crPhotoId is a real FK to Attachment — clear both slots before the
    // attachment rows go, so the delete order is never load-bearing.
    await prisma.customer.updateMany({
      where: { id: { in: CUSTOMER_IDS } },
      data: { crPhotoId: null },
    });
    await prisma.attachment.deleteMany({ where: { id: { in: ATTACHMENT_IDS } } });
    await prisma.branch.deleteMany({ where: { id: { in: [ids.brW, ids.brL] } } });
    await prisma.customer.deleteMany({ where: { id: { in: CUSTOMER_IDS } } });
    await prisma.route.deleteMany({ where: { id: ids.route } });
    await prisma.region.deleteMany({ where: { id: ids.region } });
    await prisma.user.deleteMany({ where: { id: ids.steward } });
  }

  async function makeAttachment(
    id: string,
    kind: 'CR' | 'GUARANTEE',
    customerId: string,
    deletedAt: Date | null = null
  ) {
    return prisma.attachment.create({
      data: {
        id,
        kind,
        r2Key: `${P}/${randomUUID()}.jpg`,
        mimeType: 'image/jpeg',
        bytes: 123_456,
        capturedById: ids.steward,
        capturedAt: new Date(),
        hash: deletedAt ? null : randomUUID().replace(/-/g, ''),
        customerId,
        deletedAt,
      },
    });
  }

  beforeEach(async () => {
    if (!ENABLED) return;
    if (!prisma) {
      ({ prisma } = await import('@/lib/db'));
      dups = await import('@/services/duplicates');
    }
    await cleanup();
    await prisma.user.create({
      data: {
        id: ids.steward,
        username: ids.steward,
        passwordHash: 'x',
        fullName: 'ZZ Reparent Steward',
        role: 'STEWARD',
      },
    });
    await prisma.region.create({
      data: { id: ids.region, code: `${P}-${randomUUID().slice(0, 6)}`, name: 'ZZ Reparent Region' },
    });
    await prisma.route.create({
      data: {
        id: ids.route,
        code: `${P}RT-${randomUUID().slice(0, 6)}`,
        name: 'ZZ Reparent Route',
        regionId: ids.region,
      },
    });
    await prisma.customer.create({
      data: {
        id: ids.winner,
        nmwcCode: `${P}-W-${randomUUID().slice(0, 6)}`,
        legalName: 'ZZ Winner',
        paymentTerms: 'CREDIT',
      },
    });
    await prisma.customer.create({
      data: {
        id: ids.loser,
        nmwcCode: `${P}-L-${randomUUID().slice(0, 6)}`,
        legalName: 'ZZ Loser',
        paymentTerms: 'CREDIT',
      },
    });
    // Same region for both → no cross-region confirmation gate.
    await prisma.branch.create({
      data: {
        id: ids.brW,
        customerId: ids.winner,
        branchCode: `${P}-W-01`,
        branchName: 'W main',
        regionId: ids.region,
        routeId: ids.route,
        address: 'ZZ addr W',
      },
    });
    await prisma.branch.create({
      data: {
        id: ids.brL,
        customerId: ids.loser,
        branchCode: `${P}-L-01`,
        branchName: 'L main',
        regionId: ids.region,
        routeId: ids.route,
        address: 'ZZ addr L',
      },
    });
    // The loser holds the credit evidence: one slotted CR, two live GUARANTEEs and
    // one ALREADY soft-deleted GUARANTEE that must NOT be revived by the re-parent.
    await makeAttachment(ids.crL, 'CR', ids.loser);
    await prisma.customer.update({ where: { id: ids.loser }, data: { crPhotoId: ids.crL } });
    await makeAttachment(ids.g1, 'GUARANTEE', ids.loser);
    await makeAttachment(ids.g2, 'GUARANTEE', ids.loser);
    await makeAttachment(ids.gDead, 'GUARANTEE', ids.loser, new Date(Date.now() - 86_400_000));
    current = { id: ids.steward, role: 'STEWARD', username: ids.steward };
  });

  afterAll(async () => {
    if (!prisma) return;
    await cleanup().catch(() => {});
    await prisma.$disconnect();
  });

  function mergeForm() {
    const f = new FormData();
    f.set('winnerId', ids.winner);
    f.set('loserId', ids.loser);
    return f;
  }

  it('winner has NO CR: the merge SUCCEEDS (no P2002) and the CR slot + docs move', async () => {
    const res = await dups.mergeCustomersAction(mergeForm());
    // PRE-FIX THIS IS THE FAILING LINE. Customer.crPhotoId is a non-deferrable
    // unique index; the old code wrote the winner's slot while the loser still held
    // the same id, so Postgres raised 23505 and runAction returned ok:false.
    expect(res.ok).toBe(true);

    const winner = await prisma.customer.findUniqueOrThrow({ where: { id: ids.winner } });
    const loser = await prisma.customer.findUniqueOrThrow({ where: { id: ids.loser } });
    expect(winner.crPhotoId).toBe(ids.crL);
    expect(loser.crPhotoId).toBeNull();
    expect(loser.deletedAt).not.toBeNull();

    // The attachment row itself follows the slot — otherwise it resolves through a
    // soft-deleted customer and assertCanAccessAttachment 404s it.
    const crL = await prisma.attachment.findUniqueOrThrow({ where: { id: ids.crL } });
    expect(crL.customerId).toBe(ids.winner);
  });

  it('winner ALREADY has a CR: it keeps its own, and the loser docs still re-parent', async () => {
    await makeAttachment(ids.crW, 'CR', ids.winner);
    await prisma.customer.update({ where: { id: ids.winner }, data: { crPhotoId: ids.crW } });

    const res = await dups.mergeCustomersAction(mergeForm());
    expect(res.ok).toBe(true);

    const winner = await prisma.customer.findUniqueOrThrow({ where: { id: ids.winner } });
    const loser = await prisma.customer.findUniqueOrThrow({ where: { id: ids.loser } });
    expect(winner.crPhotoId).toBe(ids.crW); // never overwritten
    expect(loser.crPhotoId).toBeNull(); // always released

    // PRE-FIX THIS IS THE FAILING LINE. The old `if` was false in this branch, so
    // the loser's CR stayed on a customer that is soft-deleted three statements
    // later — 404 for every role except STEWARD/VIEWER.
    const crL = await prisma.attachment.findUniqueOrThrow({ where: { id: ids.crL } });
    expect(crL.customerId).toBe(ids.winner);

    // PRE-FIX THIS IS THE OTHER FAILING LINE: 0, not 2. Exact predicate from
    // services/temix.ts withGuaranteeCounts — the winner's Temix export understated
    // the credit evidence behind its own limit.
    const winnerGuarantees = await prisma.attachment.count({
      where: { customerId: ids.winner, kind: 'GUARANTEE', deletedAt: null },
    });
    expect(winnerGuarantees).toBe(2);
  });

  it('POLICY PIN: a merge RELEASES nothing, and does not revive an already-dead doc', async () => {
    const res = await dups.mergeCustomersAction(mergeForm());
    expect(res.ok).toBe(true);

    // Nothing that was live before the merge may come back soft-deleted. This fails
    // on nothing today; it is here so that a later pass cannot quietly turn merge
    // into a release path without the decision being made explicitly.
    const released = await prisma.attachment.count({
      where: { id: { in: [ids.crL, ids.g1, ids.g2] }, deletedAt: { not: null } },
    });
    expect(released).toBe(0);

    // The already-soft-deleted GUARANTEE stays dead AND stays on the loser — it
    // belongs to photo-gc, not to the winner.
    const dead = await prisma.attachment.findUniqueOrThrow({ where: { id: ids.gDead } });
    expect(dead.deletedAt).not.toBeNull();
    expect(dead.customerId).toBe(ids.loser);
  });
});
