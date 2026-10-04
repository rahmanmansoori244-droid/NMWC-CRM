# Login and sign-in throttling

> 34 nodes · cohesion 0.08

## Key Concepts

- **login-throttle.test.ts** (20 connections) — `tests/unit/login-throttle.test.ts`
- **auth.ts** (19 connections) — `app/actions/auth.ts`
- **login-username-trim.test.ts** (15 connections) — `tests/unit/login-username-trim.test.ts`
- **loginAction()** (8 connections) — `app/actions/auth.ts`
- **login-throttle.ts** (5 connections) — `lib/login-throttle.ts`
- **loginFailureMessage()** (4 connections) — `lib/login-throttle.ts`
- **LoginThrottledError** (4 connections) — `lib/login-throttle.ts`
- **page.tsx** (4 connections) — `app/(auth)/login/page.tsx`
- **LoginForm.tsx** (4 connections) — `components/nmwc/LoginForm.tsx`
- **LOGIN_LIMIT** (3 connections) — `lib/rate-limit.ts`
- **signIn()** (2 connections) — `tests/e2e/golive-update-flow.spec.ts`
- **LoginForm()** (2 connections) — `components/nmwc/LoginForm.tsx`
- **login()** (2 connections) — `tests/unit/login-throttle.test.ts`
- **submit()** (2 connections) — `tests/unit/login-username-trim.test.ts`
- **usernameSchemas()** (2 connections) — `tests/unit/login-username-trim.test.ts`
- **LoginResult** (1 connections) — `app/actions/auth.ts`
- **loginSchema** (1 connections) — `app/actions/auth.ts`
- **.constructor()** (1 connections) — `lib/login-throttle.ts`
- **LoginPage()** (1 connections) — `app/(auth)/login/page.tsx`
- **metadata** (1 connections) — `app/(auth)/login/page.tsx`
- **anotherNetwork()** (1 connections) — `tests/unit/login-throttle.test.ts`
- **Authorize** (1 connections) — `tests/unit/login-throttle.test.ts`
- **callback()** (1 connections) — `tests/unit/login-throttle.test.ts`
- **freshUser()** (1 connections) — `tests/unit/login-throttle.test.ts`
- **h** (1 connections) — `tests/unit/login-throttle.test.ts`
- *... and 9 more nodes in this community*

## Relationships

- [[rate-limit area]] (7 shared connections)
- [[Auth and page scope loading]] (5 shared connections)
- [[stripComments area]] (5 shared connections)
- [[Audit log writing]] (4 shared connections)
- [[logger area]] (2 shared connections)
- [[PageHeader area]] (1 shared connections)
- [[Customer list, filters and export]] (1 shared connections)
- [[Sidebar area]] (1 shared connections)
- [[golive-update-flow.spec area]] (1 shared connections)

## Source Files

- `app/(auth)/login/page.tsx`
- `app/actions/auth.ts`
- `components/nmwc/LoginForm.tsx`
- `lib/login-throttle.ts`
- `lib/rate-limit.ts`
- `tests/e2e/golive-update-flow.spec.ts`
- `tests/unit/login-throttle.test.ts`
- `tests/unit/login-username-trim.test.ts`

## Audit Trail

- EXTRACTED: 113 (98%)
- INFERRED: 2 (2%)
- AMBIGUOUS: 0 (0%)

---

*Part of the graphify knowledge wiki. See [[index]] to navigate.*