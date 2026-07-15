# Auth & Session — Adversarial Audit (Day-Before-Launch)

**Auditor stance:** Independent paid-to-find-bugs. The previous audit missed an obvious mandatory-fields bug; assume nothing.
**Domain:** /login, /api/auth/*, middleware, /profile, /users, lib/auth.ts, auth.config.ts, app/actions/auth.ts, services/users.ts, lib/rate-limit.ts.
**Method:** Static walk of every file in scope + tracing each of 15 user-walkthrough scenarios end-to-end.
**Date:** 2026-05-09
**Verdict:** Several previously-claimed remediations hold up under re-test, BUT five new High-severity logic/UX bugs were missed by the prior pass. None are unfixable; most are <30 minutes each. Do not launch with AUTH-04, AUTH-05, AUTH-09, AUTH-12, AUTH-15 outstanding.

---

## Verdict summary

| Severity | Count |
|---|---|
| Critical | 0 |
| **High** | **5** |
| Medium | 7 |
| Low | 4 |

The previously-fixed Critical and High items in this domain (rate-limit on direct credentials POST, AUTH_SECRET assertion, demo-account toggle, JWT freshness) verified clean. New findings below are gaps the prior audit didn't walk.

---

## 1. AUTH-01 — Disabled user keeps access for up to 5 minutes (PROD-002 fix is partial, not zero) — Medium

**File:** `lib/auth.ts:64` (`JWT_FRESHNESS_MS = 5 * 60 * 1000`) and `lib/auth.ts:107-139`.

**What a user sees:** Manager clicks "Disable" on a salesman in `/users`. The salesman, with a tab open, can keep editing customers, submitting edits, uploading photos, and viewing the master for **up to 5 minutes** afterward. Navigating to a new page within those 5 minutes still works — the JWT callback only re-reads the User row when `Date.now() - lastCheck >= JWT_FRESHNESS_MS`.

**Why it matters:** The owner explicitly asked "does the disabled user's session die now?" The honest answer is "within 5 minutes, but not immediately." For a security incident (e.g., terminated employee who lost a phone, suspected credential compromise) 5 minutes is enough to dump and modify the data they have scope on. The remediation report's wording ("disabling a user takes effect within ~5 minutes instead of the full 8h") is correct, but the `/users` UI does not warn the Manager about that lag.

**Fix (cheap):**
1. Show a toast on `/users` when disabling: "User disabled — their session will end within 5 minutes."
2. Optionally bump `lastCheck` backwards on disable: write to a `User.sessionsRevokedAt` column from `toggleUserActiveAction`, and in the JWT callback compare `token.iat` against that value. If `token.iat < user.sessionsRevokedAt`, return null immediately.

**Severity rationale:** Real-world impact is small for a non-malicious disable. For an incident-response disable, 5 minutes can matter. Owner asked the question explicitly, which means the launch UX must answer it transparently — call this Medium with a UX-must-fix.

---

## 2. AUTH-02 — Stale role for up to 5 minutes after promote/demote — Medium

**File:** Same as AUTH-01, `lib/auth.ts:107-139`.

**What a user sees:** Manager promotes Salesman → Supervisor via Excel import (the only existing role-change path; see AUTH-04). The Salesman, tab open, sees no Supervisor menus until either (a) the next JWT freshness check after 5 min, OR (b) they re-login. The reverse (demoting a Supervisor) is the security-sensitive direction: the demoted Supervisor keeps Supervisor scope for up to 5 minutes — including approving CustomerEdits.

**Why it matters:** Approve actions are irrevocable in audit terms; a Supervisor demoted because they were misbehaving can squeeze in approvals during the freshness window. The remediation report claims "role change takes effect within 5 minutes"; that is true but not communicated to the Manager.

**Fix:** Same as AUTH-01 (`sessionsRevokedAt` column, plus role change increments it). Or shorten freshness to 60s for role/active changes specifically — keep 5 min as the default.

---

## 3. AUTH-03 — `createUserAction` allows creating MANAGER, STEWARD, VIEWER without privilege guard on the *target* role — Medium

**File:** `services/users.ts:42-101`.

**What a real user does:** Manager A opens `/users → Create user`, picks Role = MANAGER, and clicks Create. The system happily creates a peer Manager. There is no second-Manager-approval, no "minimum role hierarchy" check, no log of "elevated role created." The PRD does not appear to forbid this, but the audit found QA-035 already and the fix was deferred ("Medium — non-blocking"). Combined with AUTH-15 (no password-reset flow for the user themselves), this means a single rogue Manager can mint a permanent backdoor account.

**Why it matters:** Weakest link in the role hierarchy. With one Manager compromised, attacker creates `salesman.backdoor` (or even `manager.backdoor`) with a known password and 8h JWT. Disabling the original compromised Manager doesn't disable the backdoor.

**Fix:**
- Require a second Manager approval (or Steward approval) for creating MANAGER or STEWARD roles. Stash the request in a new `PendingUserCreate` table.
- At minimum, audit-log "manager_created_manager" with both actor and target IDs and surface those in `/audit` with a red badge.
- Cap creation: a Manager can create SALESMAN / SUPERVISOR / VIEWER; only a Steward (or an "admin" role gated to <=1 user) can create MANAGER.

---

## 4. AUTH-04 — There is no in-app way to change a user's role after creation — High

**Files:** `services/users.ts` exposes only `createUserAction`, `toggleUserActiveAction`, `resetPasswordAction`. No `updateUserRoleAction`. `app/(app)/users/UserRowActions.tsx:44-86` confirms the UI only has Disable/Enable + Reset password.

**What a user sees:** Manager wants to promote Salesman → Supervisor (Scenario 3). They try `/users` — there's no edit button. They click into the user — there is no per-user detail page. The only documented path is Excel re-upload via `/import` (services/imports.ts) with the `change_role=yes` column.

**Why it matters:**
1. The owner explicitly asked "Manager promotes a Salesman to Supervisor — does the Salesman see Supervisor menus before re-login?" The honest QA answer is "Manager has no UI to do this in the first place." The previous audit deferred QA-011 to imports but never flagged that the in-app `/users` flow is missing.
2. Forcing Excel for role changes means every promotion runs through `services/imports.ts` which (per QA-010 fix) requires a `reset_password=yes` column to rotate the password and a `change_role=yes` column to change the role. A Manager who only wants to promote *will* get this wrong on a real spreadsheet (they will leave the existing password, which is hashed in the DB, blank in the sheet — and the import will reject the row or silently no-op).
3. There is no audit trail of "Manager X promoted user Y on date Z" in the live app — only the import-log row.

**Fix:**
- Add `updateUserRoleAction` in `services/users.ts` with full audit log + bump `sessionsRevokedAt` (see AUTH-01).
- Add a per-user role dropdown in `UserRowActions.tsx` next to Disable/Enable.
- Reject Salesman → anything-other-than-Supervisor without explicit confirmation (Salesman has a `ownedRouteId` that needs to be cleared on promote — silent breakage if not).

---

## 5. AUTH-05 — Promoting a Salesman does not clear `ownedRouteId`; route stays orphaned to the new Supervisor — High

**Files:** `services/users.ts` (no role-change function), `prisma/schema.prisma:138` (`ownedRouteId String? @unique`), `services/imports.ts` (the only role-change path).

**What a user sees:** Imagine the Excel role-change path *did* work cleanly (it doesn't fully — see AUTH-04). Manager changes Salesman MCT-01's role to SUPERVISOR via import. The DB's `User.ownedRouteId` stays pointed at the route. On `/users` the new Supervisor still appears with a route assignment. The route is now "owned" by a Supervisor, which is meaningless. The route's `owner: null` filter in `app/(app)/users/page.tsx:32` excludes this route from the "available to assign" list. So when the Manager hires a replacement Salesman, the route appears assigned and the Manager can't pick it.

**Why it matters:** A real Manager three weeks into the pilot will hit this and have no way to fix it from the UI. They will need a developer to run a SQL UPDATE.

**Fix:** Whatever role-change action exists must:
1. If `oldRole === SALESMAN && newRole !== SALESMAN`: set `ownedRouteId = null`.
2. If `newRole === SALESMAN`: require a fresh `ownedRouteId` on the request, validate not-already-owned.
3. If `oldRole === SUPERVISOR`: validate no users have `supervisorId === thisUser.id` before allowing the change (or re-parent them).

---

## 6. AUTH-06 — `createUserAction` does not validate `supervisorId` actually points at a SUPERVISOR — High

**File:** `services/users.ts:42-101`. The Zod schema accepts any cuid string at line 38; line 84 writes `supervisorId: data.supervisorId ?? null` with no membership/role check.

**What a user sees:** The dropdown in `CreateUserForm.tsx:69-85` only shows users with `role === SUPERVISOR`. **But** the form is a plain HTML form. A determined Manager (or anyone with browser DevTools) can put any cuid in the hidden form field — including their own Manager userId or a Salesman's userId. The action accepts it.

**Why it matters:** Creates a tangle in the hierarchy. A SALESMAN with `supervisorId` pointing at another SALESMAN, or at themselves, breaks the team-scope queries used everywhere (`services/scope.ts` etc.). QA-035 flagged this and the remediation report acknowledges it as deferred.

**Fix:**
```ts
if (data.supervisorId) {
  const sup = await prisma.user.findUnique({ where: { id: data.supervisorId } });
  if (!sup || sup.role !== Role.SUPERVISOR || !sup.isActive) {
    throw new ValidationError({ supervisorId: 'Must point at an active Supervisor.' });
  }
}
```

---

## 7. AUTH-07 — No "last Manager" lockout protection on disable / role-demotion — High

**File:** `services/users.ts:103-124`. No check for `Manager count` before flipping `isActive=false` on a MANAGER row. No role-change UI exists yet (AUTH-04), but if the import path is the workaround, the import has the same problem.

**What a user sees:** Two-Manager system (`manager.a`, `manager.b`). `manager.a` disables `manager.b` (legitimately, because they left the company). Then `manager.a` accidentally clicks "Disable" on themselves and confirms the modal. The modal text is `"Disable user manager.a"?` — it does not warn "you are the only Manager." Click → no Manager logged in. **No one can re-enable anyone.** Recovery requires a developer to UPDATE the DB.

In production with 2 Managers this is one mis-click from a full lockout. With a single Manager (which is plausible for the 38-route pilot at NMWC) it's even worse.

**Why it matters:** Hard lockouts of admin roles are the kind of bug that takes a 3am call to fix. The previous QA found this (QA-037) and explicitly deferred it as Medium "non-blocking." For a one-day-before-launch app with a small admin population, this is not non-blocking.

**Fix:**
```ts
if (user.role === Role.MANAGER && user.isActive) {
  const activeManagers = await prisma.user.count({
    where: { role: Role.MANAGER, isActive: true, id: { not: userId } },
  });
  if (activeManagers === 0) {
    throw new ValidationError({ _form: 'Cannot disable the last active Manager.' });
  }
}
```
Same shape for the future role-change function.

---

## 8. AUTH-08 — Manager can reset another Manager's password instantly with no second factor or notification — High

**File:** `services/users.ts:126-146`.

**What a user sees:** `manager.a` opens `/users`, clicks Reset password on `manager.b`'s row, types `Backdoor!2026`, clicks Save. Done. `manager.b` is locked out at next JWT refresh (5 min) and `manager.a` can log in as `manager.b` immediately. No email, no Slack, no audit notification to `manager.b`.

**Why it matters:** Peer-Manager attack. One compromised Manager owns every other Manager's account in <10 seconds. The audit log row exists but no one reads `/audit` unprompted.

**Fix:**
- Require Manager to re-enter their own password before resetting another Manager's password (sudo-style).
- On reset, set `User.passwordResetByActorId` and email the target user (when email is configured) or push an in-app banner ("Your password was reset by manager.a on 2026-05-09 — if this wasn't expected, contact security").
- Optional: refuse peer-Manager reset entirely; require Steward to do it.

---

## 9. AUTH-09 — `/users` create-user form shows the password in plaintext on submit error / bounces — High (UX + leak risk)

**File:** `app/(app)/users/CreateUserForm.tsx:108-115`. The password field is `type="password"`, **but** on validation error the form is *not* reset (only on success at line 37-38). The browser keeps the typed password on screen. A Manager who hits "username already exists" sees their password redisplayed (masked in the input but recoverable via DevTools / autofill).

More important: there is **no out-of-band delivery** of the password. The created user's password is whatever the Manager typed. The Manager must communicate it to the new user manually (WhatsApp, voice, paper). This is a known weak practice but the UI does not even show "remember to send this password securely" — and there is no "force change at next login" flag.

**What a user sees:**
1. Manager creates `salesman.smq-04` with password `Welcome2026!`. The form has no copy-to-clipboard button, no "the user must change this on first login" note, no QR generation. Manager texts the password over plain SMS.
2. New user logs in and is *not* prompted to change. They keep using `Welcome2026!`. No DB column tracks `passwordTemporary`.

**Why it matters:** No forced first-login password change means temp passwords become permanent passwords. Combined with QA-022 (demo accounts have predictable passwords) and AUTH-15 (no self-serve password reset), the realistic operational outcome is that ~40 NMWC users will be using passwords their Manager picked + texted them, indefinitely.

**Fix:**
- Add `User.mustChangePassword Boolean @default(false)`.
- `createUserAction` and `resetPasswordAction` set it to `true`.
- After login, if `mustChangePassword`, force-redirect to `/profile/change-password` and refuse all other routes via middleware.
- Generate a strong random password server-side (12+ chars, mixed case, symbol) and display it once to the Manager with a copy button — instead of letting the Manager type it.
- Show a "delivery method" radio (in-person / WhatsApp / SMS) and warn the Manager about each.

---

## 10. AUTH-10 — Race: two simultaneous `createUser` requests with the same username can both succeed (or both fail messily) — Medium

**File:** `services/users.ts:42-101`. The username uniqueness is enforced at the DB layer (`User.username @unique` in `prisma/schema.prisma:121`). The action does not pre-check; it just calls `prisma.user.create`. On a duplicate, Prisma throws `P2002`, which surfaces as an unhandled `Error` and the form shows a generic "Unique constraint failed" message rather than the friendly "Username already taken."

**What a user sees:** Manager hits Create twice quickly (or two Managers create the same username for two different new hires — `s.salim` is a popular name). The second attempt shows a confusing Prisma error string in the form; if the form failed validation server-side mid-bcrypt-hash, the second Manager just sees "Failed." with no field highlight. The first Manager's user is created. No data is corrupted, but the UX is poor and the second Manager can't tell what happened.

**Why it matters:** Operational confusion at scale-out time. Not a security bug, but the form's `setErrors({ _form: err.message })` at line 43 leaks raw Prisma text to the UI.

**Fix:**
```ts
const existing = await prisma.user.findUnique({ where: { username: data.username }, select: { id: true } });
if (existing) throw new ValidationError({ username: 'Username already taken.' });
// then catch P2002 in the create() in case of race and surface the same friendly message.
```

---

## 11. AUTH-11 — Per-user rate-limit bucket can be diluted by username casing — High

**Files:** `lib/auth.ts:162` (`login:user:${username}`) and `app/actions/auth.ts:30` (same key shape). The Zod schema in `lib/auth.ts:32-35` accepts any string of length 3-50; no `.toLowerCase()` is applied before computing the bucket key.

**What a user sees:** Attacker brute-forcing `admin`. After 5 fast attempts the bucket `login:user:admin` is exhausted. Attacker switches to `Admin`, `ADMIN`, `aDMIN`, `admiN`, `ADmin`, … Each casing variant is a different bucket key. The IP bucket (`login:ip:<ip>`) is shared and refills at 5/min, so the IP bucket throttles them at the IP level — but a multi-source attacker (open proxy, residential VPN rotation) can spread across IPs while still mostly hammering the same target user.

Furthermore: the Postgres `User.username @unique` constraint is case-sensitive. `prisma.user.findUnique({ where: { username: "ADMIN" } })` returns null. So the casing bypass does not actually log in — bcrypt against `DUMMY_BCRYPT_HASH` runs, the user-not-found path returns null. **But** the per-user limiter is exposed, defeating its purpose as a brute-force defense at the username level.

Equivalent issue exists for the `loginAction` server-action path (same key shape).

**Why it matters:** The per-user rate limit is one of the two main brute-force defenses claimed in the remediation. Trivially bypassable by varying case. The IP limit still helps, but the QA-006 fix narrative is weaker than implied.

**Fix:**
```ts
const usernameKey = parsed.data.username.toLowerCase();
// use usernameKey for rate-limit lookups AND for prisma.user.findUnique({ where: { username: usernameKey } })
// but document/enforce that all usernames are stored lowercase (services/users.ts already enforces via regex)
```
Apply consistently in both `lib/auth.ts` and `app/actions/auth.ts`.

---

## 12. AUTH-12 — Logout does not invalidate the JWT — cookie replay possible until expiry — High

**Files:** `app/actions/auth.ts:56-58` (`logoutAction` calls `signOut`). Auth.js's default `signOut` clears the `__Host-authjs.session-token` cookie (or `next-auth.session-token` without HTTPS) **on the user's browser only**. The JWT itself is not added to a deny-list because there isn't one. The session strategy is `'jwt'` (`auth.config.ts:14`).

**What a user sees:** Salesman logs in on a borrowed phone. Some malware or a Burp-like proxy on the LAN copies the cookie value. Salesman logs out — server-side, nothing happens. Attacker replays the cookie from their own browser. The JWT signature still validates against `AUTH_SECRET`. The freshness check (5 min) re-reads the User row and returns the user (still active, since logout didn't disable them). Attacker is logged in as the salesman until the 8h `exp` is reached.

This is a known property of stateless JWT auth — the remediation report does not address it. The owner's question 11 is "Logout — does it actually invalidate the JWT, or does the cookie just get cleared? Can the cookie be replayed?" The honest answer is: it can be replayed.

**Why it matters:** Public/shared device scenarios are realistic for field salesmen. Logout-but-still-logged-in is a security hole that users assume is closed.

**Fix (minimum):**
1. Track `User.lastLogoutAt` (or the broader `User.sessionsRevokedAt` proposed in AUTH-01). On logout: write the timestamp.
2. In the JWT freshness callback: if `token.iat * 1000 < user.sessionsRevokedAt.getTime()`, return null.
3. Also bump `sessionsRevokedAt` on disable + role change to subsume AUTH-01/02.

---

## 13. AUTH-13 — Auth.js cookie attributes use defaults; not explicitly hardened — Medium

**File:** `auth.config.ts:12-29`. No `cookies` block, no `useSecureCookies`. Auth.js v5 defaults to `__Secure-` prefix in production with `secure: true`, `httpOnly: true`, `sameSite: 'lax'` — those are fine. But:
- No explicit `__Host-` prefix (would forbid `Domain` attribute and require Path `/`).
- `sameSite: 'lax'` allows top-level GET cross-site requests to send the cookie. Fine for a server-action app since there are no GET-driven mutations, but worth pinning.
- No `path` set — defaults to `/`, fine.

**What a user sees:** Nothing visible. A skilled attacker noting the absence of `__Host-` could craft a domain-confusion attack on a misconfigured shared subdomain (not currently a threat for nmwc-cm.vercel.app).

**Why it matters:** Defense-in-depth. The previous audit also flagged this (QA-026) and it remains open.

**Fix:**
```ts
session: { strategy: 'jwt', maxAge: 8 * 60 * 60 },
cookies: {
  sessionToken: {
    name: process.env.NODE_ENV === 'production' ? '__Host-authjs.session-token' : 'authjs.session-token',
    options: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/' },
  },
},
```

---

## 14. AUTH-14 — `/api/photos/finalize` POST has no CSRF token — Medium

**File:** `app/api/photos/finalize/route.ts:42-104`. Only check is `auth()`. No CSRF token check, no Origin/Referer check, no `__Host-` cookie binding.

**What a user sees:** Logged-in salesman visits attacker site `evil.example`. Page does a `<form action="https://nmwc-cm.vercel.app/api/photos/finalize" method="POST">` with attacker-controlled body — but it has to be JSON (Content-Type `application/json`), which a form can't send without preflight. So a simple `<form>` won't work. **However** an XHR/fetch from `evil.example` *can* — and the `SameSite=Lax` cookie default WILL be sent on top-level navigation but NOT on cross-origin XHR. So this is mostly mitigated by SameSite=Lax.

**But:** if a Manager opens a malicious link in a new tab and the link does a top-level POST with `enctype=text/plain` to `/api/photos/finalize` carrying a crafted JSON-shaped body, the cookie is sent. With `Content-Type: text/plain`, the route's `req.json()` will fail and return INVALID_JSON — so this specific attack doesn't get through. The route is effectively safe from CSRF *because* it requires JSON.

**Server actions** (Next.js with the `Next-Action` header) are also CSRF-protected by Next.js's built-in Origin check on POST.

**What's worth doing anyway:**
- Add an explicit `Origin` / `Referer` check on `/api/photos/finalize` (and `/api/photos/presign`) to defend in depth.
- Document in `lib/auth.ts` or middleware that the app intentionally relies on SameSite + JSON content-type for CSRF, and that any future GET-driven mutations must add a CSRF token.

**Severity:** Medium — currently no exploitable CSRF, but the protection is implicit and one mis-step (allowing form-encoded requests, dropping JSON requirement) would re-open it.

---

## 15. AUTH-15 — There is no password-reset flow at all; forgotten passwords are impossible to recover without a Manager — High (operational)

**Files searched:** No `/forgot-password`, no `/reset-password`, no email-token route, no `User.passwordResetToken` field, no `requestPasswordResetAction`. The only path for a user with a forgotten password is "ask your Manager" (AUTH-08).

**What a user sees:** Salesman forgets their password on a Friday evening. They cannot log in. The Manager is the only person who can reset it. If the only Manager is on leave, the salesman cannot work Saturday. There is no email-driven self-service.

The login screen has no "Forgot password?" link. `LoginForm.tsx` shows only username + password + Sign in.

**Why it matters:** Operational lockout is the most-likely real-world incident in production. Combined with AUTH-08 (no audit signal when Manager resets your password), this puts every account at the mercy of a single human gatekeeper.

**Fix (minimum-viable):**
- Add a "Forgot password? Contact your Manager" line to `LoginForm.tsx` so users know what to do. Free.
- Document the reset-via-Manager path in onboarding.
- (v1.1) Build a real email-token reset flow once `User.email` is reliably populated. Without it, any self-service reset is impossible.

**Severity:** High because of the day-before-launch operational risk. Not a security hole; a usability/operational hole.

---

## 16. AUTH-16 — `/profile` is read-only — user cannot change their own password — Medium

**File:** `app/(app)/profile/page.tsx:9-58`. The page fetches the user record and renders fields with no edit affordances. The only action is Sign out.

**What a user sees:** Logged-in salesman wants to change their password (e.g., temp password from Manager → personal one). There is no "Change password" button on `/profile`. They cannot. They must ask the Manager (AUTH-08, AUTH-15).

**Why it matters:** Combined with AUTH-09's lack of force-change-on-first-login, the practical result is users keep their Manager-assigned passwords forever. This is below industry-standard auth hygiene for a CRM holding Oman commercial PII.

**Fix:** Add `changePasswordAction(currentPassword, newPassword)` in `services/users.ts`. Validate `currentPassword` via bcrypt, write new hash, log to audit, clear `mustChangePassword` (proposed in AUTH-09). Add a small form on `/profile`.

The /profile page also has no obvious affordance — good, but the *consequence* (no ability) is the bug.

---

## 17. AUTH-17 — `AUTH_SECRET` length check is exactly-≥-32-chars; doesn't reject low-entropy strings — Low

**File:** `lib/auth.ts:13-22`. `if (!s || s.length < 32) throw`. A secret of `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (32 'a' chars) passes the check despite ~0 entropy.

**What a user sees:** Nothing — until an attacker realises the Vercel admin set `AUTH_SECRET=changeme[REDACTED-PILOT-PW]90changeme1234567` and forges JWTs.

**Why it matters:** False sense of security. Real entropy is what matters, not character count. 31-char check would be too strict if AUTH_SECRET is a base64 string of 24 random bytes (32 chars exactly), so the bound is sensible — but the "too short" message implies a strict rule when the real risk is low entropy.

**Fix:**
```ts
if (!s || s.length < 32) throw new Error('...');
// Smell-test: refuse trivially repetitive secrets
if (/^(.)\1+$/.test(s) || /^[a-z]+$/.test(s)) {
  throw new Error('AUTH_SECRET appears low-entropy. Generate via openssl rand -base64 32');
}
```

A 31-char secret will be rejected (correctly). A 32-char low-entropy secret currently passes; with this fix, obvious junk is rejected.

---

## 18. AUTH-18 — Multi-tab / multi-device login: same user has two valid JWTs simultaneously, no awareness — Low

**Behaviour:** User logs in on phone (cookie A). Logs in on laptop (cookie B). Both work for 8 hours. `lastLoginAt` is overwritten by whichever was last; no device fingerprint, no concurrent-session warning.

**Concrete consequences:**
- A salesman who lent their phone, logged in there, then logged in on their own phone, has TWO active sessions. Logging out on either does not kill the other. (Tied to AUTH-12.)
- Conflicting writes from two tabs are handled at the action layer, not the session layer (the existing concurrency guards on edits / approvals from QA-017 / PROD-001 cover the data side).

**Severity:** Low — common pattern (matches Slack, Gmail, etc.). Worth documenting because the owner asked.

**Fix (optional v1.1):** Surface "Active sessions" on `/profile` with a "Sign out everywhere" button. Implement via `sessionsRevokedAt` (see AUTH-01 / AUTH-12).

---

## 19. AUTH-19 — Login form has no visible feedback that rate-limit was hit (vs wrong password) — Medium

**File:** `app/actions/auth.ts:31-39` returns `Too many attempts. Try again in ${retryAfterSec}s.` from the server action path. **But** the rate limit also runs inside `Credentials.authorize()` (`lib/auth.ts:161-176`), and there it returns null silently — same UX as wrong-password ("Invalid username or password.").

**What a user sees:**
1. User mistypes password, sees "Invalid username or password." Tries again.
2. After 5 attempts: server-action path will say "Too many attempts. Try again in N seconds." but only if the form invocation actually went through `loginAction` (the form submit on the login page does — line 14-19 of `LoginForm.tsx`).
3. If the user is hitting `/api/auth/callback/credentials` directly (e.g., a hand-written script, or a future SSO integration), they get only "Invalid username or password" with no retryAfter.

For the legitimate web user, `loginAction` should always run first and they will see the friendly message. Good. **But** the per-user limiter can also be hit by an attacker on a totally different IP with the same username. The legitimate user, sitting at their desk on attempt #1, will be told "Too many attempts. Try again in 60s." with no idea why — they've only tried once.

**Why it matters:** Helpdesk noise. Owner asked "is the rate limit clear?" The answer for the attack path: yes. For the victim of a targeted brute-force: confusing.

**Fix:**
- Distinguish `login:user:` exhaustion from `login:ip:` exhaustion in the message: "Account temporarily locked due to repeated attempts" vs "Too many attempts from your network."
- Don't show the retry-after countdown for the user-bucket case (it leaks that the username exists).
- Document the user-bucket exhaustion in the helpdesk runbook.

---

## 20. AUTH-20 — `auth.config.ts:authorized()` callback does not refuse disabled users on every request — Low (compensated)

**File:** `auth.config.ts:17-27`. Returns `!!auth` for any non-public path. Does not check `auth.user.role` or `auth.user.isActive`. **`isActive` is not in the JWT** — it's only checked at issuance and at JWT-freshness re-read.

**What a user sees:** Nothing different from AUTH-01 / AUTH-12 — the freshness check in `lib/auth.ts:107-139` is what eventually catches a disabled user. The middleware itself trusts the JWT.

**Why it matters:** Layered defense would have the middleware also enforce active-state, but doing so would require DB access from the Edge runtime (not currently possible with the Prisma adapter pattern in use). The current architecture is fine; flagging for completeness because the owner asked about middleware.

**Fix:** None practical without re-architecting middleware. Document the freshness window as the bound of disable-effectiveness.

---

## Scenario walk-through summary

| # | Scenario | Result |
|---|---|---|
| 1 | Manager creates user | Required: fullName, username, role, password (12+). Password is plaintext-typed by Manager (AUTH-09). No out-of-band delivery. Username uniqueness via DB constraint, no pre-check (AUTH-10). |
| 2 | Manager disables user | Session dies within 5 min via JWT freshness (AUTH-01). Manager has no UI feedback about the lag. |
| 3 | Promote Salesman → Supervisor | **No in-app UI exists** (AUTH-04). Excel import is the only path; ownedRouteId not cleared (AUTH-05). After re-login: new role active. Stale role for up to 5 min in old session (AUTH-02). |
| 4 | Manager demotes themselves / last Manager disable | **No lockout protection** (AUTH-07). Confirm modal text doesn't warn. |
| 5 | 10 wrong logins | First 5: per-user bucket exhausts. Bucket bypassable by varying username casing (AUTH-11). IP bucket also engages. UX: rate-limit message reaches user via server-action path; direct credentials POST silent (AUTH-19). |
| 6 | 7h59 / 8h01 / freshness window | Within 8h: token still valid; freshness re-read catches role/disable changes within 5 min. After 8h: redirect to /login. Verified clean. |
| 7 | AUTH_SECRET edge cases | Missing → boots in dev (skipped check), boots-and-throws in prod. Length 31 → throws in prod, OK in dev. Length 32 of repeated chars → passes (AUTH-17). |
| 8 | Casing bypass on rate limit | Confirmed (AUTH-11). |
| 9 | Two browsers same user | Both work; no awareness (AUTH-18). |
| 10 | /profile self-edit | Read-only — cannot change role / isActive / supervisor (correct design) but **cannot change own password** either (AUTH-16). |
| 11 | Logout / cookie replay | Cookie cleared on browser; JWT not invalidated server-side (AUTH-12). |
| 12 | CSRF | Server actions: protected by Next.js Origin check. /api/photos/finalize: protected by SameSite=Lax + JSON-only requirement, but no explicit Origin check (AUTH-14). /api/auth/callback/credentials: Auth.js handles CSRF via its own csrf token. |
| 13 | DEMO_ACCOUNTS_DISABLED launch checklist | Currently `false`. Code at `lib/auth.ts:183-190` covers `salesman.*`, `supervisor.*`, `manager.[ab]`, `steward`, `viewer`, `admin`. No service code hard-codes demo usernames (verified). Launch task: set env var + rotate `admin` password. |
| 14 | Multi-device race | Action-layer guards cover writes; session layer has no awareness (AUTH-18). |
| 15 | Forgotten password | **No self-serve flow** (AUTH-15). Manager-only reset (AUTH-08). |

---

## Severity-ordered finding list

| # | ID | Severity | Title |
|---|---|---|---|
| 1 | AUTH-04 | High | No in-app UI to change a user's role after creation |
| 2 | AUTH-05 | High | Promoting a Salesman doesn't clear `ownedRouteId` |
| 3 | AUTH-06 | High | `createUserAction` doesn't validate `supervisorId` actually points at a SUPERVISOR |
| 4 | AUTH-07 | High | No "last Manager" lockout protection on disable |
| 5 | AUTH-08 | High | Manager can reset another Manager's password with no second factor or notification |
| 6 | AUTH-09 | High | No forced first-login password change; password handling is operationally weak |
| 7 | AUTH-11 | High | Per-user rate-limit bucket diluted by username casing |
| 8 | AUTH-12 | High | Logout doesn't invalidate the JWT — cookie replay possible |
| 9 | AUTH-15 | High | No password-reset flow at all |
| 10 | AUTH-01 | Medium | Disabled user keeps access for up to 5 min, no UI warning |
| 11 | AUTH-02 | Medium | Stale role for up to 5 min after promote/demote |
| 12 | AUTH-03 | Medium | `createUserAction` lets a Manager create another MANAGER |
| 13 | AUTH-10 | Medium | Race on duplicate username creation surfaces raw Prisma error |
| 14 | AUTH-13 | Medium | Auth.js cookie attributes not explicitly hardened (`__Host-` prefix) |
| 15 | AUTH-14 | Medium | `/api/photos/finalize` POST has no explicit CSRF/Origin check |
| 16 | AUTH-16 | Medium | `/profile` is read-only — user cannot change their own password |
| 17 | AUTH-19 | Medium | Login UX cannot distinguish per-user vs per-IP rate-limit exhaustion |
| 18 | AUTH-17 | Low | `AUTH_SECRET` length check ≥32 doesn't catch low-entropy strings |
| 19 | AUTH-18 | Low | Multi-tab / multi-device sessions are uncoordinated |
| 20 | AUTH-20 | Low | `auth.config.ts:authorized()` doesn't enforce isActive (compensated by freshness) |

---

## Day-of-launch checklist for the auth domain

These are the items that, without remediation, will burn the owner in production within 30 days:

1. **Fix AUTH-04 + AUTH-05 + AUTH-07** before launch. A 2-Manager production with no role-change UI and no last-Manager lock is one mis-click from a 3am incident.
2. **Fix AUTH-08** (sudo or peer-reset block) and **AUTH-09** (force first-login change). These are the auth-hygiene table stakes.
3. **Fix AUTH-11** (lowercase the rate-limit key) — 10 minutes of work.
4. **Fix AUTH-12** + **AUTH-15** by adding `User.sessionsRevokedAt` and a password-change page on `/profile` — 1 to 2 hours.
5. **Set `DEMO_ACCOUNTS_DISABLED=true`** in Vercel.
6. **Rotate `admin` password** away from `ChangeMeNow!2026` (per the remediation report's checklist).
7. Add a "Forgot password? Contact your Manager" link to `/login`.

The Mediums and Lows can ship with v1.0 and be patched within the first pilot week.

— Adversarial QA / Auth domain, 2026-05-09
