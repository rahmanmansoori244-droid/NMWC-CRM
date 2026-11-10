// @vitest-environment node
/**
 * Review of the Prisma 7 upgrade, 2026-11-10: a failure of COMMIT itself.
 *
 * Prisma 7 turns the driver adapter's error into a coded one for a statement and
 * for BEGIN, but not for COMMIT: the caller of $transaction gets the adapter's
 * own error — no Prisma code, no meta, a message that is only the kind's name.
 * Nothing in lib/db-errors.ts read it, so a connection reset while COMMIT was on
 * the wire — the one moment where it is unknown whether the save landed (item
 * 22) — was re-thrown by runAction as a programmer error (a 500), the account
 * import recorded "nothing was written … (DriverAdapterError)", and the customer
 * import marked the group REJECTED "promote failed (UNKNOWN)" with a write that
 * overwrote PROMOTED when the commit had landed. A deadlock, a serialization
 * failure or a unique violation raised at COMMIT (the deferred constraint
 * trigger managerregions_history_capture runs there) was a 500 instead of the
 * answer the same fault gets on a statement.
 *
 * These cases are produced by the installed client and adapter themselves, over
 * a pool that opens no socket (tests/support/fake-pg-pool.ts): the errors below
 * are the runtime's, not shapes written by hand. The same shapes written by hand
 * sit in prisma7-error-shapes.test.ts.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '@prisma/client';
import { ARRAY_TX_LIMITS, withChangeContext } from '@/lib/change-context';
import { dbErrorCode, isDbConflict, isTransientDbError, mayHaveCommitted, sqlStateOf, uniqueTargetFields } from '@/lib/db-errors';
import { runAction } from '@/lib/errors';
import { accountRowFailure } from '@/lib/account-import';
import { isSealRace } from '@/lib/seal/seal';
import { describeError } from '../../scripts/ops/describe-error';
import { fakeClient, serverError, socketError } from '../support/fake-pg-pool';
import { stripComments } from '../support/strip-comments';

const CTX = { actorId: null, source: 'test:commit-errors' };
const clients: PrismaClient[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.$disconnect()));
});

type Form = 'interactive' | 'array';
type Seen = { err: unknown; answer: { ok: boolean; code?: string; message?: string } | 'RETHROWN'; wire: string[] };

/** One write transaction whose statement matching `failOn` fails with `fault`, through runAction. */
async function run(form: Form, failOn: RegExp, fault: () => Error): Promise<Seen> {
  const { prisma, wire } = fakeClient({
    onQuery: (sql) => {
      if (failOn.test(sql)) throw fault();
    },
  });
  clients.push(prisma);
  let err: unknown;
  let answer: Seen['answer'];
  try {
    answer = await runAction(async () => {
      try {
        if (form === 'array') {
          return await prisma.$transaction(
            [prisma.$executeRaw`SELECT 1`, prisma.$executeRaw`UPDATE "User" SET "fullName" = "fullName" WHERE false`],
            ARRAY_TX_LIMITS
          );
        }
        return await withChangeContext(prisma, CTX, async (tx) => {
          await tx.$executeRaw`UPDATE "User" SET "fullName" = "fullName" WHERE false`;
          return 'saved';
        });
      } catch (e) {
        err = e;
        throw e;
      }
    });
  } catch {
    answer = 'RETHROWN';
  }
  return { err, answer, wire };
}

const COMMIT = /^COMMIT/i;
const reset = () => socketError('ECONNRESET', -104);
const timedOut = () => socketError('ETIMEDOUT', -110);
const deadlock = () => serverError('40P01', 'deadlock detected');
const serialization = () => serverError('40001', 'could not serialize access due to concurrent update');
const clash = () =>
  serverError('23505', 'duplicate key value violates unique constraint "User_email_key"', {
    constraint: 'User_email_key',
    table: 'User',
    detail: 'Key (email)=(someone@example.com) already exists.',
  });

const INTERRUPTED = 'The connection to the database dropped mid-request, so this may or may not have been saved. Check before you try again.';
const CONFLICT = 'Another change to the same records was being saved at the same moment, so this one was stopped. Nothing was saved — please try again.';

