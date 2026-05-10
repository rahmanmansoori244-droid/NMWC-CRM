# GT-MUSCAT pilot — credentials

**Provisioned:** 2026-05-10
**Source:** `prisma/seed-muscat-pilot.ts`
**Region:** existing **Muscat** (no new region created)
**Live URL:** https://nmwc-cm.vercel.app

---

## Admin tier (created out-of-band via seed script)

| Role | Username | Password | Notes |
|---|---|---|---|
| MANAGER | `pilot.manager` | `Manager-NMWC-2026!` | Abdullah · managedRegions = Muscat |
| STEWARD | `pilot.steward` | `Steward-NMWC-2026!` | Abdulrahman |

## Supervisor

| Role | Username | Password | Notes |
|---|---|---|---|
| SUPERVISOR | `ahmed.alndabi` | `Ahmed-NMWC-2026!` | Ahmed Al Nadabi · reports to `pilot.manager` |

## Salesmen — one per route, all reporting to Ahmed

Username = `<route>-12345-nmwc` (lowercase). Password = `<ROUTE>-12345-NMWC` (route uppercase).

| Route | Username | Password |
|---|---|---|
| C1 | `c1-12345-nmwc` | `C1-12345-NMWC` |
| C4 | `c4-12345-nmwc` | `C4-12345-NMWC` |
| C6 | `c6-12345-nmwc` | `C6-12345-NMWC` |
| C7 | `c7-12345-nmwc` | `C7-12345-NMWC` |
| C12 | `c12-12345-nmwc` | `C12-12345-NMWC` |
| C13 | `c13-12345-nmwc` | `C13-12345-NMWC` |
| C14 | `c14-12345-nmwc` | `C14-12345-NMWC` |
| C15 | `c15-12345-nmwc` | `C15-12345-NMWC` |
| MH01 | `mh01-12345-nmwc` | `MH01-12345-NMWC` |
| MH02 | `mh02-12345-nmwc` | `MH02-12345-NMWC` |

---

## Verification done

- ✅ All 13 user rows + 10 route rows present in production DB.
- ✅ Bcrypt verified against each admin-tier password.
- ✅ `pilot.manager.managedRegions = [MUSCAT]`.
- ✅ `ahmed.alndabi.supervisorId = pilot.manager.id`.
- ✅ Each salesman.supervisorId = ahmed.alndabi.id.
- ✅ Each salesman.ownedRouteId = its matching route, all routes in Muscat region.
- ✅ Live login as `c1-12345-nmwc` lands on `/today` ("Good day, Salesman", 0 customers — expected, customer master not yet uploaded).

## Known caveats

1. **Username = password (case-folded).** Anyone who learns one knows the other. User accepted "for now"; rotate before any real-customer data goes in.
2. **`mustChangePassword = false`** for all 13 accounts (the seed script does not set the flag, by user instruction). New accounts will keep these passwords until each user manually changes them.
3. **No customer master uploaded.** The 3,308-row file's CHANNEL column doesn't match NMWC's 7-channel taxonomy; user opted to skip until cleaning. `/today` and `/customers` will be empty for the salesmen until customers are imported and assigned to these routes.
4. **`DEMO_ACCOUNTS_DISABLED` is still `false`** in Vercel. When flipped to `true`, the demo accounts (`admin`, `manager.a`, `manager.b`, `steward`, `viewer`, `supervisor.1..7`, `salesman.mct-01..`) get blocked at login — the new accounts above are unaffected and survive the flip.

## How to re-run

```bash
npx tsx prisma/seed-muscat-pilot.ts
```

Idempotent: re-running upserts on `username` / `code`, refreshing names and passwords without duplicating rows.
