// @vitest-environment node
/**
 * Gap 22 (data audit 2026-10-10): the losing side of two saves at once.
 *
 *   - runAction records a ConflictError or StaleFieldsError that carries
 *     ConflictMeta through the registered recorder, then answers exactly as
 *     before; without meta, or without a recorder (the browser, unit tests), it
 *     records nothing; a recorder that fails or hangs never changes the answer.
 *   - recordConflict (lib/conflict-record.ts) writes one CONFLICT audit row in a
 *     transaction of its own, under the loser's name and a conflict:<path>:<id>
 *     source, beside what the winner left on a request.
 *   - the row's shape (lib/conflict-row.ts): field names, never values.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  ConflictError,
  CONFLICT_RECORD_BUDGET_MS,
  StaleFieldsError,
  ValidationError,
  registerConflictRecorder,
  runAction,
  type ConflictMeta,
} from '@/lib/errors';
import { conflictAfter, conflictReason } from '@/lib/conflict-row';

const h = vi.hoisted(() => ({
  audits: [] as Array<{ env: unknown; row: Record<string, unknown> }>,
  contexts: [] as Array<{ actorId: string | null; source: string }>,
  liveEdit: null as null | Record<string, unknown>,
  fail: false,
}));

vi.mock('@/lib/db', () => ({ prisma: { tag: 'prisma' } }));
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/audit', () => ({
  getAuditEnvelope: async (actorId: string) => ({ actorId, ip: '198.18.0.1', userAgent: 'UnitTest' }),
  writeAudit: async (_tx: unknown, env: unknown, row: Record<string, unknown>) => {
    if (h.fail) throw new Error('database down');
    h.audits.push({ env, row });
  },
}));
vi.mock('@/lib/change-context', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/change-context')>();
  return {
    ...real,
    withChangeContext: async (
      _client: unknown,
      ctx: { actorId: string | null; source: string },
      fn: (tx: unknown) => Promise<unknown>
    ) => {
      real.changeContextParams(ctx);
      h.contexts.push(ctx);
      return fn({ customerEdit: { findUnique: async () => h.liveEdit } });
    },
  };
});

import { recordConflict } from '@/lib/conflict-record';

const meta: ConflictMeta = { actorId: 'u-loser', entityType: 'CustomerEdit', entityId: 'e-1', path: 'edit.approve', expectedVersion: 'cycle 1 step 0' };

beforeEach(() => {
  h.audits = [];
  h.contexts = [];
  h.liveEdit = null;
  h.fail = false;
});
afterEach(() => registerConflictRecorder(null));

describe('runAction and a lost race', () => {
  it('records once through the registered recorder, then answers exactly as before', async () => {
    const seen: unknown[] = [];
    registerConflictRecorder(async (err) => {
      seen.push(err.conflict);
    });
    const res = await runAction(async () => {
      throw new ConflictError('NOT_PENDING', 'This edit was just decided by another reviewer.', meta);
    });
    expect(res).toEqual({ ok: false, code: 'NOT_PENDING', message: 'This edit was just decided by another reviewer.' });
    expect(seen).toEqual([meta]);
  });

  it('a stale-fields refusal too, with its live values still answered', async () => {
    const seen: unknown[] = [];
    registerConflictRecorder(async (err) => {
      seen.push(err.code);
    });
    const res = await runAction(async () => {
      throw new StaleFieldsError({ 'customer.contactPerson': 'changed' }, { 'customer.contactPerson': 'Ali' }, { ...meta, entityType: 'Customer', fields: ['customer.contactPerson'] });
    });
    expect(res).toMatchObject({ ok: false, code: 'STALE_FIELDS', current: { 'customer.contactPerson': 'Ali' } });
    expect(seen).toEqual(['STALE_FIELDS']);
  });

  it('records nothing for a refusal without meta, another kind of error, or with no recorder', async () => {
    const seen: unknown[] = [];
    registerConflictRecorder(async (err) => {
      seen.push(err.code);
    });
    await runAction(async () => {
      throw new ConflictError('WRONG_LANE', 'Decided elsewhere.');
    });
    await runAction(async () => {
      throw new ValidationError({ x: 'bad' });
    });
    expect(seen).toEqual([]);
    registerConflictRecorder(null);
    const res = await runAction(async () => {
      throw new ConflictError('NOT_PENDING', 'gone', meta);
    });
    expect(res).toMatchObject({ ok: false, code: 'NOT_PENDING' });
  });

  it('a recorder that throws or hangs never changes the answer', async () => {
    registerConflictRecorder(async () => {
      throw new Error('boom');
    });
    expect(
      await runAction(async () => {
        throw new ConflictError('NOT_PENDING', 'gone', meta);
      })
    ).toMatchObject({ ok: false, code: 'NOT_PENDING', message: 'gone' });

    vi.useFakeTimers();
    try {
      registerConflictRecorder(() => new Promise<void>(() => {}));
      const pending = runAction(async () => {
        throw new ConflictError('NOT_PENDING', 'gone', meta);
      });
      await vi.advanceTimersByTimeAsync(CONFLICT_RECORD_BUDGET_MS + 1);
      expect(await pending).toMatchObject({ ok: false, code: 'NOT_PENDING' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('recordConflict: one CONFLICT row, in its own transaction', () => {
  it('under the loser’s name and a conflict source, beside what the winner left', async () => {
    h.liveEdit = { state: 'APPROVED', currentStepIndex: 0, cycle: 1, reviewedById: 'u-winner', reviewedAt: new Date('2026-10-12T05:00:00Z') };
    const err = new ConflictError('NOT_PENDING', 'This edit was just decided by another reviewer.', meta);
    await recordConflict(err as ConflictError & { conflict: ConflictMeta });
    expect(h.contexts).toEqual([{ actorId: 'u-loser', source: 'conflict:edit.approve:e-1' }]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]!.env).toMatchObject({ actorId: 'u-loser' });
    expect(h.audits[0]!.row).toEqual({
      action: 'CONFLICT',
      entityType: 'CustomerEdit',
      entityId: 'e-1',
      reason: 'NOT_PENDING: edit.approve',
      after: {
        code: 'NOT_PENDING',
        path: 'edit.approve',
        message: 'This edit was just decided by another reviewer.',
        expectedVersion: 'cycle 1 step 0',
        live: { state: 'APPROVED', currentStepIndex: 0, cycle: 1, reviewedById: 'u-winner', reviewedAt: '2026-10-12T05:00:00.000Z' },
      },
    });
  });

  it('a failure to write is logged and swallowed', async () => {
    h.fail = true;
    const err = new ConflictError('VERSION_CONFLICT', 'moved', { ...meta, entityType: 'Customer' });
    await expect(recordConflict(err as ConflictError & { conflict: ConflictMeta })).resolves.toBeUndefined();
  });
});

describe('the CONFLICT row’s shape', () => {
  it('names fields, never values, and keeps the shown sentence short', () => {
    const after = conflictAfter(
      { code: 'STALE_FIELDS', message: 'x'.repeat(500) },
      { actorId: 'u', entityType: 'Customer', entityId: 'c', path: 'edit.submit', fields: ['customer.primaryPhone'] },
      null
    );
    expect(after).toEqual({ code: 'STALE_FIELDS', path: 'edit.submit', message: 'x'.repeat(300), fields: ['customer.primaryPhone'] });
    expect(conflictReason('PHOTO_CHANGED', { actorId: 'u', entityType: 'Attachment', entityId: 'a', path: 'photo.detach' })).toBe(
      'PHOTO_CHANGED: photo.detach'
    );
  });
});