describe.each(['interactive', 'array'] as const)('COMMIT fails — %s transaction', (form) => {
  it.each([
    ['the connection reset while COMMIT was on the wire (ECONNRESET)', reset],
    ['the socket timed out on COMMIT (ETIMEDOUT)', timedOut],
  ])('%s: "may or may not have been saved", never a 500 and never "nothing was saved"', async (_label, fault) => {
    const { err, answer, wire } = await run(form, COMMIT, fault);
    expect(wire.at(-1)).toBe('COMMIT');
    expect(answer).toEqual({ ok: false, code: 'DB_INTERRUPTED', message: INTERRUPTED });
    const code = dbErrorCode(err) ?? '';
    expect(isTransientDbError(err, code)).toBe(true);
    expect(mayHaveCommitted(err, code)).toBe(true);
    // The account import: said as uncertain, not as "nothing was written".
    expect(accountRowFailure(err, 'user a.b')).toEqual({
      transient: true,
      mayHaveCommitted: true,
      message:
        'the connection to the database dropped while user a.b was being saved, so it may or may not have been written. Check it in the CRM before importing this row again.',
    });
    // The customer import: the group is left for the next slice, not REJECTED —
    // whether it reads the code through dbErrorCode or passes its old placeholder.
    expect(isTransientDbError(err, dbErrorCode(err) ?? 'UNKNOWN')).toBe(true);
    expect(isTransientDbError(err, 'UNKNOWN')).toBe(true);
    expect(isSealRace(err)).toBe(false);
  });

  it.each([
    ['a deadlock (40P01)', deadlock, '40P01', false],
    ['a serialization failure (40001)', serialization, '40001', true],
  ])('%s raised at COMMIT: "please try again", as on a statement', async (_label, fault, sqlState, sealRace) => {
    const { err, answer, wire } = await run(form, COMMIT, fault);
    expect(wire.at(-1)).toBe('COMMIT');
    expect(answer).toEqual({ ok: false, code: 'DB_UNAVAILABLE', message: CONFLICT });
    const code = dbErrorCode(err) ?? '';
    expect(sqlStateOf(err)).toBe(sqlState);
    expect(isDbConflict(err, code)).toBe(true);
    expect(isDbConflict(err, 'UNKNOWN')).toBe(true);
    expect(isTransientDbError(err, code)).toBe(true);
    // Postgres answered: the transaction rolled back whole.
    expect(mayHaveCommitted(err, code)).toBe(false);
    expect(accountRowFailure(err, 'user a.b')).toMatchObject({ transient: true, mayHaveCommitted: false });
    // The seal's retry: a serialization failure is a lost race, a deadlock is not.
    expect(isSealRace(err)).toBe(sealRace);
  });

  it('a unique violation raised at COMMIT is the generic conflict, with its columns, never an outage', async () => {
    const { err, answer, wire } = await run(form, COMMIT, clash);
    expect(wire.at(-1)).toBe('COMMIT');
    expect(answer).toEqual({
      ok: false,
      code: 'UNIQUE_CONSTRAINT',
      message: 'This value conflicts with an existing record. Refresh and try again.',
    });
    const code = dbErrorCode(err) ?? '';
    expect(code).toBe('P2002');
    expect(sqlStateOf(err)).toBe('23505');
    expect(uniqueTargetFields(err)).toEqual(['email']);
    expect(isTransientDbError(err, code)).toBe(false);
    expect(mayHaveCommitted(err, code)).toBe(false);
    const row = accountRowFailure(err, 'user a.b');
    expect(row).toEqual({
      transient: false,
      mayHaveCommitted: false,
      message: 'nothing was written for user a.b: its email is already used by another record.',
    });
    // Never the value that clashed (Postgres's DETAIL quotes it).
    expect(row.message).not.toMatch(/someone@example\.com/);
    expect(isSealRace(err)).toBe(true);
  });

  it('what an operator script prints for it: the class, the kind and the SQLSTATE — no message', async () => {
    const lost = await run(form, COMMIT, reset);
    expect(describeError(lost.err)).toMatch(/^(DriverAdapterError ConnectionClosed|PrismaClientKnownRequestError P1017)$/);
    const refused = await run(form, COMMIT, clash);
    expect(describeError(refused.err)).toMatch(/^(DriverAdapterError UniqueConstraintViolation 23505|PrismaClientKnownRequestError P2002 23505)$/);
    expect(describeError(refused.err)).not.toMatch(/example|email/);
  });
});

describe('the same faults where Prisma does code them: answered the same', () => {
  it('a reset on a statement inside the transaction, and on BEGIN', async () => {
    for (const failOn of [/^UPDATE/i, /^BEGIN/i]) {
      const { answer } = await run('interactive', failOn, reset);
      expect(answer).toEqual({ ok: false, code: 'DB_INTERRUPTED', message: INTERRUPTED });
    }
  });

  it('a deadlock on a statement inside the transaction', async () => {
    const { answer } = await run('interactive', /^UPDATE/i, deadlock);
    expect(answer).toEqual({ ok: false, code: 'DB_UNAVAILABLE', message: CONFLICT });
  });

  it('a clean close at COMMIT (node-postgres\'s own "Connection terminated unexpectedly")', async () => {
    const { answer } = await run('interactive', COMMIT, () => new Error('Connection terminated unexpectedly'));
    expect(answer).toEqual({ ok: false, code: 'DB_INTERRUPTED', message: INTERRUPTED });
  });

  it('an error the database raised at COMMIT that is none of these is still a programmer error', async () => {
    const { err, answer } = await run('interactive', COMMIT, () => serverError('P0001', 'nmwc: an effective time may not be in the future'));
    expect(answer).toBe('RETHROWN');
    expect(isTransientDbError(err, dbErrorCode(err) ?? '')).toBe(false);
  });
});

describe('the shape itself, on the installed Prisma', () => {
  /**
   * When this fails after a Prisma upgrade while every case above still passes,
   * Prisma has started coding COMMIT's errors: update this pin, and keep the
   * bare-error reading in lib/db-errors.ts until no supported version needs it.
   */
  it('COMMIT\'s error reaches the application as the adapter\'s own: no code, no meta, the kind for a message', async () => {
    const { err } = await run('interactive', COMMIT, reset);
    const e = err as { name?: unknown; code?: unknown; meta?: unknown; message?: unknown; cause?: { kind?: unknown } };
    expect({ name: e.name, code: e.code, meta: e.meta, message: e.message, kind: e.cause?.kind }).toEqual({
      name: 'DriverAdapterError',
      code: undefined,
      meta: undefined,
      message: 'ConnectionClosed',
      kind: 'ConnectionClosed',
    });
  });
});

describe('the customer import never turns a promoted group back into REJECTED rows', () => {
  it('the write that records a failed group touches only rows still CLEAN', () => {
    const src = stripComments(readFileSync('services/imports.ts', 'utf8'));
    const end = src.indexOf("'import.mark_failed'");
    expect(end).toBeGreaterThan(0);
    const start = src.lastIndexOf('prisma.importRow.updateMany(', end);
    const write = src.slice(start, end);
    expect(write).toContain('state: ImportRowState.REJECTED');
    expect(write).toMatch(/where:\s*\{\s*id:\s*\{\s*in:\s*g\.rowIds\s*\},\s*state:\s*ImportRowState\.CLEAN\s*\}/);
  });
});
