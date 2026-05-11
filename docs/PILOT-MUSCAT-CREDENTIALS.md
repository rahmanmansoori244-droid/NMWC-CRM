# GT-MUSCAT pilot — credentials (current)

**Last reset:** 2026-05-11 by `pilot.steward` via `scripts/bulk-reset-credentials.ts`
**Live URL:** https://nmwc-cm.vercel.app

> ⚠️ **EXPLICIT SECURITY TRADE-OFF.** All staff and salesmen share two simple
> passwords. Anyone who knows a username can log in as that user. The owner
> accepted this on 2026-05-11 in exchange for field-team ease of use during
> the Muscat pilot. **Rotate to per-user passwords before any expansion
> beyond the 10-salesman Muscat pilot.** A bulk-reset script
> (`scripts/bulk-reset-credentials.ts`) makes the rotation a 1-minute job.

---

## Salesmen (10) — `<route>-nmwc` / `12345678`

| Route | Username | Password |
|---|---|---|
| C1   | `c1-nmwc`   | `12345678` |
| C4   | `c4-nmwc`   | `12345678` |
| C6   | `c6-nmwc`   | `12345678` |
| C7   | `c7-nmwc`   | `12345678` |
| C12  | `c12-nmwc`  | `12345678` |
| C13  | `c13-nmwc`  | `12345678` |
| C14  | `c14-nmwc`  | `12345678` |
| C15  | `c15-nmwc`  | `12345678` |
| MH01 | `mh01-nmwc` | `12345678` |
| MH02 | `mh02-nmwc` | `12345678` |

## Staff (3) — original usernames / `97246316`

| Role | Username | Password |
|---|---|---|
| MANAGER    | `pilot.manager` | `97246316` |
| STEWARD    | `pilot.steward` | `97246316` |
| SUPERVISOR | `ahmed.alndabi` | `97246316` |

---

## Forced password change disabled

`mustChangePassword = false` on every account. Users will NOT be asked to
change their password on first login. This is intentional for the pilot.

## Demo / legacy accounts disabled

The following 13 leftover accounts have been deactivated (`isActive=false`)
during the reset. They cannot log in, but their audit history is preserved:

`admin`, `manager.a`, `manager.b`, `steward`, `supervisor.1`..`supervisor.7`,
`test.mustchange`, `viewer`.

## How to rotate later

```bash
# Edit SALESMAN_PASSWORD / STAFF_PASSWORD at the top of:
#   scripts/bulk-reset-credentials.ts
# Then:
npx tsx scripts/bulk-reset-credentials.ts
```

The script:
- bcrypts each new password with cost 12,
- updates only active users matching the configured role set,
- clears PasswordHistory so the reuse-check doesn't block the change,
- bumps `sessionsRevokedAt` so any existing JWT becomes invalid
  immediately (next request → /login),
- writes one summary `AuditLog` row attributed to `pilot.steward`.

Re-running with the same passwords is a no-op (idempotent).

## Verification done

- ✅ Bulk reset script ran 2026-05-11 — 10 salesmen + 3 staff updated, 13 demo accounts disabled.
- ✅ Live login as `c1-nmwc` / `12345678` → HTTP 200, lands on `/today`.
- ✅ All `sessionsRevokedAt` bumped — any salesman currently logged in is forced to re-login.
- ✅ `mustChangePassword = false` confirmed on all 13 active users.
- ✅ One `AuditLog` row attributing the reset to `pilot.steward` with the rename map.
