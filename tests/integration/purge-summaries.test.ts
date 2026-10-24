// @vitest-environment node
/**
 * Gap 25 on Postgres: every retention rule writes its PurgeSummary row in the
 * same statement as the deletion (lib/purge-summary.ts).
 *
 * For each rule, synthetic rows dated long before the application existed
 * (December 2024; the statements run with a `now` whose cut-off is 1 January
 * 2025, so they can only ever reach these rows), one older than the cut-off and
 * one newer. Each test checks the summary's rule, row count and date range,
 * that the old row is gone (or emptied) and the newer one stays. A summary can be
 * neither changed nor deleted outside the owner's maintenance window.
 *
 *   RUN_WATCH=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/purge-summaries.test.ts
 *
 * Written with the watch-and-prove branch; NOT run there (no database was used).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  cronRunPurgeSql,
  importPayloadPurgeSql,
  passwordHistoryPurgeSql,
  photoPurgeSql,
  rateLimitPurgeSql,
  readNotificationPurgeSql,
  runPurge,
  unreadNotificationPurgeSql,
} from '@/lib/purge-summary';
import { RETENTION_RULES } from '@/lib/retention-rules';
import { src, withChangeContext } from '@/lib/change-context';
import { purgeHistory, purgeJobRunDays, purgePurgeSummaries } from '../support/audit';
import { assertNotProductionEnv, buildWorld, tearDownWorld, type World } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const ENABLED = process.env.RUN_WATCH === '1' && !!process.env.DATABASE_URL;

const DAY = 86_400_000;
const CUTOFF = new Date('2025-01-01T00:00:00.000Z');
/** The `now` at which `rule` cuts off at CUTOFF. */
const nowFor = (days: number) => new Date(CUTOFF.getTime() + days * DAY);
const OLD = new Date('2024-12-01T08:00:00.000Z');
const NEWER = new Date('2025-01-15T08:00:00.000Z');

