// @vitest-environment node
/**
 * Gap 18 on Postgres: a request records where it was raised (migration
 * 20261025090100_request_scope_at_submit, lib/scope-at-submit.ts), and the
 * record agrees with the dated history as of the moment it was sent.
 *
 *   - an UPDATE submit (an opening-hours change on his shop), a close and a
 *     reactivation, sent by the salesman through the services: routeIdAtSubmit
 *     is the route nmwc_users_at says he held at submittedAt, regionIdsAtSubmit
 *     the region BranchHistory says the shop was in then;
 *   - the sealed CREATE audit row carries the same, and the chain is frozen
 *     with its calendar (gap 37);
 *   - the evidence guard refuses either column changing once the request was
 *     sent;
 *   - moving the route's holder afterwards changes nothing recorded.
 *
 *   RUN_REQUEST_SCOPE=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/request-scope-at-submit.test.ts
 *
 * Synthetic rows only (the accountability world), removed again, history
 * included. Written with the audit-gaps branch; NOT run there (no database).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { editPayload } from '../support/edit-payload';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });
const ENABLED = process.env.RUN_REQUEST_SCOPE === '1' && !!process.env.DATABASE_URL;

type MockUser = { id: string; role: string; username: string } | null;
let current: MockUser = null;
vi.mock('@/lib/auth', () => ({ auth: async () => (current ? { user: current } : null) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const REFUSED = /evidence, append-only|insufficient_privilege/;

describe.skipIf(!ENABLED)('gap 18: where a request was raised', () => {
  let prisma: PrismaClient;
  let edits: typeof import('@/services/edits');
  let reacts: typeof import('@/services/reactivations');
  let w: World;
  const editIds: string[] = [];
  const as = (id: string, role: string) => {
    current = { id, role, username: id };
  };
  const at = (d: Date) => Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

  /** What the dated history says about the request's submitter and shop at its submittedAt. */
  async function asOf(editId: string) {
    const e = await prisma.customerEdit.findUniqueOrThrow({ where: { id: editId } });
    const [u] = await prisma.$queryRaw<Array<{ owned_route_id: string | null }>>(
      Prisma.sql`SELECT owned_route_id FROM nmwc_users_at(${at(e.submittedAt!)}) WHERE user_id = ${e.submittedById}`
    );
    const [b] = await prisma.$queryRaw<Array<{ regionId: string }>>(
      Prisma.sql`SELECT h."regionId" FROM "BranchHistory" h
                  WHERE h."branchId" = ${w.branch} AND h."validFrom" <= ${at(e.submittedAt!)}
                  ORDER BY h."validFrom" DESC, h."id" DESC LIMIT 1`
    );
    return { e, routeThen: u?.owned_route_id ?? null, regionThen: b?.regionId ?? null };
  }

  async function photo(): Promise<string> {
    const a = await prisma.attachment.create({
      data: {
        kind: 'SHOP', r2Key: `synthetic/${w.sfx}/${Date.now()}-${editIds.length}.jpg`, mimeType: 'image/jpeg', bytes: 1,
        capturedById: w.salesman, capturedAt: new Date(), branchId: w.branch,
      },
    });
    w.attachments.push(a.id);
    return a.id;
  }

  beforeAll(async () => {
    assertNotProductionEnv();
    ({ prisma } = await import('@/lib/db'));
    edits = await import('@/services/edits');
    reacts = await import('@/services/reactivations');
    w = await buildWorld(prisma, 'scopesub');
  });

  afterAll(async () => {
    if (!prisma || !w) return;
    await tearDownWorld(prisma, w, { editIds });
    await prisma.$disconnect();
  });

  it('an update submit records his route and his shop’s region, as the history has them then', async () => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.salesman } } });
    // The completeness gate (owner decision 4, 2026-10-07) checks the shop being
    // changed: it needs its GPS and its shop photo, as a real shop on a route has.
    // The world's shop is created bare, so give it both before the salesman sends.
    await prisma.branch.update({ where: { id: w.branch }, data: { gpsLat: 23.6, gpsLng: 58.4, shopPhotoId: await photo() } });
    as(w.salesman, 'SALESMAN');
    const res = await edits.submitEditAction(
      await editPayload(prisma, { customerId: w.customer, branches: [{ branchId: w.branch, openingHours: '08:00-20:00 (synthetic)' }] })
    );
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true });
    const editId = (res as { ok: true; data: { editId: string } }).data.editId;
    editIds.push(editId);
    const { e, routeThen, regionThen } = await asOf(editId);
    expect(e).toMatchObject({ state: 'SUBMITTED', routeIdAtSubmit: w.route, regionIdsAtSubmit: [w.regionA] });
    expect(routeThen).toBe(w.route);
    expect(regionThen).toBe(w.regionA);
    // The chain is frozen (gap 37): the bare array while CHAIN_OBJECT_FORM_ENABLED is off.
    expect(e.approvalChain).toMatchObject([{ role: 'SUPERVISOR', scope: 'SUPERVISOR_OF_SUBMITTER' }]);
    // The sealed CREATE row carries the same.
    const row = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'CustomerEdit', entityId: editId, action: 'CREATE' } });
    expect(row.after).toMatchObject({ routeIdAtSubmit: w.route, regionIdsAtSubmit: [w.regionA] });
    // Once sent, neither column may change.
    await expect(prisma.customerEdit.update({ where: { id: editId }, data: { routeIdAtSubmit: null } })).rejects.toThrow(REFUSED);
    await expect(prisma.customerEdit.update({ where: { id: editId }, data: { regionIdsAtSubmit: [w.regionB] } })).rejects.toThrow(REFUSED);
    // Close it so the next request on this customer can be sent.
    await prisma.customerEdit.update({ where: { id: editId }, data: { state: 'REJECTED', pendingRole: null, decisionReason: 'synthetic' } });
  });

  it('a close and a reactivation record the same; the chain is the step they ride', async () => {
    await prisma.rateLimit.deleteMany({ where: { key: { contains: w.salesman } } });
    as(w.salesman, 'SALESMAN');
    const close = new FormData();
    close.set('branchId', w.branch);
    close.set('reason', 'Closed for good (synthetic)');
    close.set('attachmentId', await photo());
    const closed = await reacts.markBranchClosedAction(close);
    expect(closed, JSON.stringify(closed)).toMatchObject({ ok: true });
    const closeId = (closed as { ok: true; data: { editId: string } }).data.editId;
    editIds.push(closeId);
    const c = await asOf(closeId);
    expect(c.e).toMatchObject({ routeIdAtSubmit: w.route, regionIdsAtSubmit: [w.regionA] });
    expect(c.routeThen).toBe(w.route);
    expect(c.regionThen).toBe(w.regionA);
    expect(c.e.approvalChain).toMatchObject([{ role: 'SUPERVISOR' }]);
    await prisma.customerEdit.update({ where: { id: closeId }, data: { state: 'REJECTED', pendingRole: null, decisionReason: 'synthetic' } });

    await prisma.branch.update({ where: { id: w.branch }, data: { status: 'CLOSED', lastStatusChangeAt: new Date(Date.now() - 86_400_000) } });
    const reopen = new FormData();
    reopen.set('branchId', w.branch);
    reopen.set('reason', 'Open again (synthetic)');
    reopen.set('attachmentId', await photo());
    const opened = await reacts.requestReactivationAction(reopen);
    expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
    const reactId = (opened as { ok: true; data: { editId: string } }).data.editId;
    editIds.push(reactId);
    const r = await asOf(reactId);
    expect(r.e).toMatchObject({ isReactivation: true, routeIdAtSubmit: w.route, regionIdsAtSubmit: [w.regionA] });
    expect(r.e.approvalChain).toMatchObject([{ role: 'MANAGER', scope: 'REGION_OVERLAP' }]);

    // The route handed on afterwards: what was recorded stays.
    await prisma.user.update({ where: { id: w.salesman }, data: { ownedRouteId: null } });
    expect((await prisma.customerEdit.findUniqueOrThrow({ where: { id: reactId } })).routeIdAtSubmit).toBe(w.route);
    await prisma.user.update({ where: { id: w.salesman }, data: { ownedRouteId: w.route } });
  });
});
