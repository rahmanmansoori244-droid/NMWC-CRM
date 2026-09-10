# NMWC go-live import templates

Two Excel files to fill and hand back. They are generated to match **exactly** the columns the importer reads (guarded by `tests/unit/import-templates.test.ts` against the app's real parser). Regenerate with `npx tsx scripts/build-import-templates.ts`.

| File | What it loads | Import as |
|---|---|---|
| `account-master-template.xlsx` | Regions, Routes, People (salesmen, supervisors, accountants, finance manager, GM, viewers) | Steward → **Import → Account master** |
| `customer-master-template.xlsx` | Customers + their branches | Steward → **Import → Customer master** |

## Do it in this order
1. **Create the MANAGER and STEWARD accounts in the app first** (`/users`) — the import cannot create those two roles (a safety rule so nobody mints an admin from a spreadsheet). On a brand-new database there is no account that can create a Steward yet: run `scripts/golive/bootstrap-accounts.ts` once (see `docs/GO-LIVE-RUNBOOK.md`) — it creates the Steward and the Managers with a forced password change at first login.
2. **Import the Account master** (regions → routes → people; the app auto-orders supervisors before salesmen).
3. **Import the Customer master** → review the staged rows → **Promote**.

Re-importing is safe (idempotent): existing users keep their password/role/supervisor unless you explicitly say otherwise.

### What Promote looks like on a full-size master
A real master (thousands of rows) is **far too big to load in one request**, so Promote works through it in passes and shows live progress — *"Promoting… 1,200 done, 2,100 left"*. Leave the tab open; it drives the passes for you.

It is safe to interrupt. Everything already promoted is committed, and the batch page will show **Promote interrupted** with a **Resume promote** button that picks up exactly where it stopped — nothing is loaded twice and nothing is skipped. Only one person can promote a batch at a time; a second attempt is told to wait.

---

## 1. Account master (`account-master-template.xlsx`)
Three sheets, named exactly **Regions**, **Routes**, **Users** (plus an Instructions tab you can ignore). Delete the yellow example rows before importing.

### Regions
| Column | Required | Notes |
|---|---|---|
| `code` | ✅ | Short UPPERCASE code (2–20, `A–Z 0–9 - _`), e.g. `MCT`. **The customer master's `sales_region` matches this code.** |
| `name` | ✅ | Display name, e.g. `Muscat`. |

### Routes
| Column | Required | Notes |
|---|---|---|
| `code` | ✅ | UPPERCASE code, e.g. `MCT-01`. **The customer master's `route` matches this code.** |
| `name` | ✅ | Display name. |
| `region_code` | ✅ | A code from the Regions sheet. |

### Users
| Column | Required | Notes |
|---|---|---|
| `username` | ✅ | lowercase, 1–50, `a–z 0–9 . _ -`. Unique login (salesmen: the route code). |
| `full_name` | ✅ | |
| `role` | ✅ | one of `SALESMAN`, `SUPERVISOR`, `ACCOUNTANT`, `FINANCE_MANAGER`, `GM`, `VIEWER`. (MANAGER/STEWARD → create in `/users`.) |
| `password` | ✅ for **new** users | 12+ chars. Blank for existing users = keep current. |
| `supervisor_username` | ✅ for SALESMAN | another `username` on this sheet. Blank on re-import = keep existing. |
| `route_code` | ✅ for SALESMAN | a Routes `code`. One salesman per route. |
| `region_codes` | ✅ for ACCOUNTANT (and MANAGER) | comma-separated Region codes, e.g. `MCT,BAT`. Without it the accountant sees no approvals and the credit chain stalls. For a MANAGER the row must refer to an account that **already exists** (created in `/users`); the import then assigns their regions — it never creates a manager. |
| `email`, `phone` | optional | |
| `reset_password` | optional | `yes` to rotate an existing user's password (also fill `password`). |
| `change_role` | optional | `yes` to change an existing user's role. |
| `must_change_password` | optional | `yes` forces the person to choose a new password at first login. Only then is a short initial password (4+) accepted — the one they choose must be 12+. |

---

## 2. Customer master (`customer-master-template.xlsx`)
One sheet named **Customers** (must stay the first sheet) + an Instructions tab. Delete the yellow example rows.

**One row per branch.** A customer with 3 branches = 3 rows sharing the same `cust_code` (different `branch_code`). Sharing a phone/CR across a customer's own branches is fine.

| Column | Required | Notes |
|---|---|---|
| `cust_code` | ✅ | Customer identity (ERP/Temix code). Repeat to add branches. |
| `cust_name` | ✅ | Legal / trading name. |
| `branch_code` | optional | e.g. `01`; a bare code is auto-composed to `<cust_code>-01`. Unique within the customer. |
| `branch_name` | optional | |
| `sales_region` | recommended | ⚠ the region **CODE** (e.g. `MCT`), not the name — must match a Regions code. Blank/unknown → parked in **UNASSIGNED**. |
| `route` | recommended | ⚠ the route **CODE** (e.g. `MCT-01`). Decides which salesman owns the branch. Blank/unknown → UNASSIGNED. |
| `address` | optional | |
| `phone` | optional | 7–20 chars: digits `+ - ( )` spaces. Same phone on **different** customers → flagged for review. |
| `contact_person` | optional | |
| `cr_no` | optional | Commercial registration. Same CR on **different** customers → flagged for review. |
| `payment_terms` | optional | `CASH` or `CREDIT` (default `CASH`). |
| `credit_limit` | for CREDIT | number, OMR, up to 3 decimals. |
| `payment_term_days` | for CREDIT | whole number 0–365. |
| `temix_code` | optional | the Temix ERP code (links CRM ↔ Temix). Blank if not yet in Temix. |
| `channel` | optional | the CRM channel **code**: `HORECA`, `MODERN_TRADE`, `GENERAL_TRADE`, `CONVENIENCE_AND_GAS`, `ECOMMERCE`, `HOME_OFFICE_DELIVERY`, `INSTITUTIONS`. Anything else → held for review. |
| `day_of_visit` | optional | the journey-plan visit day for this branch: `SAT` `SUN` `MON` `TUE` `WED` `THU` `FRI`. Drives the salesman's **Today** list. |
| `customer_status` | optional | `ACTIVE` (default) or `CLOSED`. A customer with any ACTIVE branch stays ACTIVE. |

### Not in this file (captured later, in the app, by the salesman)
GPS, sub-channel, cooler / stand / bottle counts, photos, alternate phone, contact role. Don't add columns for these — they're ignored on import.

> ⚠ The single most common mistake: putting region/route **names** in `sales_region`/`route`. They must be the **codes** from your Account master.
