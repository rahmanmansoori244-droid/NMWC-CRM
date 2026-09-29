import { isDbConflict, isTransientDbError, mayHaveCommitted } from './db-errors';

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

/**
 * F15: a real session whose password must be changed first (AUTH-09). Thrown by
 * requireActor() in lib/session.ts for every server action and route handler
 * except the password change itself. A ForbiddenError, so every existing
 * `instanceof ForbiddenError` answers it with a 403; its own code lets a form
 * tell it from a role refusal.
 */
export class PasswordChangeRequiredError extends ForbiddenError {
  override readonly code = 'PASSWORD_CHANGE_REQUIRED';
  constructor() {
    super('You must change your password before continuing.');
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

/** A value as the customer edit form loaded it (lib/edit-values.ts BaseValue). */
type LiveValue = string | number | boolean | null;

export const STALE_FIELDS_MESSAGE =
  'Some details you changed were changed after you opened this form, so nothing was sent. Check the marked fields, then submit again.';

/**
 * Phase 2, F06: a customer edit named a field whose value changed after the
 * form was opened (services/edits.ts). Nothing was written. `fields` is keyed by
 * the form's slot (lib/edit-values.ts fieldSlotKey); `current` holds the value
 * live now, by raw path ('customer.contactPerson', 'branch.<id>.gpsLat'), so the
 * form can offer "Keep mine" and "Use this value" (ruling 1). It holds each
 * conflicting field of the sender's own patch, with additions he did not send
 * himself:
 *   - for a location or an equipment conflict, every column of that slot on the
 *     same branch (lib/edit-values.ts slotFields), because "Use this value" takes
 *     the group back as one — so a patch that changed only the coolers gets the
 *     stands, the bottles and "Counted" back too;
 *   - for a channel conflict, the sub-channel saved now, which the form's answer
 *     on the channel takes as the sub-channel's base. It is in `current` only:
 *     `fields` does not name it unless it is in conflict itself (post-merge
 *     review of phase 2, finding 2);
 *   - on a Steward's or Manager's direct write, the sub-channel the server clears
 *     itself when a channel change leaves one of the old channel.
 * All of it comes from the customer he may edit and from branches that passed
 * the route and region checks before planning. Worded neutrally (ruling 14): the
 * earlier write may have been his own.
 */
export class StaleFieldsError extends AppError {
  readonly current: Record<string, LiveValue>;
  constructor(fields: Record<string, string>, current: Record<string, LiveValue>) {
    super('STALE_FIELDS', STALE_FIELDS_MESSAGE, 409, fields);
    this.current = current;
  }
}

export const FORM_OUTDATED_MESSAGE =
  'This page was opened before an app update, so nothing was sent. Reload the page and submit again.';

/**
 * Phase 2: a customer edit body not in this build's format — a tab still running
 * the previous bundle, which sent every field it had loaded. Refused whole,
 * before its fields are read; the message is also the form-level error, so the
 * old form shows it where it shows any other.
 */
export class FormOutdatedError extends AppError {
  constructor() {
    super('FORM_OUTDATED', FORM_OUTDATED_MESSAGE, 409, { _form: FORM_OUTDATED_MESSAGE });
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
      /** STALE_FIELDS only: the value live now, by raw field path (StaleFieldsError). */
      current?: Record<string, LiveValue>;
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
        ...(err instanceof StaleFieldsError ? { current: err.current } : {}),
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
    // A deadlock or serialization failure (lib/db-errors.ts isDbConflict):
    // Postgres rolled the transaction back whole, so nothing was saved, and
    // running it again normally succeeds. The same code as an unanswered
    // database, so the field forms retry it the same way; its own words, because
    // the database did answer.
    if (isDbConflict(err, code ?? '')) {
      return {
        ok: false,
        code: 'DB_UNAVAILABLE',
        message:
          'Another change to the same records was being saved at the same moment, so this one was stopped. Nothing was saved — please try again.',
      };
    }
    // REL-06: a transient database fault is not a programmer error and it is
    // not the user's fault either. Re-throwing it produces a 500 and a generic
    // failure screen, which tells a salesman standing in a shop nothing about
    // whether to try again. The import path learned this already — transient
    // engine faults were once recorded as permanent row rejections — so the
    // same classifier is used here.
    if (isTransientDbError(err, code ?? '')) {
      // A connection or engine that died mid-request may have died after the
      // commit, so it must not promise that nothing was saved (item 22: telling
      // a salesman the opposite of what happened is the defect either way). The
      // field forms treat both codes as "no answer" and retry with the same
      // submission id, which finds out (lib/submit-client.ts).
      return mayHaveCommitted(err, code ?? '')
        ? {
            ok: false,
            code: 'DB_INTERRUPTED',
            message:
              'The connection to the database dropped mid-request, so this may or may not have been saved. Check before you try again.',
          }
        : {
            ok: false,
            code: 'DB_UNAVAILABLE',
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
