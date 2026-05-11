# Morning-of-launch checklist

Print this. Run through it before your first salesman logs in.
**Estimated time: 7 minutes.**

---

## 1. Is the system up? (30 sec)

Open in a browser:
- https://nmwc-cm.vercel.app/api/health
  Expected: `{"status":"ok"}` with HTTP 200.
- https://nmwc-cm.vercel.app/login
  Expected: the NMWC login screen renders within 2 seconds.

If either is not OK, stop. Check Vercel dashboard for build/deploy errors.

---

## 2. Is the function warm? (30 sec)

Run from your terminal:
```
curl -w "\n%{time_total}s\n" -o /dev/null https://nmwc-cm.vercel.app/api/health
```
Expected: under **0.6 seconds**.

If it's over 1.5 seconds, the keep-warm cron hasn't fired recently. Trigger a manual one:
- https://github.com/rahmanmansoori244-droid/NMWC-CRM/actions/workflows/keep-warm.yml → **Run workflow**
- Wait 60 seconds, re-run the curl. Should now be sub-600ms.

---

## 3. Did last night's backup run? (30 sec)

Open: https://github.com/rahmanmansoori244-droid/NMWC-CRM/actions/workflows/db-backup.yml

Expected: most recent run is **green** ✓ and dated today (or yesterday after 02:00 UTC).
Then go to https://dash.cloudflare.com/a5cc755aea210134949be8fcc1146819/r2/default/buckets/nmwc-backups and confirm `db/<yesterday's-date>.sql.gz` exists.

If red, the daily backup failed — the system still works but you don't have a fresh dump. Trigger a manual workflow run from the same page.

---

## 4. Login as each role + spot-check (3 min)

| Role | URL | What to confirm |
|---|---|---|
| Manager (`pilot.manager` / `Manager-NMWC-2026!`) | /dashboard | Total customers shows `~3,300`; the page loads in under 2 sec |
| Steward (`pilot.steward` / `Steward-NMWC-2026!`) | /customers | Filter bar shows region/route/channel dropdowns; "Saved views (0) ▾" present; total reads `~3,300 customers` |
| Supervisor (`ahmed.alndabi` / `Ahmed-NMWC-2026!`) | /approvals | "Approval queue — 0 pending" (or any leftover test edits) |
| Salesman C1 (`c1-12345-nmwc` / `C1-12345-NMWC`) | /today | Today's visits load; tap any customer → profile opens |

If any role shows a 500 / blank page / authentication loop, stop and tell me before launching.

---

## 5. Verify the perf-probe endpoint (30 sec)

Logged in as pilot.steward or pilot.manager, open in a new tab:
```
https://nmwc-cm.vercel.app/api/perf-probe
```

Expected JSON values:
- `totalMs`: under **400ms** on second hit
- `customer.findMany`: under **80ms**
- `getAllActive*` and `getAllHierarchyUsers`: **0–5ms** (cached)

If reference-data timings are still triple-digit on the second hit, the `unstable_cache` isn't being read — flag to me.

---

## 6. R2 photo bucket health (30 sec)

Open: https://dash.cloudflare.com/a5cc755aea210134949be8fcc1146819/r2/default/buckets/nmwc-photos

Confirm:
- Bucket exists and shows ~3,300 photos (rough — varies)
- Lifecycle rule for `gc-marked=true → 7 days` is visible under Settings
- Object versioning toggle (manual step if you haven't done it yet)

If lifecycle is missing, soft-deleted photos won't auto-expire — not urgent for launch day.

---

## 7. Test phone is on a real Android (1 min)

On your phone:
- Open https://nmwc-cm.vercel.app in Chrome
- Log in as a salesman
- Open one of your customers
- Tap **Enrich**
- Tap a photo slot — camera should open
- Take any photo of the floor
- Confirm the slot turns green with the photo overlay within ~5 sec

If photo upload fails on your phone right now, it will fail for the salesmen too — debug before they head out.

---

## 8. Brief your three real users (1 min)

Print and hand to each:
- Salesman: `docs/guide/NMWC-Salesman-Guide-EN.pdf` (or `-AR.pdf` if Arabic-preferred)
- Supervisor: `docs/guide/NMWC-Supervisor-Guide-EN.pdf` (or `-AR.pdf`)
- Manager: `docs/guide/NMWC-Manager-Guide-EN.pdf` (or `-AR.pdf`)

Remind them:
- **Forgot password** → message the manager, not me
- **App is slow** → wait 5 sec, the keep-warm catches up
- **Photo failed** → tap **Retry upload** (don't retake)

---

## If anything goes red

| Symptom | First action |
|---|---|
| Site returns 500 | `npx vercel --prod --yes` to re-deploy. If still 500, check Vercel logs. |
| Login keeps redirecting | Check `AUTH_SECRET` is set in Vercel envs. Re-deploy. |
| Photo upload fails | Test it yourself first. If still broken, look at R2 CORS in Cloudflare dashboard. |
| Salesman can't see their customers | Open `/users` → confirm their `ownedRouteId` is set correctly. |
| Slow pages | Trigger keep-warm cron manually (step 2). |

If something more serious — page renders blank, data missing, dashboard wrong — pause the rollout and tell me. Don't push more salesmen onto a broken system.

---

**At end of day 1**, tell me:
- Number of edits submitted
- Number approved / rejected
- Any error any user mentioned
- The slowest page from a salesman's perspective

I'll adjust based on what we learn.
