/**
 * REL-06: a transient database fault is not a user error.
 *
 * The import path learned this the expensive way — transient engine faults were
 * once recorded as permanent row REJECTIONS, so infrastructure noise silently
 * dropped good customers while the batch finished green. The same classifier
 * now decides what a server action tells the user, so it is tested on its own.
 */
import { describe, it, expect } from 'vitest';
import { isTransientDbError, TRANSIENT_DB_CODES } from '@/lib/db-errors';
import { runAction } from '@/lib/errors';

describe('isTransientDbError', () => {
  it('recognises every Prisma code that means the database was unavailable', () => {
    for (const code of TRANSIENT_DB_CODES) {
      expect(isTransientDbError({ code }, code), code).toBe(true);
    }
  });

  it('recognises engine faults that arrive with no Prisma code at all', () => {
    const messages = [
      'Response from the Engine was empty',
      'Server has closed the connection',
      'Timed out fetching a new connection from the connection pool',
      "Can't reach database server at ep-example.neon.tech:5432",
    ];
    for (const m of messages) {
      expect(isTransientDbError(new Error(m), ''), m).toBe(true);
    }
  });

  it('does not mistake a data problem for an outage', () => {
    // A unique-constraint violation is the user's problem and must stay one.
    expect(isTransientDbError({ code: 'P2002' }, 'P2002')).toBe(false);
    expect(isTransientDbError(new Error('Invalid phone number'), '')).toBe(false);
    expect(isTransientDbError(new TypeError('x is not a function'), '')).toBe(false);
    expect(isTransientDbError(null, '')).toBe(false);
  });
});

describe('runAction maps transient faults to a retryable answer', () => {
  it('turns a transaction timeout into DB_UNAVAILABLE rather than a 500', async () => {
    const res = await runAction(async () => {
      throw Object.assign(new Error('Transaction already closed'), { code: 'P2028' });
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('DB_UNAVAILABLE');
    // The message has to tell a salesman standing in a shop what to do next.
    expect(res.message).toMatch(/try again/i);
    expect(res.message).toMatch(/nothing was saved/i);
  });

  it('distinguishes a dropped connection, which may have committed', async () => {
    const res = await runAction(async () => {
      throw Object.assign(new Error('connection closed'), { code: 'P1017' });
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('DB_INTERRUPTED');
    // So it must not tell anyone that nothing was saved (item 22).
    expect(res.message).not.toMatch(/nothing was saved/i);
    expect(res.message).toMatch(/may or may not have been saved/i);
  });

  it('classifies an engine fault with no code — by whether it can come after the commit', async () => {
    const answer = async (message: string) => {
      const res = await runAction(async () => {
        throw new Error(message);
      });
      if (res.ok) throw new Error('expected a failure');
      return res;
    };
    // A killed engine or a closed connection may have died after the commit
    // (item 22): interrupted, and no promise that nothing was saved.
    for (const m of ['Response from the Engine was empty', 'Server has closed the connection']) {
      const res = await answer(m);
      expect(res.code, m).toBe('DB_INTERRUPTED');
      expect(res.message, m).not.toMatch(/nothing was saved/i);
    }
    // Never reached, or never got a connection: nothing could have been written.
    for (const m of [
      "Can't reach database server at ep-example.neon.tech:5432",
      'Timed out fetching a new connection from the connection pool',
    ]) {
      const res = await answer(m);
      expect(res.code, m).toBe('DB_UNAVAILABLE');
      expect(res.message, m).toMatch(/nothing was saved/i);
    }
  });

  it('still re-throws a genuine programmer error', async () => {
    await expect(
      runAction(async () => {
        throw new TypeError('someUndefined is not a function');
      })
    ).rejects.toThrow(TypeError);
  });

  it('leaves the unique-constraint contract alone', async () => {
    const res = await runAction(async () => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('UNIQUE_CONSTRAINT');
  });
});
