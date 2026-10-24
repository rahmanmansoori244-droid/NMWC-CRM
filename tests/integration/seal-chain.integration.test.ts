// @vitest-environment node
/**
 * Gap 28 on Postgres: the seal chain really detects a changed or deleted ledger
 * row, and the database refuses a seal that does not link.
 *
 * Everything runs inside ONE transaction on the owner connection that is always
 * rolled back, so no seal, ledger row or account it makes survives. It first
 * empties SealRecord inside that transaction (owner maintenance) so the chain it
 * checks is its own: on UAT the real chain is broken by every integration
 * clean-up, by design (docs/OPERATIONS.md section 5k).
 *
 *   RUN_WATCH=1 node scripts/qa/run-with-env.mjs vitest run tests/integration/seal-chain.integration.test.ts
 *
 * Written with the watch-and-prove branch; NOT run there (no database was used).
 */
import { describe, it, expect, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { writeSeal, type HorizonReader } from '@/lib/seal/seal';
import { recheckSeals } from '@/lib/seal/verify';
import { sealObjectKey } from '@/lib/seal/chain';
import { assertNotProductionEnv } from '../support/accountability-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });
const ENABLED = process.env.RUN_WATCH === '1' && !!process.env.DATABASE_URL;

class Rollback extends Error {}

/** A fixed horizon: every earlier transaction has ended. */
const clear: HorizonReader = async () => ({ xmin: 2n ** 40n, xmax: 2n ** 40n, currentXid: 2n ** 40n, oldBackends: async () => 0 });

describe.skipIf(!ENABLED)('gap 28: the seal chain on Postgres', () => {
  it('seals, verifies, and names a changed and a deleted row; refuses an unlinked seal; is append-only', async () => {
    assertNotProductionEnv();
    const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL!;
    if (url.includes('ep-sweet-haze')) throw new Error('ABORT: production');
    const owner = new PrismaClient({ datasourceUrl: url });
    const sfx = `zzw${Date.now().toString(36)}`;
    try {
      await owner
        .$transaction(
          async (tx) => {
            const asClient = { $transaction: async (fn: (t: Prisma.TransactionClient) => unknown) => fn(tx) } as never;
            const savepoint = async (name: string, fn: () => Promise<unknown>) => {
              await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
              try {
                await fn();
                return null;
              } catch (e) {
                await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
                return e as Error;
              }
            };
            // An empty chain of our own, and two ledger rows of our own.
            await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
            await tx.$executeRawUnsafe(`DELETE FROM "SealRecord"`);
            await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'off'`);
            const user = await tx.user.create({ data: { username: `${sfx}.u`, fullName: 'ZZ seal', role: 'VIEWER', passwordHash: 'x' } });
            for (const n of [1, 2]) {
              await tx.auditLog.create({ data: { actorId: user.id, action: 'UPDATE', entityType: 'ZZSeal', entityId: `${sfx}-${n}`, reason: 'zz seal' } });
            }

            const day1 = new Date('2026-11-01T02:30:00Z');
            const day2 = new Date('2026-11-02T02:30:00Z');
            expect((await writeSeal(asClient, { now: day1, job: 'integrity-watch', horizon: clear })).status).toBe('genesis');
            expect((await writeSeal(asClient, { now: day2, job: 'integrity-watch', horizon: clear })).status).toBe('sealed');
            expect((await recheckSeals(tx, { window: 'all', offsite: null })).mismatches).toEqual([]);
            // Each copy's key is the chain's (its genesis hash) and the seq, nothing else.
            const keyed = await tx.$queryRaw<Array<{ seq: number; hash: string; r2Key: string }>>`SELECT "seq", "hash", "r2Key" FROM "SealRecord" ORDER BY "seq"`;
            expect(keyed.map((k) => k.r2Key)).toEqual(keyed.map((k) => sealObjectKey(keyed[0]!.hash, k.seq)));

            // The database's own guard: a seal that does not link is refused.
            const [last] = await tx.$queryRaw<Array<{ seq: number; hash: string }>>`SELECT "seq", "hash" FROM "SealRecord" ORDER BY "seq" DESC LIMIT 1`;
            const forge = (seq: number, prev: string | null, body: string, hash?: string) =>
              tx.$executeRaw`INSERT INTO "SealRecord" ("seq", "day", "formatVersion", "prevHash", "hash", "bodyText", "r2Key", "snapshotXmax")
                             VALUES (${seq}, '2026-11-09'::date, 1, ${prev}::text,
                                     ${hash ?? null}::text, ${body}, 'seals/zz', 1)`;
            const bodyFor = (seq: number, prev: string | null) => JSON.stringify({ prev, seq });
            const sha = async (t: string) =>
              (await tx.$queryRaw<Array<{ h: string }>>`SELECT encode(sha256(convert_to(${t}, 'UTF8')), 'hex') AS h`)[0]!.h;
            const wrongPrev = bodyFor(last!.seq + 1, 'f'.repeat(64));
            expect((await savepoint('a', () => forge(last!.seq + 1, 'f'.repeat(64), wrongPrev, '0'.repeat(64))))?.message).toMatch(/not the SHA-256/);
            expect((await savepoint('b', async () => forge(last!.seq + 1, 'f'.repeat(64), wrongPrev, await sha(wrongPrev))))?.message).toMatch(
              /does not link to the last seal/
            );
            const skip = bodyFor(last!.seq + 2, last!.hash);
            expect((await savepoint('c', async () => forge(last!.seq + 2, last!.hash, skip, await sha(skip))))?.message).toMatch(
              /does not link to the last seal/
            );

            // A seal can be neither changed nor deleted outside the window.
            expect((await savepoint('d', () => tx.$executeRaw`UPDATE "SealRecord" SET "r2Key" = 'x' WHERE "seq" = 0`))?.message).toMatch(/append-only/);
            expect((await savepoint('e', () => tx.$executeRaw`DELETE FROM "SealRecord" WHERE "seq" = 0`))?.message).toMatch(/append-only/);

            // The owner edits a sealed row in the window: the chain names it.
            await tx.$executeRawUnsafe(`SET LOCAL nmwc.audit_maintenance = 'on'`);
            await tx.$executeRaw`UPDATE "AuditLog" SET "reason" = 'zz tampered' WHERE "entityId" = ${`${sfx}-1`}`;
            const changed = (await recheckSeals(tx, { window: 'all', offsite: null })).mismatches;
            expect(changed[0]).toMatchObject({ kind: 'rows-changed', seq: 1, table: 'AuditLog' });

            await tx.$executeRaw`DELETE FROM "AuditLog" WHERE "entityId" = ${`${sfx}-2`}`;
            const deleted = (await recheckSeals(tx, { window: 'all', offsite: null })).mismatches;
            expect(deleted.map((m) => m.kind)).toContain('rows-deleted');
            throw new Rollback();
          },
          { timeout: 170_000, maxWait: 20_000 }
        )
        .catch((e: unknown) => {
          if (!(e instanceof Rollback)) throw e;
        });
    } finally {
      await owner.$disconnect();
    }
  });
});
