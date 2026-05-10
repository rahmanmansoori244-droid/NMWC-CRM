# Server Action Error Contract — PROD-006

**Status:** Implemented 2026-05-10
**Owner:** all `services/*.ts`, `app/(app)/**/*.tsx` form components
**Related issues:** EL-01 (STATUS_BYPASS message lost), F-03 (per-row imports
swallow), QA-017 / EL-09 (Prisma P2002 leaks as 500)

## Problem

Throwing a custom `AppError` subclass (`ConflictError`, `ValidationError`,
`ForbiddenError`, `NotFoundError`, `RateLimitError`) **from a server action**
does not propagate the message to the client in production builds.

Next.js's React Server Components serialization strips `Error.message` and
replaces the throw with a generic stub:

> An error occurred in the Server Components render. The specific message is
> omitted in production builds to avoid leaking sensitive details.

The form's `catch` block then has no way to surface the actionable text to
the user.

### Live evidence (2026-05-10)

| Path | Action | Expected message | What user saw |
|------|--------|------------------|---------------|
| `/approvals/[id]` | `approveEditAction` (`STATUS_BYPASS`) | "This edit changes customer.status — that route is forbidden. Use the close-shop or reactivation action." | "An error occurred in the Server Components render…" |
| `/customers/[id]/edit` | `submitEditAction` (mandatory-fields) | "Legal name is required." inline | Same generic stub |
| `/import/[batchId]` | `promoteCustomerBatchAction` (per-row failure) | "duplicate phone, cr_no" | Whole batch aborted with generic stub |

## Decision

**Option (b): wrap, don't redesign.** A higher-order `runAction(fn)` helper
catches `AppError` subclasses and converts them to a returned discriminated
union. The action's existing `throw` flow is untouched — only the public
entry point is wrapped.

The alternative (option (a) — make every action `return { ok: false, … }`
explicitly throughout the body) would require touching every guard clause
and every Zod failure path. With ~25 entry points across 6 service files
and ~50 throw sites, the wrapper approach is a 10-line change per action,
not a rewrite.

## Contract

```ts
type ActionResult<T = void> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: string;          // VALIDATION_FAILED, FORBIDDEN, NOT_FOUND,
                             // RATE_LIMITED, STATUS_BYPASS, EDIT_LOCKED,
                             // NEEDS_REUPLOAD, DUPLICATE_PHONE,
                             // UNIQUE_CONSTRAINT, NOT_PENDING, …
      message: string;       // human-readable, safe to render verbatim
      fields?: Record<string, string>;  // present iff code === 'VALIDATION_FAILED'
    };

type SafeAction<T = void> = Promise<ActionResult<T>>;
```

Every refactored action takes the form:

```ts
// public entry — wrapped
export async function approveEditAction(formData: FormData): SafeAction<void> {
  return runAction(() => approveEditCore(formData));
}

// inner core — keeps existing throw style
async function approveEditCore(formData: FormData) {
  // …everything that was already there, including throw new ConflictError(…)
}
```

Forms read the union without `try/catch` for the normal-error path:

```tsx
const res = await approveEditAction(fd);
if (!res.ok) {
  if (res.fields) setErrors(res.fields);
  else setErrors({ _form: res.message });
  return;
}
router.push('/approvals');
```

`try/catch` is only kept for **genuine 500s** (programmer bugs, network
crashes) — those still throw.

## What `runAction` does NOT swallow

1. **Programmer errors** (`TypeError`, `null` deref, etc.) — re-thrown so
   Sentry / Next.js error boundary captures them.
2. **`NEXT_REDIRECT` / `NEXT_NOT_FOUND` framework signals** — re-thrown so
   `redirect()` / `notFound()` keep working.
3. **Prisma `P2002` unique-constraint** — converted to a generic
   `{ code: 'UNIQUE_CONSTRAINT' }` payload. Caller services SHOULD still
   translate to a friendly `ConflictError` ahead of `runAction` (e.g.,
   `ConflictError('EDIT_LOCKED', 'Another submission for this customer was
   just made…')`); the generic catch is a safety net only.

## Wrapped actions (audit grid)

