import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  runAction,
} from '@/lib/errors';

/**
 * Server-action error contract — see lib/errors.ts.
 *
 * The Next.js Server Components serialization layer strips `Error.message`
 * in production builds and replaces it with "An error occurred in the
 * Server Components render. The specific message is omitted in production
 * builds…". `runAction()` works around this by converting AppError throws
 * into a returned `ActionResult` shape that survives the SC boundary.
 */
describe('runAction — server-action error contract (PROD-006)', () => {
  it('returns { ok: true, data } for a successful action', async () => {
    const res = await runAction(async () => ({ editId: 'e1', state: 'APPROVED' as const }));
    expect(res).toEqual({
      ok: true,
      data: { editId: 'e1', state: 'APPROVED' },
    });
  });

  it('returns { ok: false, code, message } for a ConflictError (EL-01 STATUS_BYPASS case)', async () => {
    // The exact case live-tested 2026-05-10 on /approvals/[id]:
    // approveEditAction throws ConflictError('STATUS_BYPASS', '...') and the
    // form must render the actionable message inline rather than a generic
    // "An error occurred in the Server Components render…" stub.
    const res = await runAction(async () => {
      throw new ConflictError(
        'STATUS_BYPASS',
        'This edit changes customer.status — that route is forbidden. Use the close-shop or reactivation action.'
      );
    });
    expect(res).toEqual({
      ok: false,
      code: 'STATUS_BYPASS',
      message:
        'This edit changes customer.status — that route is forbidden. Use the close-shop or reactivation action.',
    });
  });

  it('returns { ok: false, code: VALIDATION_FAILED, fields } for a ValidationError', async () => {
    // Field-level errors (mandatory-field gate, password-too-short, etc.)
    // round-trip the `fields` map so the form renders inline next to the
    // offending input instead of as a single _form-level error.
    const res = await runAction(async () => {
      throw new ValidationError({
        'customer.legalName': 'Legal name is required.',
        'branch.b1.shopPhoto': 'Branch B1: shop photo is required.',
      });
    });
    expect(res.ok).toBe(false);
    if (res.ok) return; // narrow
    expect(res.code).toBe('VALIDATION_FAILED');
    expect(res.message).toBe('Validation failed');
    expect(res.fields).toEqual({
      'customer.legalName': 'Legal name is required.',
      'branch.b1.shopPhoto': 'Branch B1: shop photo is required.',
    });
  });

  it('returns { ok: false, code: FORBIDDEN } for ForbiddenError', async () => {
    const res = await runAction(async () => {
      throw new ForbiddenError('You are not authorized to approve this edit.');
    });
    expect(res).toEqual({
      ok: false,
      code: 'FORBIDDEN',
      message: 'You are not authorized to approve this edit.',
    });
  });

  it('returns { ok: false, code: NOT_FOUND } for NotFoundError', async () => {
    const res = await runAction(async () => {
      throw new NotFoundError('Customer not found.');
    });
    expect(res).toEqual({
      ok: false,
      code: 'NOT_FOUND',
      message: 'Customer not found.',
    });
  });

  it('returns { ok: false, code: RATE_LIMITED } for RateLimitError', async () => {
    const res = await runAction(async () => {
      throw new RateLimitError('Slow down — try again in 30s.');
    });
    expect(res).toEqual({
      ok: false,
      code: 'RATE_LIMITED',
      message: 'Slow down — try again in 30s.',
    });
  });

  it('translates a Prisma P2002 unique-constraint failure to UNIQUE_CONSTRAINT', async () => {
    // QA-017 / EL-09: when a service forgets to wrap a P2002 in a friendly
    // ConflictError (or the unique index races a write), runAction surfaces
    // a generic message instead of a 500.
    const res = await runAction(async () => {
      const e = new Error('Unique constraint failed on the fields: (`username`)');
      (e as unknown as { code: string }).code = 'P2002';
      throw e;
    });
    expect(res).toEqual({
      ok: false,
      code: 'UNIQUE_CONSTRAINT',
      message: 'This value conflicts with an existing record. Refresh and try again.',
    });
  });

  it('re-throws genuine programmer errors (TypeError, etc.) so Next.js / Sentry can capture them', async () => {
    await expect(
      runAction(async () => {
        // Simulating a real programmer bug — a forgotten null guard.
        // We do NOT want this swallowed silently; it must reach Sentry.
        const obj: { foo?: { bar: string } } = {};
        return obj.foo!.bar;
      })
    ).rejects.toThrow();
  });

  it('re-throws NEXT_REDIRECT framework signals so Next.js performs the redirect', async () => {
    // Server actions sometimes call `redirect()` which throws a synthetic
    // error with `digest: 'NEXT_REDIRECT;...'`. runAction must NOT swallow
    // these — the redirect mechanism depends on the throw bubbling out.
    const redirect = Object.assign(new Error('NEXT_REDIRECT'), {
      digest: 'NEXT_REDIRECT;replace;/login;307',
    });
    await expect(
      runAction(async () => {
        throw redirect;
      })
    ).rejects.toBe(redirect);
  });

  it('re-throws NEXT_NOT_FOUND framework signals', async () => {
    const notFound = Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_NOT_FOUND' });
    await expect(
      runAction(async () => {
        throw notFound;
      })
    ).rejects.toBe(notFound);
  });

  it('preserves AppError.code on custom subclasses (e.g. ConflictError NEEDS_REUPLOAD)', async () => {
    // EL-04: when supervisor approves a salesman edit and photos got
    // detached between submit and approve, the action raises
    // ConflictError('NEEDS_REUPLOAD', '...'). The form must surface the
    // friendly message and the audit screen wants the stable code.
    const res = await runAction(async () => {
      throw new ConflictError(
        'NEEDS_REUPLOAD',
        'Required fields are now missing on this customer (2 missing). Reject the edit so the salesman can refill: branch.B1.shopPhoto · customer.crPhoto'
      );
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('NEEDS_REUPLOAD');
    expect(res.message).toContain('Required fields are now missing');
  });
});

describe('AppError subclasses — code + httpStatus invariants', () => {
  it('every AppError carries a stable code and httpStatus', () => {
    const cases: Array<[AppError, string, number]> = [
      [new ValidationError({ a: 'b' }), 'VALIDATION_FAILED', 400],
      [new ForbiddenError(), 'FORBIDDEN', 403],
      [new NotFoundError(), 'NOT_FOUND', 404],
      [new ConflictError('STATUS_BYPASS', 'hi'), 'STATUS_BYPASS', 409],
      [new RateLimitError(), 'RATE_LIMITED', 429],
    ];
    for (const [err, code, status] of cases) {
      expect(err.code).toBe(code);
      expect(err.httpStatus).toBe(status);
    }
  });
});