describe.skipIf(!ENABLED)('gap 25: every purge leaves its summary', () => {
  let prisma: PrismaClient;
  let w: World;
  const sfx = `zzw${Date.now().toString(36)}`;
  // The production shape ('<job>:<run start ISO>'), and NOT the fixtures' suffix: the
  // summaries are asserted not to contain it, so the run's own id must not carry it.
  const runId = `test-purge:${new Date().toISOString()}`;
  const run = { runId };
  const attachmentIds: string[] = [];
  const cause = { actorId: null, source: src.test('purge-summaries') };
  const summaries = (rule: string) => prisma.purgeSummary.findMany({ where: { runId, rule }, orderBy: { id: 'asc' } });
  // A summary's id is a BIGINT (BigInt in the client), which JSON.stringify refuses: serialize it as text.
  const asText = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  const purge = (rule: Parameters<typeof runPurge>[1], stmt: Parameters<typeof runPurge>[2]) =>
    withChangeContext(prisma, cause, (tx) => runPurge(tx, rule, stmt));

  beforeAll(async () => {
    assertNotProductionEnv();
    if ((process.env.DATABASE_URL ?? '').includes('ep-sweet-haze')) throw new Error('ABORT: production');
    ({ prisma } = await import('@/lib/db'));
    w = await buildWorld(prisma, 'purgesum');
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.rateLimit.deleteMany({ where: { key: { startsWith: `login:user:${sfx}` } } });
    await prisma.cronRun.deleteMany({ where: { key: { startsWith: sfx } } });
    await purgeJobRunDays(prisma, { where: { key: { startsWith: sfx } } });
    await prisma.importRow.deleteMany({ where: { batch: { filename: { startsWith: sfx } } } });
    await prisma.importBatch.deleteMany({ where: { filename: { startsWith: sfx } } });
    await prisma.passwordHistory.deleteMany({ where: { userId: { in: w?.users ?? [] } } });
    const atts = await prisma.attachment.findMany({ where: { r2Key: { startsWith: sfx } }, select: { id: true } });
    await prisma.attachment.deleteMany({ where: { r2Key: { startsWith: sfx } } });
    await purgePurgeSummaries(prisma, { where: { runId } });
    if (w) {
      await tearDownWorld(prisma, w);
      await purgeHistory(prisma, { attachmentIds: [...atts.map((a) => a.id), ...attachmentIds] });
    }
    await prisma.$disconnect();
  });

  it('rate-limit-1d: counted by bucket kind, never by key', async () => {
    await prisma.rateLimit.create({ data: { key: `login:user:${sfx}-old`, tokens: 0, updatedAt: OLD } });
    await prisma.rateLimit.create({ data: { key: `login:user:${sfx}-new`, tokens: 0, updatedAt: NEWER } });
    // Prisma sets updatedAt itself: put the dates back.
    await prisma.$executeRaw`UPDATE "RateLimit" SET "updatedAt" = ${OLD} WHERE "key" = ${`login:user:${sfx}-old`}`;
    await prisma.$executeRaw`UPDATE "RateLimit" SET "updatedAt" = ${NEWER} WHERE "key" = ${`login:user:${sfx}-new`}`;
    expect(await purge('rate-limit-1d', rateLimitPurgeSql(nowFor(1), 500, run))).toBe(1);
    const [s] = await summaries('rate-limit-1d');
    expect(s).toMatchObject({ job: 'retention-sweep', tableName: 'RateLimit', action: 'DELETE', rows: 1, retentionDays: 1, source: cause.source });
    expect(s!.oldestAt!.toISOString()).toBe(OLD.toISOString());
    expect(s!.detail).toEqual({ byKind: { 'login:user': 1 } });
    expect(asText(s)).not.toContain(sfx);
    expect(await prisma.rateLimit.count({ where: { key: { startsWith: `login:user:${sfx}` } } })).toBe(1);
  });

  it('notification-unread-180d and notification-read-90d: by month, kind and e-mail outcome', async () => {
    const base = { userId: w.steward, kind: 'TEMIX_UPLOAD_READY' as const, title: 'ZZ', body: 'ZZ' };
    await prisma.notification.createMany({
      data: [
        { ...base, id: `${sfx}-n1`, createdAt: OLD, emailStatus: 'SENT' },
        { ...base, id: `${sfx}-n2`, createdAt: NEWER },
        { ...base, id: `${sfx}-n3`, createdAt: OLD, readAt: OLD },
        { ...base, id: `${sfx}-n4`, createdAt: OLD, readAt: NEWER },
      ],
    });
    expect(await purge('notification-unread-180d', unreadNotificationPurgeSql(nowFor(180), 500, run))).toBe(1);
    expect(await purge('notification-read-90d', readNotificationPurgeSql(nowFor(90), 500, run))).toBe(1);
    const [unread] = await summaries('notification-unread-180d');
    expect(unread!.detail).toEqual({ byMonth: { '2024-12': { byKind: { TEMIX_UPLOAD_READY: { SENT: 1 } } } } });
    const [read] = await summaries('notification-read-90d');
    expect(read).toMatchObject({ job: 'sla-escalate', rows: 1, dateColumn: 'readAt' });
    expect(read!.detail).toEqual({ byMonth: { '2024-12': { byKind: { TEMIX_UPLOAD_READY: { NONE: 1 } } } } });
    const left = await prisma.notification.findMany({ where: { id: { startsWith: sfx } }, select: { id: true }, orderBy: { id: 'asc' } });
    expect(left.map((n) => n.id)).toEqual([`${sfx}-n2`, `${sfx}-n4`]);
  });

  it('import-payload-90d: the payload is emptied, the row and its outcome kept, counted by batch and state', async () => {
    const b = await prisma.importBatch.create({
      data: { filename: `${sfx}.xlsx`, uploadedById: w.steward, status: 'PROMOTED', uploadedAt: OLD },
    });
    await prisma.importRow.createMany({
      data: [
        { id: `${sfx}-r1`, batchId: b.id, rowNumber: 2, raw: { name: 'ZZ' }, parsed: { name: 'ZZ' }, state: 'PROMOTED', createdAt: OLD },
        { id: `${sfx}-r2`, batchId: b.id, rowNumber: 3, raw: { name: 'ZZ' }, state: 'CLEAN', createdAt: OLD },
        { id: `${sfx}-r3`, batchId: b.id, rowNumber: 4, raw: { name: 'ZZ' }, state: 'PROMOTED', createdAt: NEWER },
      ],
    });
    expect(await purge('import-payload-90d', importPayloadPurgeSql(nowFor(90), 2000, run))).toBe(1);
    const [s] = await summaries('import-payload-90d');
    expect(s).toMatchObject({ action: 'CLEAR_PAYLOAD', rows: 1 });
    expect(s!.detail).toEqual({ byBatch: { [b.id]: { PROMOTED: 1 } }, excludedAt: null });
    const rows = await prisma.importRow.findMany({ where: { batchId: b.id }, orderBy: { rowNumber: 'asc' } });
    expect(rows.map((r) => [r.state, JSON.stringify(r.raw), r.parsed])).toEqual([
      ['PROMOTED', '{}', null],
      ['CLEAN', '{"name":"ZZ"}', null],
      ['PROMOTED', '{"name":"ZZ"}', null],
    ]);
  });

  it('cron-run-90d: only runs whose day is kept, counted by job', async () => {
    const key = `${sfx}-job`;
    await prisma.cronRun.createMany({
      data: [
        { id: `${sfx}-c1`, key, at: OLD, ok: true, durationMs: 5 },
        { id: `${sfx}-c2`, key, at: new Date('2024-12-02T08:00:00Z'), ok: true, durationMs: 5 },
      ],
    });
    // Only the first day is kept: the second day's run must stay.
    await prisma.jobRunDay.create({
      data: { key, day: new Date('2024-12-01T00:00:00Z'), runs: 1, failures: 0, firstAt: OLD, lastAt: OLD, maxDurationMs: 5, sources: [] },
    });
    const n = await withChangeContext(prisma, cause, (tx) => runPurge(tx, 'cron-run-90d', cronRunPurgeSql(CUTOFF, 2000, run)));
    expect(n).toBe(1);
    const [s] = await summaries('cron-run-90d');
    expect(s!.detail).toEqual({ byKey: { [key]: 1 } });
    expect((await prisma.cronRun.findMany({ where: { key }, select: { id: true } })).map((r) => r.id)).toEqual([`${sfx}-c2`]);
    expect(RETENTION_RULES['cron-run-90d'].days).toBe(90);
  });

  it('photo-detached-30d: one detached photo past the cut-off, by kind, beside its history tombstone', async () => {
    const make = (n: number, deletedAt: Date) =>
      prisma.attachment.create({
        data: { kind: 'SHOP', r2Key: `${sfx}/p${n}.jpg`, mimeType: 'image/jpeg', bytes: 1, capturedById: w.steward, capturedAt: OLD, deletedAt },
      });
    const old = await make(1, OLD);
    const newer = await make(2, NEWER);
    attachmentIds.push(old.id, newer.id);
    expect(await purge('photo-detached-30d', photoPurgeSql(old.id, nowFor(30), run))).toBe(1);
    expect(await purge('photo-detached-30d', photoPurgeSql(newer.id, nowFor(30), run))).toBe(0);
    const s = await summaries('photo-detached-30d');
    expect(s).toHaveLength(1);
    expect(s[0]!.detail).toEqual({ byKind: { SHOP: 1 } });
    expect(await prisma.attachmentHistory.count({ where: { attachmentId: old.id, changeKind: 'DELETE' } })).toBe(1);
    expect(await prisma.attachment.count({ where: { id: newer.id } })).toBe(1);
  });

  it('password-history-last-5: the older hashes go, the person is not in the summary', async () => {
    const userId = w.sup;
    for (let i = 0; i < 7; i++) {
      await prisma.passwordHistory.create({ data: { id: `${sfx}-ph${i}`, userId, hash: `zz${i}`, createdAt: new Date(OLD.getTime() + i * DAY) } });
    }
    const keep = [2, 3, 4, 5, 6].map((i) => `${sfx}-ph${i}`);
    expect(await purge('password-history-last-5', passwordHistoryPurgeSql(userId, keep, run))).toBe(2);
    const [s] = await summaries('password-history-last-5');
    expect(s).toMatchObject({ job: 'password-policy', tableName: 'PasswordHistory', rows: 2, detail: null });
    expect(asText(s)).not.toContain(userId);
    expect(await prisma.passwordHistory.count({ where: { userId } })).toBe(5);
  });

  it('a summary can be neither changed nor deleted outside the maintenance window', async () => {
    const [s] = await summaries('rate-limit-1d');
    await expect(prisma.purgeSummary.update({ where: { id: s!.id }, data: { rows: 99 } })).rejects.toThrow(/append-only/);
    await expect(prisma.purgeSummary.delete({ where: { id: s!.id } })).rejects.toThrow(/append-only/);
    // And an empty batch writes none.
    expect(await purge('rate-limit-1d', rateLimitPurgeSql(nowFor(1), 500, run))).toBe(0);
    expect(await summaries('rate-limit-1d')).toHaveLength(1);
  });
});