| File | Action | Throws | Wrapped | Form caller(s) |
|------|--------|--------|---------|----------------|
| `services/edits.ts` | `submitEditAction` | ValidationError, ConflictError (EDIT_LOCKED), ForbiddenError, NotFoundError, RateLimitError | yes | `EnrichmentForm.tsx` |
| `services/edits.ts` | `approveEditAction` | ConflictError (STATUS_BYPASS, NOT_PENDING, NEEDS_REUPLOAD, DUPLICATE_PHONE), ForbiddenError, NotFoundError, ValidationError | yes | `ApproveRejectActions.tsx` |
| `services/edits.ts` | `rejectEditAction` | ValidationError, ConflictError (NOT_PENDING), ForbiddenError, NotFoundError | yes | `ApproveRejectActions.tsx` |
| `services/photos.ts` | `attachPhotoAction` | ValidationError, ForbiddenError, NotFoundError | yes | `PhotoCaptureSlot.tsx` (re-throws to onPicked's setError) |
| `services/photos.ts` | `detachPhotoAction` | ForbiddenError, NotFoundError | yes | `PhotoCaptureSlot.tsx` (best-effort) |
| `services/users.ts` | `createUserAction` | ValidationError, ForbiddenError | yes | `CreateUserForm.tsx` |
| `services/users.ts` | `toggleUserActiveAction` | ValidationError (last-Manager), ForbiddenError, NotFoundError | yes | `UserRowActions.tsx` |
| `services/users.ts` | `resetPasswordAction` | ValidationError, ForbiddenError, NotFoundError | yes | `UserRowActions.tsx` |
| `services/users.ts` | `updateUserRoleAction` | ValidationError, ForbiddenError, NotFoundError | yes | (no form — admin/CLI today) |
| `services/users.ts` | `changeOwnPasswordAction` | ValidationError ("Current password incorrect."), ForbiddenError | yes | `ChangePasswordForm.tsx` |
| `services/imports.ts` | `uploadAccountMasterAction` | ForbiddenError, ValidationError, RateLimitError | yes | `import/forms.tsx` (UploadAccountForm) |
| `services/imports.ts` | `uploadCustomerMasterAction` | ForbiddenError, ValidationError, RateLimitError | yes | `import/forms.tsx` (UploadCustomerForm) |
| `services/imports.ts` | `promoteCustomerBatchAction` | ForbiddenError, ValidationError | yes | `import/[batchId]/PromoteButton.tsx` |
| `services/duplicates.ts` | `mergeCustomersAction` | ForbiddenError, ValidationError (cross-region reason), NotFoundError | yes | `duplicates/MergeForm.tsx` |
| `services/duplicates.ts` | `dismissDuplicateAction` | ForbiddenError, ValidationError | yes | `duplicates/MergeForm.tsx` |
| `services/reactivations.ts` | `requestReactivationAction` | ValidationError (photo evidence), ForbiddenError, NotFoundError | yes | `BranchStatusActions.tsx` |
| `services/reactivations.ts` | `markBranchClosedAction` | ValidationError (photo evidence), ForbiddenError, NotFoundError | yes | `BranchStatusActions.tsx` |
| `services/reactivations.ts` | `approveReactivationAction` | ValidationError, ForbiddenError, NotFoundError | yes | `ReactivationDecisionForm.tsx` |
| `services/reactivations.ts` | `rejectReactivationAction` | ValidationError, ForbiddenError, NotFoundError | yes | `ReactivationDecisionForm.tsx` |

### Out of scope

| File | Action | Reason |
|------|--------|--------|
| `app/actions/auth.ts` | `loginAction` | Already returns `{ ok: false, error }` natively (matches the original `LoginResult` type). |
| `app/actions/auth.ts` | `logoutAction` | Always succeeds; redirects via `signOut`. |
| `services/exports.ts` | `buildCustomerExport` | Called from the API route handler `/api/exports/customers`, not a server action. Route handlers don't have the SC-omitted serialization issue — they catch and translate to `NextResponse.json({ error })` directly. |
| `services/duplicates.ts` | `findDuplicateCandidates` | Read-only data fetch — only `requireSteward()` can throw, and the caller is a server component that surfaces the error in a 500 boundary. |

## Updated callers

| Form / Component | Path | Notes |
|------------------|------|-------|
| `ApproveRejectActions.tsx` | `app/(app)/approvals/[id]/` | EL-01 fix. Reads `res.fields` for inline + `res.message` for `_form`. |
| `EnrichmentForm.tsx` | `app/(app)/customers/[id]/edit/` | Per-field mandatory errors render at each Field; `_form` for ConflictError. |
| `ChangePasswordForm.tsx` | `app/(app)/profile/change-password/` | "Current password incorrect." surfaces correctly. |
| `CreateUserForm.tsx` | `app/(app)/users/` | Full validation map + last-Manager guard surface. |
| `UserRowActions.tsx` | `app/(app)/users/` | toggle + reset both refactored. |
| `BranchStatusActions.tsx` | `components/nmwc/` | Photo-evidence errors (capturedAt < lastStatusChangeAt, >24h, wrong branch) surface. |
| `ReactivationDecisionForm.tsx` | `app/(app)/reactivations/` | Manager region scope errors surface. |
| `MergeForm.tsx` | `app/(app)/duplicates/` | Cross-region merge prompt + reason validation surface. |
| `PhotoCaptureSlot.tsx` | `components/nmwc/` | Attach errors throw inside `onPicked` so the slot's own `setError(error.message)` path picks them up — preserving the existing UX. |
| `import/forms.tsx` | `app/(app)/import/` | Upload errors (file size, formula payload, P2002) surface. |
| `PromoteButton.tsx` | `app/(app)/import/[batchId]/` | Not-READY-batch + per-row F-03 errors surface. |

## Tests

`tests/unit/errors.test.ts`:

- `runAction` returns `{ ok: true, data }` for success
- `runAction` returns `{ ok: false, code: 'STATUS_BYPASS', message }` for the
  exact ConflictError that triggered the audit
- `runAction` returns `{ ok: false, code: 'VALIDATION_FAILED', fields }` for a
  ValidationError with multi-field map
- `runAction` returns `{ ok: false, code }` for ForbiddenError, NotFoundError,
  RateLimitError
- `runAction` translates Prisma P2002 to `{ code: 'UNIQUE_CONSTRAINT' }`
- `runAction` re-throws programmer errors (TypeError-equivalent)
- `runAction` re-throws `NEXT_REDIRECT` / `NEXT_NOT_FOUND` framework signals
- `runAction` preserves `ConflictError.code` for custom codes (`NEEDS_REUPLOAD`)
- AppError subclasses carry stable `code` + `httpStatus`

12 new tests, all green. Total suite: 59 tests passing.

## Migration cookbook (for future actions)

When adding a new server action:

1. Write the inner core as `…Core(input)` that throws `AppError` subclasses
   like before — that's the natural style.
2. Export the public entry as a 3-line wrapper:
   ```ts
   export async function fooAction(input): SafeAction<ResultShape> {
     return runAction(() => fooCore(input));
   }
   ```
3. In the form, read `res.ok` and branch:
   ```ts
   const res = await fooAction(input);
   if (!res.ok) {
     if (res.fields) setErrors(res.fields);
     else setErrors({ _form: res.message });
     return;
   }
   // res.data is typed as ResultShape
   ```
4. Keep `try/catch` for genuine 500s (network failure, programmer bug). Do
   NOT use it as the primary error path — `AppError`s never reach the catch.

## Follow-up

- **None of the wrapped actions need further work.** All AppError throw
  sites already use the proper subclass with a friendly message.
- **`buildCustomerExport`** is called from a route handler that already
  catches `ForbiddenError` correctly (`F-22`); no change needed.
- **`loginAction` / `logoutAction`** use a pre-existing return-shape
  pattern that predates this audit; no change needed.
- **API routes** (`app/api/**`) catch errors via the route handler's own
  `try/catch` and return `NextResponse.json` — they don't need
  `runAction`. (Confirmed: `route.ts` files in this repo all do
  `if (err instanceof ForbiddenError) return NextResponse.json(…, 403)`.)

## Acceptance checks

- [x] Production-critical: `approveEditAction` STATUS_BYPASS message
      surfaces inline (verified by `tests/unit/errors.test.ts`).
- [x] `submitEditAction` mandatory-fields error keyed by
      `customer.<f>` / `branch.<id>.<f>` round-trips through `fields`.
- [x] `attachPhotoAction` errors propagate to `PhotoCaptureSlot.setError`.
- [x] `changeOwnPasswordAction` "Current password incorrect." surfaces.
- [x] `createUserAction` validation errors surface inline.
- [x] `markBranchClosedAction` and `requestReactivationAction` photo
      evidence errors surface.
- [x] `mergeCustomersAction` cross-region reason validation surfaces.
- [x] Type-check passes (`npm run typecheck`).
- [x] All 59 unit tests pass (`npm test`).
