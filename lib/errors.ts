import { isTransientDbError } from './db-errors';

export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly fields?: Record<string, string>;

  constructor(code: string, message: string, httpStatus = 500, fields?: Record<string, string>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.fields = fields;
  }
}

export class ValidationError extends AppError {
  constructor(fields: Record<string, string>, message = 'Validation failed') {
    super('VALIDATION_FAILED', message, 400, fields);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super('FORBIDDEN', message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message, 409);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message, 429);
  }
}

// ── Server Action error contract ──────────────────────────────────────────
//
// PROD-006 / SC-RENDER-OMITTED: when an `AppError` (ConflictError /
// ValidationError / ForbiddenError / NotFoundError / RateLimitError) is
// thrown FROM a server action, Next.js's React Server Components
// serialization layer strips the `.message` and `.code` in production
// builds and replaces it with a generic
// "An error occurred in the Server Components render. The specific message
// is omitted in production builds…" stub. The form's `catch` block then
// has no way to surface the actionable error to the user.
//
// Fix: server actions never throw `AppError`s across the SC boundary.
// Instead they wrap their core logic in `runAction(() => …)` which
// converts a thrown `AppError` into a returned `{ ok: false, code, message,
// fields? }` payload. Forms read the discriminated union and either show
// inline field errors (`fields`) or the form-level `message`.
//
// Genuine programmer errors (TypeError, Prisma client crashes that aren't
// `P2002`, etc.) still throw — those should NEVER reach the user, and
// Next.js / Sentry can surface them as 500s.
//
// Critical lessons (live-tested 2026-05-10 on /approvals/[id]):
//   - `throw new ConflictError('STATUS_BYPASS', '…')` turned into
//     "An error occurred in the Server Components render…" on the live
//     site. The fix below converts that to a returned shape that the
//     form can render inline.

/** Discriminated union returned by every wrapped server action. */
export type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      /**
       * Stable machine-readable code from the AppError subclass:
       *   - VALIDATION_FAILED, FORBIDDEN, NOT_FOUND, RATE_LIMITED
       *   - or a custom ConflictError code (e.g. STATUS_BYPASS, EDIT_LOCKED)
       */
      code: string;
      /** Human-readable message safe to render verbatim in the UI. */
      message: string;
      /** Field-level errors when code === 'VALIDATION_FAILED'. */
      fields?: Record<string, string>;
    };

/**
 * Wrap a server-action core in this helper. Known `AppError` subclasses are
 * caught and converted to `{ ok: false, ... }`. Everything else re-throws so
 * Next.js can render the 500 page (or so the framework can perform a
 * NEXT_REDIRECT). Use the returned shape from the form's catch-free flow:
 *
 * ```ts
 * export async function approveEditAction(fd: FormData) {
 *   return runAction(() => approveEditCore(fd));
 * }
 * ```
 *
 * In the form:
 *
 * ```tsx
 * const res = await approveEditAction(fd);
 * if (!res.ok) setErrors({ _form: res.message });
 * else router.push(...);
 * ```
 *
 * The form must NOT use `try/catch` for AppError handling on the new shape
 * — the action no longer throws those.
 */
export async function runAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { ok: true, data };
  } catch (err) {
    // NEXT_REDIRECT / NEXT_NOT_FOUND must bubble. They're framework signals.
    if (
      err &&
      typeof err === 'object' &&
      'digest' in err &&
      typeof (err as { digest?: unknown }).digest === 'string' &&
      ((err as { digest: string }).digest.startsWith('NEXT_REDIRECT') ||
        (err as { digest: string }).digest === 'NEXT_NOT_FOUND')
    ) {
      throw err;
    }
    if (err instanceof AppError) {
      return {
        ok: false,
        code: err.code,
        message: err.message,
        ...(err.fields ? { fields: err.fields } : {}),
      };
    }
    // Special-case Prisma P2002 unique-constraint as a generic conflict so
    // a forgotten-to-translate Prisma error doesn't blow up as a 500. Caller
    // should still translate to a friendly ConflictError where it matters.
    const code = (err as { code?: string })?.code;
    if (code === 'P2002') {
      return {
        ok: false,
        code: 'UNIQUE_CONSTRAINT',
        message:
          'This value conflicts with an existing record. Refresh and try again.',
      };
    }
    // REL-06: a transient database fault is not a programmer error and it is
    // not the user's fault either. Re-throwing it produces a 500 and a generic
    // failure screen, which tells a salesman standing in a shop nothing about
    // whether to try again. The import path learned this already — transient
    // engine faults were once recorded as permanent row rejections — so the
    // same classifier is used here.
    if (isTransientDbError(err, code ?? '')) {
      return {
        ok: false,
        code: code === 'P1017' ? 'DB_INTERRUPTED' : 'DB_UNAVAILABLE',
        message:
          'The database did not respond in time. Nothing was saved — please try again in a moment.',
      };
    }
    // Genuine programmer error: re-throw so Next.js / Sentry can capture.
    throw err;
  }
}

/**
 * Convenience type-helper for action signatures, e.g.:
 *   `export async function fooAction(fd: FormData): SafeAction<{ id: string }> { … }`
 */
export type SafeAction<T = void> = Promise<ActionResult<T>>;
