'use server';

import { prisma } from '@/lib/db';
import { isTransientDbError } from '@/lib/db-errors';
import {
  Role,
  ImportRowState,
  type Prisma,
  type DayOfWeek,
  type CustomerStatus,
} from '@prisma/client';
import { auth } from '@/lib/auth';
import {
  ForbiddenError,
  ValidationError,
  RateLimitError,
  runAction,
  type SafeAction,
} from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { parseWorkbook } from '@/lib/excel';
import { normalizePhone, isValidPhoneFormat } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { formatCustomerCode, formatBranchCode } from '@/lib/codes';
import { checkLimit } from '@/lib/rate-limit';
import { scoreCustomer } from '@/lib/completeness';
import bcrypt from 'bcryptjs';
import { logger } from '@/lib/logger';
import { notifyUsers } from '@/lib/notifications';
import { randomUUID } from 'node:crypto';
import { getAuditEnvelope, writeAudit } from '@/lib/audit';

// RBAC-05-009 / PRD §4: import is Steward-only. The previous lax gate accepted
// MANAGER too, conflating Steward (master-data ops) and Manager (people ops)
// privileges and opening CHAIN-09 (mint Manager via import). Tighten to
// STEWARD only; an emergency Manager-driven import can still happen via a
// Steward-aided session.
async function requireSteward() {
  const session = await auth();
  if (!session?.user) throw new ForbiddenError('Not signed in.');
  if (session.user.role !== Role.STEWARD) {
    throw new ForbiddenError('Only the Data Steward can run imports.');
  }
  return session.user;
}

/**
 * F-05 / QA-029 — strip HTML tags before persisting any user-supplied text
 * field. Mirrors the same helper used on the edit form (lib/validation/edit).
 * Without this, an import row carrying `legalName="<script>…</script>"` lands
 * in the master verbatim, then propagates back through Excel exports and JSON
 * audit-log views.
 */
function stripHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * F-05 — refuse cells whose value starts with a spreadsheet formula trigger
 * (`=`, `+`, `-`, `@`, tab, CR). Matches the export-side escape but applied
 * on the way IN so the data in the master is never hostile to begin with.
 */
function isFormulaPayload(s: unknown): boolean {
  const v = String(s ?? '').trim();
  return v.length > 0 && /^[=+\-@\t\r]/.test(v);
}

// ── Account master import (regions, routes, users) ────────────────────────
//
// Expected sheets (any subset, in this order of dependencies):
//   1. "Regions"   — columns: code, name
//   2. "Routes"    — columns: code, name, region_code
//   3. "Users"     — columns: username, full_name, role, password,
//                                 supervisor_username (opt), route_code (opt for SALESMAN),
//                                 region_codes (opt comma-separated for MANAGER), email (opt), phone (opt)

// The account-master import is a STEWARD-only bulk provisioning path (requireSteward
// at the call site), so — unlike the Manager-driven /users UI — it may also mint the
// credit-approver tier (ACCOUNTANT/FINANCE_MANAGER/GM). Without them a fresh org has
// no way to bulk-load approvers and the create chains cannot complete.
const VALID_ROLES: Role[] = [
  Role.SALESMAN,
  Role.SUPERVISOR,
  Role.MANAGER,
  Role.STEWARD,
  Role.VIEWER,
  Role.ACCOUNTANT,
  Role.FINANCE_MANAGER,
  Role.GM,
];

function lc(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toLowerCase();
}
function uc(v: unknown): string {
  return String(v ?? '')
    .trim()
    .toUpperCase();
}

// QA-012: hard cap on uploaded xlsx (zip-bomb defense)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

// Accepted codes for the go-live enrichment columns (see uploadCustomerMasterCore).
const DAY_CODES = new Set(['SAT', 'SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI']);
const STATUS_CODES = new Set(['ACTIVE', 'CLOSED', 'SUSPENDED']);

export async function uploadAccountMasterAction(
  formData: FormData
): SafeAction<{ batchId: string; clean: number; issues: number }> {
  return runAction(() => uploadAccountMasterCore(formData));
}

async function uploadAccountMasterCore(
  formData: FormData
): Promise<{ batchId: string; clean: number; issues: number }> {
  const me = await requireSteward();
  // One envelope for the whole upload: read the request headers once, up front,
  // before the row loop and before anything opens a transaction.
  const env = await getAuditEnvelope(me.id);
  // F-07: same rate-limit as customer master.
  const lim = await checkLimit(`import:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) {
    throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another import.`);
  }
  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError({ file: 'No file uploaded.' });
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError({
      file: `File is too large (${Math.round(file.size / 1024)} KB). Maximum is 5 MB.`,
    });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  let sheets;
  try {
    sheets = await parseWorkbook(buf);
  } catch (err) {
    throw new ValidationError({ file: `Could not read .xlsx: ${(err as Error).message}` });
  }

  const batch = await prisma.importBatch.create({
    data: {
      filename: file.name,
      kind: 'ACCOUNT',
      uploadedById: me.id,
      status: 'PARSING',
      totalRows: sheets.reduce((acc, s) => acc + s.rows.length, 0),
    },
  });

  const issues: { sheet: string; row: number; message: string }[] = [];
  let cleanCount = 0;

  // 1) Regions
  const regionsSheet = sheets.find((s) => s.name.toLowerCase() === 'regions');
  if (regionsSheet) {
    for (const [i, row] of regionsSheet.rows.entries()) {
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      if (!code || !name) {
        issues.push({ sheet: 'Regions', row: i + 2, message: 'code and name required' });
        continue;
      }
      try {
        await prisma.region.upsert({
          where: { code },
          update: { name },
          create: { code, name },
        });
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Regions', row: i + 2, message: (err as Error).message });
      }
    }
  }

  // 2) Routes
  const routesSheet = sheets.find((s) => s.name.toLowerCase() === 'routes');
  if (routesSheet) {
    for (const [i, row] of routesSheet.rows.entries()) {
      const code = uc(row.code ?? row.Code);
      const name = String(row.name ?? row.Name ?? '').trim();
      const regionCode = uc(row.region_code ?? row.regionCode ?? row.region);
      if (!code || !name || !regionCode) {
        issues.push({
          sheet: 'Routes',
          row: i + 2,
          message: 'code, name, region_code required',
        });
        continue;
      }
      const region = await prisma.region.findUnique({ where: { code: regionCode } });
      if (!region) {
        issues.push({ sheet: 'Routes', row: i + 2, message: `region "${regionCode}" not found` });
        continue;
      }
      try {
        await prisma.route.upsert({
          where: { code },
          update: { name, regionId: region.id },
          create: { code, name, regionId: region.id },
        });
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Routes', row: i + 2, message: (err as Error).message });
      }
    }
  }

  // 3) Users (two passes — supervisors first, then everyone else linking by username)
  const usersSheet = sheets.find((s) => s.name.toLowerCase() === 'users');
  if (usersSheet) {
    // Keep each row's ORIGINAL spreadsheet position so error messages point at
    // the real row (we process supervisors first, but 'row N' must still be the
    // line the steward sees in Excel). sheetRow = original index + 2 (header).
    const sortedRows = usersSheet.rows
      .map((row, origIdx) => ({ row, sheetRow: origIdx + 2 }))
      .sort((a, b) => {
        const order = ['MANAGER', 'STEWARD', 'SUPERVISOR', 'SALESMAN', 'VIEWER'];
        return order.indexOf(uc(a.row.role)) - order.indexOf(uc(b.row.role));
      });
    for (const { row, sheetRow } of sortedRows) {
      const username = lc(row.username);
      const fullName = String(row.full_name ?? row.fullName ?? row.name ?? '').trim();
      const roleStr = uc(row.role);
      const passwordRaw = String(row.password ?? '').trim();
      // QA-010: passwords must be EXPLICITLY requested via reset_password column,
      // OR provided ONLY for new users. Existing users keep their existing hash.
      const wantsReset =
        String(row.reset_password ?? row.resetPassword ?? '')
          .trim()
          .toLowerCase() === 'yes';
      // QA-011: role changes must be EXPLICITLY requested via change_role column.
      const wantsRoleChange =
        String(row.change_role ?? row.changeRole ?? '')
          .trim()
          .toLowerCase() === 'yes';
      const supUsername = lc(row.supervisor_username ?? row.supervisorUsername ?? '');
      const routeCode = uc(row.route_code ?? row.routeCode ?? '');
      const regionCodesRaw = String(row.region_codes ?? row.regionCodes ?? '').trim();
      const email = String(row.email ?? '').trim() || null;
      const phone = String(row.phone ?? '').trim() || null;
      // Go-live credential policy: a row may force the person to choose a new
      // password at first login (AUTH-09). Only then is a SHORT initial password
      // accepted — the change-password screen enforces the 12-character rule on
      // the one they pick, so the weak value never outlives the first sign-in.
      const mustChange = /^(yes|true|1)$/i.test(
        String(row.must_change_password ?? row.mustChangePassword ?? '').trim()
      );

      if (!username || !fullName || !roleStr) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: 'username, full_name, role required',
        });
        continue;
      }
      if (!VALID_ROLES.includes(roleStr as Role)) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: `role "${roleStr}" not one of ${VALID_ROLES.join(', ')}`,
        });
        continue;
      }
      if (passwordRaw && passwordRaw.length < (mustChange ? 4 : 12)) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: mustChange
            ? 'password must be 4+ chars (it is replaced at first login)'
            : 'password must be 12+ chars (or set must_change_password=yes)',
        });
        continue;
      }

      const role = roleStr as Role;

      // F-02 (Critical) — close THREE bypasses of QA-011:
      //
      // (a) Self-promotion guarded by id (not username). The previous string-
      //     compare on `username === me.username` failed when the calling
      //     Steward's username had different casing in DB or when the import
      //     row used a renamed username; both let the Steward escalate.
      //
      // (b) Steward cannot mint or upgrade a user to MANAGER or STEWARD by
      //     ANY path (new user OR existing). Promotion into the admin tier
      //     must go through the in-app `/users` UI run by an existing
      //     Manager. This blocks the "rogue Steward → rogue Manager →
      //     rubber-stamp every region's edits" CHAIN-01.
      //
      // (c) Steward cannot demote a peer Manager or Steward via import.
      //
      // We compare the incoming row's username case-insensitively against
      // the existing User.id's username so case differences don't bypass.
      const targetExisting = await prisma.user.findUnique({
        where: { username },
        select: { id: true, role: true, isActive: true },
      });
      const isSelf = targetExisting?.id === me.id;

      if (isSelf && wantsRoleChange && role !== me.role) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: 'cannot change your own role via import',
        });
        continue;
      }
      // (b) New MANAGER / STEWARD via import — refuse outright. Forces the
      // Manager-driven /users UI for any admin-tier creation.
      if (!targetExisting && (role === Role.MANAGER || role === Role.STEWARD)) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message: 'creating MANAGER or STEWARD via import is not permitted — use the Users UI',
        });
        continue;
      }
      // (b)/(c) Promote-to or mutate an existing admin via import — refuse.
      if (
        targetExisting &&
        wantsRoleChange &&
        (role === Role.MANAGER ||
          role === Role.STEWARD ||
          targetExisting.role === Role.MANAGER ||
          targetExisting.role === Role.STEWARD) &&
        targetExisting.role !== role
      ) {
        issues.push({
          sheet: 'Users',
          row: sheetRow,
          message:
            'promoting/demoting MANAGER or STEWARD via import is not permitted — use the Users UI',
        });
        continue;
      }
      let supervisorId: string | null = null;
      if (supUsername) {
        const sup = await prisma.user.findUnique({ where: { username: supUsername } });
        if (!sup) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message: `supervisor "${supUsername}" not found`,
          });
          continue;
        }
        supervisorId = sup.id;
      }

      let ownedRouteId: string | null = null;
      if (role === Role.SALESMAN) {
        if (!routeCode) {
          issues.push({ sheet: 'Users', row: sheetRow, message: 'salesman needs route_code' });
          continue;
        }
        const route = await prisma.route.findUnique({ where: { code: routeCode } });
        if (!route) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message: `route "${routeCode}" not found`,
          });
          continue;
        }
        // F-18: audit any silent ownedRoute reassignment so the Manager has a
        // forensic trail of "salesman.X used to own this route, salesman.Y
        // owns it now". Previously the displaced owner was detached without
        // any record, leaving a confused salesman with an empty /today.
        const displacedOwners = await prisma.user.findMany({
          where: { ownedRouteId: route.id, NOT: { username } },
          select: { id: true, username: true },
        });
        if (displacedOwners.length > 0) {
          await prisma.user.updateMany({
            where: { ownedRouteId: route.id, NOT: { username } },
            data: { ownedRouteId: null },
          });
          // A loop, not createMany: writeAudit is the only writer of ip and
          // userAgent and it writes one row at a time. That costs nothing here —
          // User.ownedRouteId is @unique, so at most ONE user can own a route
          // and this list is 0 or 1 rows by construction.
          for (const u of displacedOwners) {
            await writeAudit(null, env, {
              action: 'REASSIGN',
              entityType: 'User',
              entityId: u.id,
              before: { ownedRouteCode: routeCode } as unknown as Prisma.InputJsonValue,
              after: { ownedRouteCode: null } as unknown as Prisma.InputJsonValue,
              reason: `route ${routeCode} reassigned to ${username} via import`,
            });
          }
        }
        ownedRouteId = route.id;
      }

      // QA-010 / QA-011: only set passwordHash + role on INSERT or when
      // explicitly requested. On a normal re-import, existing users keep
      // their existing password and role.
      const existing = targetExisting
        ? await prisma.user.findUnique({ where: { username } })
        : null;
      let passwordHash: string;
      if (existing) {
        if (wantsReset) {
          if (!passwordRaw) {
            issues.push({
              sheet: 'Users',
              row: sheetRow,
              message: 'reset_password=yes but no password provided',
            });
            continue;
          }
          passwordHash = await bcrypt.hash(passwordRaw, 12);
        } else {
          passwordHash = existing.passwordHash;
        }
      } else {
        if (!passwordRaw) {
          issues.push({
            sheet: 'Users',
            row: sheetRow,
            message: 'new user needs a password',
          });
          continue;
        }
        passwordHash = await bcrypt.hash(passwordRaw, 12);
      }

      const update: Prisma.UserUpdateInput = {
        fullName,
        email,
        phone,
        // ownedRoute: a SALESMAN row always carries a resolved route (rows without
        // one continue'd above); a non-SALESMAN owns no route, so clear it (this
        // also correctly drops the route when a salesman is promoted).
        ownedRoute: ownedRouteId ? { connect: { id: ownedRouteId } } : { disconnect: true },
      };
      // A BLANK supervisor_username on a re-import means "keep the existing
      // supervisor" (mirrors the QA-010 password rule) — NOT unlink. A blank
      // column silently detaching a salesman's supervisor was a data-loss
      // footgun. supUsername present ⇒ supervisorId already resolved above.
      if (supUsername) update.supervisor = { connect: { id: supervisorId! } };
      // Only rotate password / role when explicitly authorised. A password reset
      // MUST also revoke live sessions (sessionsRevokedAt) so the old credential
      // cannot keep a session alive — same as services/users.ts resetPasswordCore.
      if (wantsReset) {
        update.passwordHash = passwordHash;
        update.sessionsRevokedAt = new Date();
      }
      if (mustChange) update.mustChangePassword = true;
      if (!existing || wantsRoleChange) update.role = role;

      const data: Prisma.UserCreateInput = {
        username,
        passwordHash,
        fullName,
        role,
        email,
        phone,
        mustChangePassword: mustChange,
      };
      if (supervisorId) data.supervisor = { connect: { id: supervisorId } };
      if (ownedRouteId) data.ownedRoute = { connect: { id: ownedRouteId } };

      try {
        const user = await prisma.user.upsert({
          where: { username },
          update,
          create: data,
        });
        // Audit any sensitive change. Not swallowed, and deliberately so: these
        // sit inside the per-row try/catch, so a failed insert becomes a
        // quarantined row the Steward sees rather than a silent gap in the
        // credential-change trail.
        if (existing && wantsReset) {
          await writeAudit(null, env, {
            action: 'UPDATE',
            entityType: 'User',
            entityId: user.id,
            reason: 'password_reset_via_import',
          });
        }
        if (existing && wantsRoleChange && existing.role !== role) {
          await writeAudit(null, env, {
            action: 'UPDATE',
            entityType: 'User',
            entityId: user.id,
            before: { role: existing.role } as unknown as Prisma.InputJsonValue,
            after: { role } as unknown as Prisma.InputJsonValue,
            reason: 'role_change_via_import',
          });
        }

        // Region assignments for the region-scoped roles. MANAGER and ACCOUNTANT
        // both scope via the SAME managedRegions relation (fail-closed on empty),
        // so an accountant loaded from the master must get its region_codes too —
        // otherwise it sees nothing and can never clear the credit-chain step.
        if ((role === Role.MANAGER || role === Role.ACCOUNTANT) && regionCodesRaw) {
          const codes = regionCodesRaw
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean);
          const regions = await prisma.region.findMany({ where: { code: { in: codes } } });
          await prisma.user.update({
            where: { id: user.id },
            data: { managedRegions: { set: regions.map((r) => ({ id: r.id })) } },
          });
        }
        cleanCount++;
      } catch (err) {
        issues.push({ sheet: 'Users', row: sheetRow, message: (err as Error).message });
      }
    }
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: 'PROMOTED',
      cleanRows: cleanCount,
      quarantinedRows: issues.length,
      promotedRows: cleanCount,
    },
  });

  // Persist issues as ImportRow rows for review
  if (issues.length > 0) {
    await prisma.importRow.createMany({
      data: issues.map((iss, idx) => ({
        batchId: batch.id,
        rowNumber: idx + 1,
        raw: iss as unknown as Prisma.InputJsonValue,
        state: ImportRowState.QUARANTINED,
        issues: [{ message: iss.message, sheet: iss.sheet, row: iss.row }] as Prisma.InputJsonValue,
      })),
    });
  }

  // F-19: per-batch audit summary for the Account master too.
  //
  // DG-06/07: the swallow STAYS here, unlike the exports. This is a summary, not
  // the only record — ImportBatch above already carries status PROMOTED and the
  // three counters, and the quarantined rows are persisted as ImportRow. It also
  // runs after everything has committed, so throwing would tell the Steward a
  // fully-successful import failed; the natural re-run would re-hash passwords,
  // re-stamp sessionsRevokedAt and re-displace route owners. But it no longer
  // swallows SILENTLY — a lost summary is now visible in the logs.
  await writeAudit(null, env, {
    action: 'IMPORT',
    entityType: 'ImportBatch',
    entityId: batch.id,
    after: {
      kind: 'ACCOUNT',
      clean: cleanCount,
      issues: issues.length,
    } as unknown as Prisma.InputJsonValue,
    reason: 'account_master_upload',
  }).catch((e) => {
    logger.warn({ err: (e as Error).message?.slice(0, 80) }, 'import.audit_failed');
  });

  logger.info(
    { batchId: batch.id, clean: cleanCount, issues: issues.length },
    'import.account.complete'
  );
  revalidatePath('/import');
  return { batchId: batch.id, clean: cleanCount, issues: issues.length };
}

// ── Customer master import ─────────────────────────────────────────────────
// Single sheet (default first) with at least: cust_code, cust_name.
// Optional: branch_code, branch_name, sales_region, route, address, phone,
//           contact_person, cr_no, payment_terms (CASH/CREDIT).
//
// Behavior:
//   - Each row is one branch. Multiple rows with same cust_code create one
//     parent customer + many branches.
//   - Customers without sales_region/route map to "UNASSIGNED" route.
//   - Phone is normalized; phone collision across DIFFERENT cust_codes is flagged.
//
// Strategy: parse-only (rows go into ImportRow as PENDING). Steward then
// promotes a batch when ready. v1.1 will add an inline review screen; for
// now, we expose a "promote" action that creates customers in bulk.

export async function uploadCustomerMasterAction(
  formData: FormData
): SafeAction<{ batchId: string; clean: number; quarantined: number }> {
  return runAction(() => uploadCustomerMasterCore(formData));
}

async function uploadCustomerMasterCore(
  formData: FormData
): Promise<{ batchId: string; clean: number; quarantined: number }> {
  const me = await requireSteward();
  // F-07: rate-limit imports per Steward. Two Stewards racing the same file
  // (or a single Steward double-tapping the upload button) was previously
  // unguarded and led to interleaved upserts.
  const lim = await checkLimit(`import:${me.id}`, { capacity: 3, refillPerSec: 0.05 });
  if (!lim.ok) {
    throw new RateLimitError(`Wait ${lim.retryAfterSec}s before another import.`);
  }
  const file = formData.get('file');
  if (!(file instanceof File)) throw new ValidationError({ file: 'No file uploaded.' });
  if (file.size > MAX_IMPORT_BYTES) {
    throw new ValidationError({
      file: `File is too large (${Math.round(file.size / 1024)} KB). Maximum is 5 MB.`,
    });
  }
  const buf = Buffer.from(await file.arrayBuffer());

  let sheets;
  try {
    sheets = await parseWorkbook(buf);
  } catch (err) {
    throw new ValidationError({ file: `Could not read .xlsx: ${(err as Error).message}` });
  }
  const sheet = sheets[0];
  if (!sheet || sheet.rows.length === 0) {
    throw new ValidationError({ file: 'Workbook is empty.' });
  }

  const batch = await prisma.importBatch.create({
    data: {
      filename: file.name,
      kind: 'CUSTOMER',
      uploadedById: me.id,
      status: 'PARSING',
      totalRows: sheet.rows.length,
    },
  });

  const importRows: Prisma.ImportRowCreateManyInput[] = [];
  let clean = 0;
  let quarantined = 0;
  // F-04: build collision maps inside the file + against the live master so
  // the parse step queues duplicates for review instead of silently
  // P2002-failing on promote.
  // Each occurrence carries its owning cust_code so a legitimate MULTI-BRANCH
  // customer — whose branch rows repeat the SAME phone/CR (exactly how promote
  // groups branch rows by cust_code into one customer) — is not flagged against
  // ITSELF. Only a value shared across DIFFERENT cust_codes is an in-file
  // duplicate, mirroring the master cross-check's `code !== custCode` exclusion.
  // Before this, importing a real master quarantined every multi-branch customer
  // (F-UAT-7: the medium synthetic master lost 324/499 rows this way).
  type FileDup = { row: number; code: string };
  const phonesInFile = new Map<string, FileDup[]>();
  const crsInFile = new Map<string, FileDup[]>();
  // Accepted `channel` codes — the Channel table's keys, read once per upload.
  const channelKeys = new Set(
    (await prisma.channel.findMany({ select: { key: true } })).map((c) => c.key.toUpperCase())
  );
  for (const [i, row] of sheet.rows.entries()) {
    const rowCode = stripHtml(
      row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code
    ).trim();
    const phoneNorm = normalizePhone(
      String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
    );
    if (phoneNorm) {
      const a = phonesInFile.get(phoneNorm) ?? [];
      a.push({ row: i + 2, code: rowCode });
      phonesInFile.set(phoneNorm, a);
    }
    const crNorm = normalizeCR(String(row.cr_no ?? row['CR NO'] ?? '').trim() || null);
    if (crNorm) {
      const a = crsInFile.get(crNorm) ?? [];
      a.push({ row: i + 2, code: rowCode });
      crsInFile.set(crNorm, a);
    }
  }
  // Cross-check against the live master in one query each. Keyed by the
  // OWNING nmwcCode so a row that updates its own customer (a re-import or a
  // Temix refresh of the existing master) does not self-collide — previously
  // this used bare Sets and every refresh row of a known customer was
  // quarantined against itself.
  const phoneList = [...phonesInFile.keys()];
  const crList = [...crsInFile.keys()];
  const masterPhones = new Map<string, string[]>();
  if (phoneList.length) {
    for (const c of await prisma.customer.findMany({
      where: { primaryPhoneNorm: { in: phoneList }, deletedAt: null },
      select: { primaryPhoneNorm: true, nmwcCode: true },
    })) {
      if (!c.primaryPhoneNorm) continue;
      const a = masterPhones.get(c.primaryPhoneNorm) ?? [];
      a.push(c.nmwcCode);
      masterPhones.set(c.primaryPhoneNorm, a);
    }
  }
  const masterCrs = new Map<string, string[]>();
  if (crList.length) {
    for (const c of await prisma.customer.findMany({
      where: { crNumberNorm: { in: crList }, deletedAt: null },
      select: { crNumberNorm: true, nmwcCode: true },
    })) {
      if (!c.crNumberNorm) continue;
      const a = masterCrs.get(c.crNumberNorm) ?? [];
      a.push(c.nmwcCode);
      masterCrs.set(c.crNumberNorm, a);
    }
  }

  for (const [i, row] of sheet.rows.entries()) {
    const issues: { field: string; message: string }[] = [];
    // F-05: stripHtml on every text field at parse time so nothing hostile
    // reaches the master. Then re-screen for spreadsheet formula prefixes.
    const custCode = stripHtml(
      row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code
    ).trim();
    const custName = stripHtml(row.cust_name ?? row['CUST NAME'] ?? row.name);
    // Read the SAME header fallbacks as normalizePhone below — otherwise a phone
    // supplied in the 'PHONE' or 'Primary Phone' column skipped the format check
    // entirely (an invalid number in those columns was silently accepted).
    const phoneRaw = String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim();
    const phone = normalizePhone(
      String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
    );
    const crNorm = normalizeCR(String(row.cr_no ?? row['CR NO'] ?? '').trim() || null);

    if (!custCode) issues.push({ field: 'cust_code', message: 'required' });
    if (!custName) issues.push({ field: 'cust_name', message: 'required' });
    if (phoneRaw && !isValidPhoneFormat(phoneRaw)) {
      issues.push({ field: 'phone', message: 'invalid format' });
    }
    // In-file dup only when the SAME phone/CR appears under a DIFFERENT
    // cust_code — a multi-branch customer sharing one phone/CR across its own
    // branch rows is legitimate and must NOT self-quarantine (F-UAT-7).
    const phoneOtherRows = phone
      ? (phonesInFile.get(phone) ?? []).filter((e) => e.code !== custCode).map((e) => e.row)
      : [];
    if (phoneOtherRows.length > 0) {
      issues.push({
        field: 'phone',
        message: `duplicate phone in this file (also rows ${phoneOtherRows.join(', ')})`,
      });
    }
    if (phone && (masterPhones.get(phone) ?? []).some((code) => code !== custCode)) {
      issues.push({
        field: 'phone',
        message: 'phone already exists in master — review in /duplicates',
      });
    }
    const crOtherRows = crNorm
      ? (crsInFile.get(crNorm) ?? []).filter((e) => e.code !== custCode).map((e) => e.row)
      : [];
    if (crOtherRows.length > 0) {
      issues.push({
        field: 'cr_no',
        message: `duplicate CR in this file (also rows ${crOtherRows.join(', ')})`,
      });
    }
    if (crNorm && (masterCrs.get(crNorm) ?? []).some((code) => code !== custCode)) {
      issues.push({
        field: 'cr_no',
        message: 'CR already exists in master — review in /duplicates',
      });
    }
    // F-12: strict whitelist on payment terms — silently defaulting `Crdit`
    // to CASH ate the field-lock semantics for credit customers.
    // `paymentTermsPresent` records whether the sheet EXPLICITLY stated a
    // value: the Temix-refresh lane must distinguish "column absent — keep
    // the customer's current terms" from "Temix says CASH" (an absent column
    // silently flipping CREDIT customers to CASH was an adversarial-review
    // CONFIRMED finding). Legacy create/full-upsert paths keep the CASH
    // default unchanged.
    const ptRaw = String(row.payment_terms ?? row['PAYMENT TERMS'] ?? '')
      .trim()
      .toUpperCase();
    let paymentTerms = 'CASH';
    const paymentTermsPresent = ptRaw === 'CASH' || ptRaw === 'CREDIT';
    if (ptRaw && !paymentTermsPresent) {
      issues.push({ field: 'payment_terms', message: `expected CASH or CREDIT, got "${ptRaw}"` });
    } else if (ptRaw === 'CREDIT') {
      paymentTerms = 'CREDIT';
    }
    // F-05: refuse formula payloads in any text field.
    for (const field of ['cust_name', 'address', 'contact_person', 'notes']) {
      if (isFormulaPayload((row as Record<string, unknown>)[field])) {
        issues.push({
          field,
          message: 'cell starts with a spreadsheet formula trigger; remove it',
        });
      }
    }

    // Phase 1 Temix refresh columns (all optional — a plain master sheet
    // without them behaves exactly as before):
    //  - temix_code: the ERP's code for this customer. Presence marks the row
    //    as a REFRESH row at promote time (crosswalk backfill + narrow update).
    //  - credit_limit / payment_term_days: authoritatively FROM Temix
    //    (owner-locked) for existing CREDIT customers.
    const temixCode =
      stripHtml(row.temix_code ?? row.temixcode ?? row['TEMIX CODE'] ?? row['Temix Code']).trim() ||
      null;
    let creditLimit: number | null = null;
    const creditRaw = String(row.credit_limit ?? row['CREDIT LIMIT'] ?? '').trim();
    if (creditRaw) {
      const n = Number(creditRaw);
      if (!Number.isFinite(n) || n < 0 || n > 99_999_999_999) {
        issues.push({
          field: 'credit_limit',
          message: `expected a non-negative number, got "${creditRaw}"`,
        });
      } else {
        creditLimit = Math.round(n * 1000) / 1000;
      }
    }
    let paymentTermDays: number | null = null;
    const termRaw = String(row.payment_term_days ?? row['PAYMENT TERM DAYS'] ?? '').trim();
    if (termRaw) {
      const n = Number(termRaw);
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        issues.push({
          field: 'payment_term_days',
          message: `expected whole days 0-365, got "${termRaw}"`,
        });
      } else {
        paymentTermDays = n;
      }
    }

    // Go-live enrichment columns. All optional; a value that is present but not
    // one of the accepted codes holds the row for review rather than being
    // silently dropped, since each of them changes how the field team works
    // the customer (which day it is visited, whether it is closed).
    const channelRaw = uc(row.channel ?? row.CHANNEL ?? '');
    let channelKey: string | null = null;
    if (channelRaw) {
      if (channelKeys.has(channelRaw)) channelKey = channelRaw;
      else issues.push({ field: 'channel', message: `unknown channel "${channelRaw}"` });
    }
    const dayRaw = uc(row.day_of_visit ?? row['DAY OF VISIT'] ?? '');
    let dayOfVisit: string | null = null;
    if (dayRaw) {
      if (DAY_CODES.has(dayRaw)) dayOfVisit = dayRaw;
      else
        issues.push({
          field: 'day_of_visit',
          message: `expected SAT/SUN/MON/TUE/WED/THU/FRI, got "${dayRaw}"`,
        });
    }
    const statusRaw = uc(row.customer_status ?? row['CUSTOMER STATUS'] ?? '');
    let customerStatus: string | null = null;
    if (statusRaw) {
      if (STATUS_CODES.has(statusRaw)) customerStatus = statusRaw;
      else
        issues.push({
          field: 'customer_status',
          message: `expected ACTIVE/CLOSED/SUSPENDED, got "${statusRaw}"`,
        });
    }

    const parsed = {
      custCode,
      custName,
      channelKey,
      dayOfVisit,
      customerStatus,
      branchCode: stripHtml(row.branch_code ?? row['CUST BRANCH']) || null,
      branchName: stripHtml(row.branch_name ?? row['CUST BRANCH'] ?? row.branch) || null,
      regionCode: stripHtml(row.sales_region ?? row['SALES REGION'] ?? row.region) || null,
      routeCode: stripHtml(row.route ?? row['ROUTE']) || null,
      address: stripHtml(row.address ?? row.ADDRSS ?? row.ADDRESS) || null,
      phone,
      contactPerson: stripHtml(row.contact_person ?? row['CONTACT PERSON']) || null,
      crNumber: stripHtml(row.cr_no ?? row['CR NO']) || null,
      paymentTerms,
      paymentTermsPresent,
      temixCode,
      creditLimit,
      paymentTermDays,
    };

    importRows.push({
      batchId: batch.id,
      rowNumber: i + 2,
      raw: row as unknown as Prisma.InputJsonValue,
      parsed: parsed as unknown as Prisma.InputJsonValue,
      issues: issues.length > 0 ? (issues as unknown as Prisma.InputJsonValue) : undefined,
      state: issues.length > 0 ? ImportRowState.QUARANTINED : ImportRowState.CLEAN,
    });
    if (issues.length > 0) quarantined++;
    else clean++;
  }

  await prisma.importRow.createMany({ data: importRows });
  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: 'READY', cleanRows: clean, quarantinedRows: quarantined },
  });
  revalidatePath('/import');
  return { batchId: batch.id, clean, quarantined };
}

/**
 * RK-3: one call promotes as much of a batch as fits in a time slice.
 * `done` is false while CLEAN rows remain — the caller re-invokes until it is true.
 */
export type PromoteSliceResult = {
  promoted: number;
  /** customers (groups) that failed, not rows — `promoted` counts rows. */
  failed: number;
  /** rows left CLEAN because the DB faltered; the next slice retries them. */
  deferred: number;
  remaining: number;
  done: boolean;
  /**
   * Opaque continuation token. The caller MUST pass it back on the next slice: it
   * both proves this run still owns the batch (so it can carry on without waiting
   * out its own lease) and stops a run that has already lost the batch from
   * carrying on regardless. Absent once `done`.
   */
  leaseToken?: string;
};

/**
 * How long a single promote invocation may work before yielding. The budget is
 * checked between customers, so the true worst case is this PLUS one full
 * transaction (20s) plus its connection wait — sized to stay inside vercel.json's
 * `maxDuration: 60` so a slice always commits its progress instead of being killed.
 */
function promoteSliceBudgetMs(): number {
  const raw = Number(process.env.PROMOTE_SLICE_BUDGET_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  // Clamped: a misconfigured env var must not be able to push a slice past the
  // function limit (budget + one 20s transaction + its connection wait).
  return Math.min(raw, 25_000);
}
/**
 * Lease lifetime while a slice is executing. MUST exceed `maxDuration` — otherwise
 * a slice still running could have its lease expire and a second worker would start
 * on the same batch.
 */
const PROMOTE_LEASE_MS = 90_000;
/**
 * Lease lifetime BETWEEN slices of the same run. The run comes straight back (well
 * inside this), so the batch keeps reading as "in progress" rather than flickering
 * to "interrupted" between every pass — while an abandoned run still frees the
 * batch quickly instead of holding it for the full lease.
 */
const PROMOTE_HANDOFF_GRACE_MS = 20_000;

export async function promoteCustomerBatchAction(
  formData: FormData
): SafeAction<PromoteSliceResult> {
  return runAction(() => promoteCustomerBatchCore(formData));
}

async function promoteCustomerBatchCore(formData: FormData): Promise<PromoteSliceResult> {
  const me = await requireSteward();
  // One envelope per slice, read once up front — before the lease claim and
  // before the per-group interactive transaction, so no header work happens
  // while a transaction is held open (see generateTemixBatchCore).
  const env = await getAuditEnvelope(me.id);
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ batchId: 'required' });

  // Kind is checked BEFORE the claim: an ACCOUNT batch must never be moved into
  // PROMOTING (a state the customer resume path owns) just to be rejected.
  const preflight = await prisma.importBatch.findUnique({
    where: { id: batchId },
    select: { kind: true },
  });
  if (!preflight) throw new ValidationError({ batchId: 'not found' });
  if (preflight.kind !== 'CUSTOMER')
    throw new ValidationError({ batchId: 'not a customer import' });

  const now = new Date();
  // The token identifies THIS slice, not merely this user — the same steward in two
  // tabs must not be able to pass for one another. Every lease write is guarded by
  // it, so a slow worker that wakes up after its lease was taken over cannot clear
  // the new owner's lease and silently break mutual exclusion.
  const priorToken = String(formData.get('leaseToken') ?? '');
  const leaseToken = `${me.id}:${randomUUID()}`;
  // F-07 + RK-3: claim the batch atomically. This single compare-and-set covers the
  // first slice (READY → PROMOTING), a resume of an abandoned batch (PROMOTING with
  // no live lease), and this run continuing to its own next slice (matching token,
  // which is why a run need not wait out the lease it just set). Two Stewards, a
  // double-click, or a stray retry cannot interleave: exactly one caller gets count=1.
  const claim = await prisma.importBatch.updateMany({
    where: {
      id: batchId,
      OR: [
        { status: 'READY' },
        // Nothing writes FAILED any more; accepting it lets a batch left behind by
        // the old single-pass promote be recovered rather than stranded forever.
        { status: 'FAILED' },
        { status: 'PROMOTING', promoteLeaseUntil: null },
        { status: 'PROMOTING', promoteLeaseUntil: { lt: now } },
        ...(priorToken ? [{ status: 'PROMOTING' as const, promoteLeaseBy: priorToken }] : []),
      ],
    },
    data: {
      status: 'PROMOTING',
      promoteLeaseBy: leaseToken,
      promoteLeaseUntil: new Date(now.getTime() + PROMOTE_LEASE_MS),
    },
  });
  if (claim.count === 0) {
    const cur = await prisma.importBatch.findUnique({
      where: { id: batchId },
      select: { status: true, promoteLeaseUntil: true },
    });
    // A live lease is "someone is promoting right now", not "wrong state" — say so,
    // otherwise a steward watching a slow load thinks the batch is broken.
    if (cur?.status === 'PROMOTING' && cur.promoteLeaseUntil && cur.promoteLeaseUntil > now) {
      throw new ValidationError({
        batchId: 'This batch is being promoted right now — wait for it to finish, then resume.',
      });
    }
    throw new ValidationError({
      batchId: `Batch is in state ${cur?.status ?? '<missing>'} — only READY or interrupted batches can be promoted.`,
    });
  }
  // RK-3: the lease serializes ONE batch, but the QA P-01 branch-steal guard is a
  // read-then-upsert whose safety argument rests on promote being serialized across
  // the whole master ("batch promote is serialized by the atomic claim"). Two
  // DIFFERENT batches promoting at once would reopen that window — and RK-3 stretched
  // it from a single request to minutes, while actively inviting the sequence that
  // triggers it (upload a corrected sheet while the first batch is still resumable).
  // So refuse to run a second concurrent promote; fail closed.
  const otherLive = await prisma.importBatch.findFirst({
    where: {
      id: { not: batchId },
      kind: 'CUSTOMER',
      status: 'PROMOTING',
      promoteLeaseUntil: { gt: new Date() },
    },
    select: { id: true, filename: true },
  });
  if (otherLive) {
    // Release the claim we just took so this batch is not left holding a lease.
    await prisma.importBatch
      .updateMany({
        where: { id: batchId, promoteLeaseBy: leaseToken },
        data: { promoteLeaseBy: null, promoteLeaseUntil: null },
      })
      .catch(() => {});
    throw new ValidationError({
      batchId: `Another customer import ("${otherLive.filename}") is being promoted right now. Only one may run at a time — wait for it to finish, then resume this one.`,
    });
  }
  // final-hunt #23 (revised for RK-3): once claimed, any UNEXPECTED throw must not
  // leave the batch holding a lease nobody owns — it would be unresumable until the
  // lease expired. Release the lease in the catch; the batch stays PROMOTING, which
  // now means "interrupted, resumable" rather than a dead end.
  try {
    // RK-3: reference data is read ONCE per slice. It used to be a findUnique for
    // the region AND a findUnique for the route on EVERY row — 2 sequential network
    // round trips per row, which on a 3,300-row master was the single largest cost
    // in the whole promote (~6,600 queries before any work happened).
    const [allRegions, allRoutes] = await Promise.all([
      prisma.region.findMany({ select: { id: true, code: true } }),
      prisma.route.findMany({ select: { id: true, code: true, regionId: true } }),
    ]);
    const regionByCode = new Map(allRegions.map((r) => [r.code.toUpperCase(), r]));
    const routeByCode = new Map(allRoutes.map((r) => [r.code.toUpperCase(), r]));
    const channelIdByKey = new Map(
      (await prisma.channel.findMany({ select: { id: true, key: true } })).map((c) => [
        c.key.toUpperCase(),
        c.id,
      ])
    );

    // Only `parsed` is needed to promote; `raw` is the (much larger) original sheet
    // row and is never read here. Selecting it would move megabytes per slice.
    const cleanRows = await prisma.importRow.findMany({
      where: { batchId, state: ImportRowState.CLEAN },
      select: { id: true, parsed: true },
      orderBy: { rowNumber: 'asc' },
    });

    // Group rows by parent custCode
    type ParsedShape = {
      custCode: string;
      custName: string;
      branchCode: string | null;
      branchName: string | null;
      regionCode: string | null;
      routeCode: string | null;
      address: string | null;
      phone: string | null;
      contactPerson: string | null;
      crNumber: string | null;
      paymentTerms: string;
      // Phase 1 Temix refresh columns (older batches parsed before the columns
      // existed have them undefined — treat as absent).
      paymentTermsPresent?: boolean;
      temixCode?: string | null;
      creditLimit?: number | null;
      paymentTermDays?: number | null;
      // Go-live enrichment (absent on older batches).
      channelKey?: string | null;
      dayOfVisit?: string | null;
      customerStatus?: string | null;
    };
    const groups = new Map<string, { rowIds: string[]; parsed: ParsedShape[] }>();
    for (const row of cleanRows) {
      const p = row.parsed as unknown as ParsedShape | null;
      if (!p?.custCode) continue;
      const g = groups.get(p.custCode) ?? { rowIds: [], parsed: [] };
      g.rowIds.push(row.id);
      g.parsed.push(p);
      groups.set(p.custCode, g);
    }

    // Ensure the UNASSIGNED region+route pair exists — the fail-safe landing place
    // for rows whose route is unknown. Served from the maps loaded above; only the
    // very first import of a fresh database actually creates them.
    let unassignedRoute = routeByCode.get('UNASSIGNED') ?? null;
    if (!unassignedRoute) {
      let unassignedRegionId = regionByCode.get('UNASSIGNED')?.id ?? null;
      if (!unassignedRegionId) {
        const createdRegion = await prisma.region.create({
          data: { code: 'UNASSIGNED', name: 'Unassigned' },
          select: { id: true, code: true },
        });
        regionByCode.set('UNASSIGNED', createdRegion);
        unassignedRegionId = createdRegion.id;
      }
      unassignedRoute = await prisma.route.create({
        data: { code: 'UNASSIGNED', name: 'Unassigned', regionId: unassignedRegionId },
        select: { id: true, code: true, regionId: true },
      });
      routeByCode.set('UNASSIGNED', unassignedRoute);
    }

    // QA-019: each customer's promotion (parent + branches + row state) runs
    // in its own transaction so a partial failure leaves no half-state.
    // F-03: per-row failures now mark the row as REJECTED with the error
    // message in `issues`, and the action returns a `{ promoted, failed }`
    // tuple that the UI surfaces in the toast — no more silent swallow.
    let promoted = 0;
    // Rows left CLEAN because the DATABASE failed, not the data — retried next slice.
    let deferred = 0;
    const failures: Array<{ custCode: string; rowIds: string[]; reason: string }> = [];
    // RK-3: yield the slice once the budget is spent. The check is at the TOP of the
    // loop, so a slice always makes progress on at least one customer — a batch can
    // never livelock by repeatedly yielding before doing any work.
    const deadline = Date.now() + promoteSliceBudgetMs();
    let processedGroups = 0;
    for (const [custCode, g] of groups) {
      if (processedGroups > 0 && Date.now() >= deadline) break;
      processedGroups++;
      const first = g.parsed[0];

      // Pre-resolve regions and routes outside the transaction (these are upserts
      // that can be repeated safely across batches).
      const resolvedBranches: Array<{
        sheetCode: string | null;
        branchCode: string;
        branchName: string;
        regionId: string;
        routeId: string;
        address: string;
        dayOfVisit: string | null;
        status: string | null;
      }> = [];
      const groupResolveErrors: string[] = [];
      for (const [bi, p] of g.parsed.entries()) {
        // F-17: refuse to silently auto-create unknown regions/routes. Phantom
        // regions invented by typos are the source of CHAIN-09 (an unscoped
        // Manager later falls into them). Only Existing region/route codes
        // resolve; everything else falls back to UNASSIGNED with a flag in
        // the audit log so the Steward can fix.
        // RK-3: resolved from the per-slice maps, not a query per row. Reference data
        // (regions/routes) is administered by the Steward and is not mutated by this
        // loop, so a snapshot taken at the top of the slice is authoritative for it.
        const region = p.regionCode ? (regionByCode.get(p.regionCode.toUpperCase()) ?? null) : null;
        if (p.regionCode && !region) {
          groupResolveErrors.push(`region "${p.regionCode}" not found`);
        }
        const route = p.routeCode ? (routeByCode.get(p.routeCode.toUpperCase()) ?? null) : null;
        if (p.routeCode && !route) {
          groupResolveErrors.push(`route "${p.routeCode}" not found`);
        }
        // QA P-02 fix: the fallback previously used the UNASSIGNED ROUTE's id as a
        // REGION id, so the B-19 region-consistency trigger (Branch.regionId must
        // equal Route.regionId) aborted the whole group — the F-17 fallback could
        // never actually happen. Resolve trigger-consistently instead:
        //   - route known  → the route's own region is authoritative (a region
        //     that disagrees is a sheet inconsistency, warned + overridden);
        //   - route unknown → the consistent UNASSIGNED region+route pair.
        let effectiveRegionId: string;
        let effectiveRouteId: string;
        if (route) {
          effectiveRouteId = route.id;
          effectiveRegionId = route.regionId;
          if (region && region.id !== route.regionId) {
            groupResolveErrors.push(
              `region "${p.regionCode}" does not match route "${p.routeCode}" — used the route's region`
            );
          }
        } else {
          // No usable route → the consistent UNASSIGNED pair. If the row DID supply
          // a region, warn that it was dropped (region is derived from the route to
          // satisfy the B-19 trigger) so the steward can add the missing route.
          effectiveRouteId = unassignedRoute!.id;
          effectiveRegionId = unassignedRoute!.regionId;
          if (p.regionCode && region) {
            groupResolveErrors.push(
              `region "${p.regionCode}" was provided without a route — branch parked in UNASSIGNED; add a route to keep the region`
            );
          }
        }
        // QA P-01 fix (identity model: branch = custcode-branchcode, globally
        // unique): a sheet carrying a BARE suffix ('01') previously produced a
        // global branchCode '01' that collided across customers — and the upsert
        // below silently re-parented the branch to the later customer. Compose
        // bare codes under the owning custCode; already-composed codes (or a
        // code equal to the custCode itself) pass through unchanged.
        const ccUpper = custCode.toUpperCase();
        const rawBranchCode = p.branchCode ? p.branchCode.trim().toUpperCase() : null;
        resolvedBranches.push({
          // sheetCode: the code EXACTLY as the sheet gave it (null if generated).
          // The in-tx guard checks it too — a sheet code that exists under another
          // customer is a data error to review, not a code to silently re-mint.
          sheetCode: rawBranchCode,
          branchCode: rawBranchCode
            ? rawBranchCode === ccUpper || rawBranchCode.startsWith(`${ccUpper}-`)
              ? rawBranchCode
              : `${ccUpper}-${rawBranchCode}`
            : formatBranchCode(custCode, bi + 1),
          branchName: p.branchName ?? 'Main',
          regionId: effectiveRegionId,
          routeId: effectiveRouteId,
          // final-hunt #8: `[...].filter(Boolean).join(', ')` returns '' (empty
          // string, not null) when branch_name AND sales_region are both blank, and
          // `??` does NOT fall through '' — so the branch got an empty address and
          // the whole customer group was REJECTED at promote (address is required).
          // `||` falls through the empty string to the 'Address pending' placeholder.
          address:
            p.address ||
            [p.branchName, p.regionCode].filter(Boolean).join(', ') ||
            'Address pending',
          dayOfVisit: p.dayOfVisit ?? null,
          status: p.customerStatus ?? null,
        });
      }

      // QA P-03: two rows in the SAME customer group can resolve to the SAME
      // branchCode — a bare code like '03' composes to `X-03`, which also equals
      // the positional `formatBranchCode(X, 3)` produced for a codeless row, or two
      // rows may simply carry the same branch_code. The per-branch upsert is keyed
      // on the globally-unique branchCode, so the second row would silently UPDATE
      // (overwrite) the first branch — one physical branch lost, both rows marked
      // PROMOTED. There is no way to know which row is authoritative, so reject the
      // whole group to steward review rather than drop data silently.
      const seenBranchCodes = new Set<string>();
      let dupBranchCode: string | null = null;
      for (const r of resolvedBranches) {
        if (seenBranchCodes.has(r.branchCode)) {
          dupBranchCode = r.branchCode;
          break;
        }
        seenBranchCodes.add(r.branchCode);
      }
      if (dupBranchCode) {
        failures.push({
          custCode,
          rowIds: g.rowIds,
          reason: `branch_code ${dupBranchCode} appears on more than one row for this customer — steward review`,
        });
        await prisma.importRow
          .updateMany({
            where: { id: { in: g.rowIds } },
            data: {
              state: ImportRowState.REJECTED,
              issues: [
                {
                  field: '_promote',
                  message: `duplicate branch_code ${dupBranchCode} within this customer`,
                },
              ] as Prisma.InputJsonValue,
              reviewedById: me.id,
              reviewedAt: new Date(),
            },
          })
          .catch(() => undefined);
        continue;
      }

      try {
        let refreshedRow = false;
        // final-hunt #32, extended to promote: this interactive transaction makes
        // ~9 sequential round trips (customer read + upsert, per-branch ownership
        // check + upsert, row state, completeness). Prisma's DEFAULT 5s ceiling is
        // simply too tight for that over a networked Postgres — customers were
        // being rejected with P2028 ("transaction closed") purely because the link
        // was slow, which on the real master would silently drop good rows.
        // The customer's channel/status are group-level: a customer with ANY open
        // branch is ACTIVE even if its head-office row is closed.
        const groupChannelId = first.channelKey
          ? (channelIdByKey.get(first.channelKey.toUpperCase()) ?? null)
          : null;
        const groupStatus: CustomerStatus | null = g.parsed.some(
          (p) => p.customerStatus === 'ACTIVE'
        )
          ? 'ACTIVE'
          : ((first.customerStatus as CustomerStatus | null | undefined) ?? null);
        await prisma.$transaction(
          async (tx) => {
            const pt = first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH';
            const existing = await tx.customer.findUnique({
              where: { nmwcCode: custCode },
              select: {
                id: true,
                temixCode: true,
                paymentTerms: true,
                deletedAt: true,
                createdById: true,
                legalName: true,
              },
            });

            // ── Phase 1 Temix crosswalk guards (rows carrying temix_code) ──
            // Quarantine-style rejection, never silent overwrite: the crosswalk
            // is a join (owner-locked nmwcCode == temixCode for migrated rows),
            // so a code landing on a different customer, or disagreeing with an
            // already-recorded code, is Steward-review territory.
            if (first.temixCode) {
              // NO deletedAt filter (adversarial-review CONFIRMED fix): an
              // ARCHIVED customer holding this code has a DEACTIVATE for it
              // queued/in-flight — re-attaching the code to a live customer
              // would let that DEACTIVATE kill the live record in Temix.
              const codeOwner = await tx.customer.findFirst({
                where: {
                  temixCode: first.temixCode,
                  nmwcCode: { not: custCode },
                },
                select: { nmwcCode: true, deletedAt: true },
              });
              if (codeOwner) {
                throw new Error(
                  `CROSSWALK:temix_code already recorded on ${codeOwner.nmwcCode}${codeOwner.deletedAt ? ' (archived — its Temix deactivation may be in flight)' : ''} — steward review`
                );
              }
              if (existing?.temixCode && existing.temixCode !== first.temixCode) {
                throw new Error(
                  'CROSSWALK:temix_code conflicts with the code already recorded for this customer — steward review'
                );
              }
              // An archived customer must not be mutated (or its in-flight
              // deactivation settled) by a stale Temix extract that still lists
              // it — resolve the deactivation first.
              if (existing?.deletedAt) {
                throw new Error(
                  'CROSSWALK:customer is archived in the CRM — resolve its Temix deactivation before refreshing'
                );
              }
            }

            // A refresh is an inbound update from the ERP for a customer the CRM
            // ALREADY KNOWS BY A TEMIX CODE. Deciding it from the mere presence of
            // a temix_code cell was wrong in the one case that matters most.
            //
            // Every row scripts/golive/build-masters.ts emits carries temix_code —
            // it is the same string as cust_code — and production already holds
            // roughly 3,300 seeded customers keyed on the same RoutePro alternate
            // code. So on the FIRST master load every one of those rows would have
            // taken the narrow ERP lane below, which writes only the crosswalk code
            // and the credit figures and, at `if (!isRefresh)`, skips the entire
            // branch loop. The new region, route, address and day of visit would
            // never land; the salesman's Today screen would be empty or point at
            // the May route. And nothing would report it: the rows are still marked
            // PROMOTED and counted, so the step-6 reconciliation comes out clean
            // and the steward signs off on a load that did nothing for thousands of
            // customers.
            //
            // The comment further down reasoned that "a re-run finds it live with a
            // matching code and takes the refresh lane". True — but the first run
            // against a seeded database is indistinguishable from a re-run, and
            // that was never noticed. Requiring `existing.temixCode` makes the two
            // distinguishable: a customer the CRM has never crosswalked takes the
            // upsert lane, which is what a master load is.
            // The equality clause closes the other half: the "ERP authority" that
            // unlocks the credit fields below was, until now, nothing but a string
            // the spreadsheet supplied. A Steward — the one role deliberately NOT
            // on the credit chain — could put any value in temix_code and have the
            // narrow lane write paymentTerms and an arbitrary creditLimit with no
            // approver, while services/edits.ts refuses that same change on the
            // edit path. Worse, the invented code became the customer's ERP
            // identity and went out verbatim in the next Temix batch, telling the
            // ERP to upsert under a code nobody there issued.
            //
            // Requiring the code to MATCH what the CRM already recorded means the
            // authority has to have come from somewhere other than this sheet.
            // A row proposing a different code falls through to the upsert lane,
            // which writes neither temixCode nor paymentTerms, and is rejected
            // just below so a genuine crosswalk change is a deliberate act rather
            // than a cell nobody read.
            //
            // No seeded customer carries a temixCode, so neither clause changes
            // anything about the go-live load itself.
            const isRefresh =
              !!existing &&
              !existing.deletedAt &&
              !!first.temixCode &&
              !!existing.temixCode &&
              existing.temixCode === first.temixCode;

            if (
              existing &&
              !existing.deletedAt &&
              first.temixCode &&
              existing.temixCode &&
              existing.temixCode !== first.temixCode
            ) {
              throw new Error(
                'CROSSWALK:this customer is already crosswalked to a different Temix code — changing it is a deliberate re-crosswalk, not an import; steward review'
              );
            }
            refreshedRow = isRefresh;
            let customerId: string;
            if (isRefresh) {
              // ── Temix REFRESH row (existing live customer + temix_code) ──
              // Narrow, Temix-OWNED update only: crosswalk code + payment terms +
              // credit figures (owner-locked: authoritative from Temix). CRM-
              // enriched identity/contact data (legalName, phone, CR, contact)
              // and ALL branch operational data are CRM-owned — a refresh must
              // not clobber them (field-ownership matrix, sla-notif-sync §3.5).
              //
              // Presence-aware (adversarial-review CONFIRMED fix): an ABSENT
              // payment_terms column means "keep the customer's current terms" —
              // only an explicit CASH may clear credit figures, and credit
              // figures apply only while the customer is (or becomes) CREDIT.
              const ptPresent = first.paymentTermsPresent === true;
              const effectiveTerms = ptPresent ? pt : existing!.paymentTerms;
              await tx.customer.update({
                where: { id: existing!.id },
                data: {
                  temixCode: first.temixCode,
                  paymentTerms: ptPresent ? pt : undefined,
                  creditLimit:
                    effectiveTerms === 'CREDIT'
                      ? (first.creditLimit ?? undefined)
                      : ptPresent
                        ? null
                        : undefined,
                  paymentTermDays:
                    effectiveTerms === 'CREDIT'
                      ? (first.paymentTermDays ?? undefined)
                      : ptPresent
                        ? null
                        : undefined,
                  lastEditedById: me.id,
                  // B-05: make the refresh visible to the optimistic lock so a
                  // concurrent edit-approve sees VERSION_CONFLICT, not a silent
                  // revert of Temix-authoritative fields.
                  version: { increment: 1 },
                },
              });
              // Blueprint §8.3: the inbound refresh is what flips UPLOADED →
              // SYNCED. Guarded so a PENDING_UPLOAD row (correction approved
              // after the last batch) keeps its place in the queue.
              await tx.customer.updateMany({
                where: { id: existing!.id, temixSyncState: 'UPLOADED' },
                data: { temixSyncState: 'SYNCED' },
              });
              // TEMIX_SYNC_ACKED: the ERP code just landed for the first time —
              // tell the originating submitter their customer is live in Temix.
              if (!existing!.temixCode && first.temixCode && existing!.createdById) {
                await notifyUsers(tx, [existing!.createdById], {
                  kind: 'TEMIX_SYNC_ACKED',
                  title: 'Customer landed in Temix',
                  body: `${existing!.legalName} (${custCode}) is now in Temix as ${first.temixCode}.`,
                  customerId: existing!.id,
                });
              }
              customerId = existing!.id;
            } else {
              // SEC-03/09 (2): credit standing is approval-gated or ERP-authoritative,
              // never an ordinary-import side effect.
              //
              // A net-new CREDIT customer created in the app runs Salesman -> Supervisor
              // -> Finance Manager -> GM -> Accountant (lib/approval-chains.ts), and only
              // lib/create-finalize.ts may then write creditLimit/paymentTermDays. The
              // refresh lane above is the other legitimate writer: it is gated on
              // temix_code, i.e. the ERP said so. The ordinary customer edit cannot touch
              // terms at all -- services/edits.ts rejects any customer.paymentTerms change
              // outright (final-hunt #3), on the direct-write path too.
              //
              // THIS lane was the one hole. `isRefresh` above already claimed every
              // live-customer-with-temix_code case, and an archived customer carrying a
              // temix_code already threw, so a row reaching here carries no ERP authority
              // and no approver saw it -- yet it wrote `paymentTerms` on update and
              // paymentTerms + creditLimit + paymentTermDays on create. An ordinary sheet
              // could therefore mint a live CREDIT customer with any credit limit (the
              // parser does not even require credit_limit on a CREDIT row, so "CREDIT with
              // no limit" was reachable too), or flip an existing customer's terms, with
              // nothing anywhere in the trail.
              //
              // Two guards, in THIS order, so a sheet that merely RESTATES the terms
              // already on record stays idempotent. That ordering is not cosmetic: a
              // customer created through the credit chain is CREDIT with NO temix_code
              // until Temix acks it, so a blanket "CREDIT needs temix_code" would reject
              // its own correct row -- and the README promises re-import is safe.
              //   1. disagreement with what is stored -> hold, in either direction;
              //   2. a NEW customer asking for CREDIT with no temix_code -> hold.
              // Held, never silently written and never silently downgraded to CASH, using
              // the CROSSWALK convention already used in this function: the whole group is
              // REJECTED with a PII-free message on the row.
              //
              // This does NOT gate the go-live master load. Every row
              // scripts/golive/build-masters.ts emits carries temix_code (= the Temix base
              // code, which is also cust_code), so a CREDIT row from it passes guard 2 and
              // lands on the create branch below with its ERP figures intact.
              //
              // NOTE, corrected 2026-09-15: this used to add "a re-run finds it live with
              // a matching code and takes the refresh lane above". That was true and
              // beside the point — the FIRST run against the seeded production database is
              // indistinguishable from a re-run, so those rows took the refresh lane too
              // and silently skipped every identity and branch field. The lane test above
              // now also requires the customer to already carry a Temix code. One
              // consequence lands HERE: a seeded customer whose stored payment terms
              // disagree with the master now reaches guard 1 and is REJECTED for steward
              // review rather than being quietly narrowed to a credit-only update. That is
              // the intended behaviour — it is the same guard that stops a spreadsheet
              // granting credit standing — but it means the load can report rejections it
              // did not report before, and each one is a real disagreement worth reading.
              if (existing && first.paymentTermsPresent && pt !== existing.paymentTerms) {
                // Either direction. CASH->CREDIT grants credit standing no approver saw.
                // CREDIT->CASH is worse than it looks: this lane, unlike the refresh lane,
                // never nulls creditLimit/paymentTermDays, so the flip would leave a CASH
                // customer carrying a live credit limit that lib/temix.ts then suppresses
                // on export -- the CRM and the ERP would disagree, silently.
                throw new Error(
                  'CROSSWALK:payment_terms disagrees with the terms already recorded for this customer and the row carries no temix_code — refresh from Temix, or move the terms through the credit chain; steward review'
                );
              }
              if (!existing && pt === 'CREDIT' && !first.temixCode) {
                throw new Error(
                  'CROSSWALK:payment_terms is CREDIT but the row carries no temix_code — credit terms and limits come from Temix or from the credit approval chain, not from an ordinary import; steward review'
                );
              }
              const customer = await tx.customer.upsert({
                where: { nmwcCode: custCode },
                update: {
                  // Re-import of an EXISTING customer via a non-Temix row must not
                  // clobber CRM-owned data (adversarial-review CONFIRMED). Presence-
                  // aware, mirroring the refresh lane: an ABSENT payment_terms column
                  // must NOT flip a CREDIT customer to CASH, and a BLANK phone/CR/
                  // contact cell must NOT null the stored value. `undefined` = "leave
                  // unchanged". cust_name is mandatory (a blank row is quarantined),
                  // so legalName is always a real value here.
                  legalName: first.custName,
                  // SEC-03/09 (2): paymentTerms is deliberately NOT written here. On an
                  // EXISTING customer, terms are Temix-owned (the refresh lane above) or
                  // approval-owned (the credit create chain). The disagreement guard at
                  // the top of this branch already rejects any row that differs, so the
                  // only value that could reach this line is one that already matches what
                  // is stored -- writing it buys nothing and re-opens the hole if that
                  // guard is ever loosened. It also covers the one case the guard cannot
                  // see: if a concurrent insert made this upsert take the update path when
                  // `existing` read null, not writing terms fails in the safe direction.
                  // `undefined` = leave unchanged, same rule as phone/CR/contact below.
                  primaryPhone: first.phone ?? undefined,
                  primaryPhoneNorm: first.phone ?? undefined,
                  contactPerson: first.contactPerson ?? undefined,
                  crNumber: first.crNumber ?? undefined,
                  crNumberNorm: first.crNumber ? normalizeCR(first.crNumber) : undefined,
                  channelId: groupChannelId ?? undefined,
                  status: groupStatus ?? undefined,
                  lastEditedById: me.id,
                  // B-05: bump the optimistic version so a concurrent edit-approve
                  // sees VERSION_CONFLICT rather than a silently lost update.
                  version: { increment: 1 },
                },
                create: {
                  nmwcCode: custCode,
                  legalName: first.custName,
                  paymentTerms: pt,
                  primaryPhone: first.phone,
                  primaryPhoneNorm: first.phone,
                  contactPerson: first.contactPerson,
                  crNumber: first.crNumber,
                  crNumberNorm: normalizeCR(first.crNumber),
                  channelId: groupChannelId ?? null,
                  status: groupStatus ?? 'ACTIVE',
                  // Initial master load may carry the ERP code directly; credit
                  // figures land only on CREDIT rows.
                  temixCode: first.temixCode ?? null,
                  creditLimit: pt === 'CREDIT' ? (first.creditLimit ?? null) : null,
                  paymentTermDays: pt === 'CREDIT' ? (first.paymentTermDays ?? null) : null,
                  createdById: me.id,
                  lastEditedById: me.id,
                  importBatchId: batchId,
                },
              });
              customerId = customer.id;
            }
            if (!isRefresh) {
              for (const r of resolvedBranches) {
                // QA P-01 fix (branch-steal guard): branchCode is globally unique
                // and the upsert's update path includes customerId — without this
                // check, a sheet row claiming a code owned by ANOTHER customer
                // silently re-parents that customer's branch. Ownership moves are
                // steward-review territory, never a silent import side effect.
                // (Read-then-upsert inside this per-group tx; batch promote is
                // serialized by the atomic READY→PROMOTING claim, so the TOCTOU
                // window is not reachable through this action.)
                const branchOwner = await tx.branch.findUnique({
                  where: { branchCode: r.branchCode },
                  select: { customerId: true, customer: { select: { nmwcCode: true } } },
                });
                if (branchOwner && branchOwner.customerId !== customerId) {
                  throw new Error(
                    `CROSSWALK:branch_code ${r.branchCode} already belongs to ${branchOwner.customer.nmwcCode} — steward review`
                  );
                }
                // If composition changed the sheet's code, also check the RAW code:
                // a sheet code that exists under ANOTHER customer means the row
                // referenced someone else's branch (a data error) — flag it for
                // steward review instead of silently minting a re-prefixed code.
                if (r.sheetCode && r.sheetCode !== r.branchCode) {
                  const rawOwner = await tx.branch.findUnique({
                    where: { branchCode: r.sheetCode },
                    select: { customerId: true, customer: { select: { nmwcCode: true } } },
                  });
                  if (rawOwner && rawOwner.customerId !== customerId) {
                    throw new Error(
                      `CROSSWALK:branch_code ${r.sheetCode} already belongs to ${rawOwner.customer.nmwcCode} — steward review`
                    );
                  }
                }
                await tx.branch.upsert({
                  where: { branchCode: r.branchCode },
                  update: {
                    branchName: r.branchName,
                    regionId: r.regionId,
                    routeId: r.routeId,
                    address: r.address,
                    customerId,
                    dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? undefined,
                    status: (r.status as CustomerStatus | null) ?? undefined,
                    // EL-11: a status set by the load is a real status change.
                    lastStatusChangeAt: r.status ? new Date() : undefined,
                    lastEditedById: me.id,
                  },
                  create: {
                    branchCode: r.branchCode,
                    branchName: r.branchName,
                    regionId: r.regionId,
                    routeId: r.routeId,
                    address: r.address,
                    customerId,
                    dayOfVisit: (r.dayOfVisit as DayOfWeek | null) ?? null,
                    status: (r.status as CustomerStatus | null) ?? 'ACTIVE',
                    lastStatusChangeAt: r.status === 'CLOSED' ? new Date() : null,
                    createdById: me.id,
                    lastEditedById: me.id,
                  },
                });
              }
            }
            await tx.importRow.updateMany({
              where: { id: { in: g.rowIds } },
              data: { state: ImportRowState.PROMOTED, reviewedById: me.id, reviewedAt: new Date() },
            });
            // Compute completenessScore for the promoted customer. Without this,
            // every imported customer/branch stayed at 0, hiding them from
            // completeness-filtered worklists and skewing dashboard averages.
            const scored = await tx.customer.findUnique({
              where: { id: customerId },
              include: { branches: { where: { deletedAt: null } } },
            });
            if (scored) {
              await tx.customer.update({
                where: { id: customerId },
                data: { completenessScore: scoreCustomer(scored, scored.branches) },
              });
            }
          },
          // Bounded deliberately: the worst case a slice can produce is its budget
          // plus ONE long transaction, which still lands well inside maxDuration=60.
          { timeout: 20_000, maxWait: 10_000 }
        );
        promoted += g.rowIds.length;
        if (groupResolveErrors.length > 0 && !refreshedRow) {
          // F-17: surface the phantom-region warning in the row's issues so the
          // Steward can fix the reference data and re-run the import. Row stays
          // PROMOTED (the customer landed) but with a visible warning.
          // Skipped for refresh rows — their branches were deliberately never
          // touched, so a "assigned to UNASSIGNED" warning would be false.
          await prisma.importRow
            .updateMany({
              where: { id: { in: g.rowIds } },
              data: {
                issues: groupResolveErrors.map((m) => ({
                  field: '_resolve',
                  message: `${m}; assigned to UNASSIGNED`,
                })) as Prisma.InputJsonValue,
              },
            })
            .catch(() => undefined);
        }
      } catch (err) {
        // F-15: NEVER log the raw Prisma error message — it embeds the value
        // that triggered the constraint (phone, CR number) and would leak PII
        // into pino/Sentry. Log a structured short code + safe identifier
        // only.
        const code = (err as { code?: string })?.code ?? 'UNKNOWN';
        const meta = (err as { meta?: { target?: string[] } })?.meta?.target;
        // Phase 1 Temix crosswalk conflicts carry a deliberate, PII-safe
        // message (codes only, never phone/CR values) for the Steward.
        const crosswalk =
          err instanceof Error && err.message.startsWith('CROSSWALK:')
            ? err.message.slice('CROSSWALK:'.length)
            : null;

        // RK-3: a group that failed because the DATABASE hiccuped is NOT a rejected
        // customer. Rejecting it would be permanent — a REJECTED row leaves CLEAN,
        // so no later slice ever retries it and no screen offers to requeue it — and
        // the batch would still finish green, quietly short of customers.
        //
        // This matters far more now than before: promote used to be one short
        // request, and is now minutes of work across dozens of them, which is
        // exactly the window in which a pool timeout, a Neon compute resume or a
        // dropped connection shows up on go-live day.
        //
        // So: leave those rows CLEAN and let the next slice retry them. If the
        // failure is actually permanent the run stops on its own — the caller's
        // stall guard sees a slice that reduced nothing — which is a loud, visible,
        // retryable outcome instead of a silent loss.
        if (!crosswalk && isTransientDbError(err, code)) {
          deferred += g.rowIds.length;
          logger.warn({ code, custCode, batchId }, 'import.promote.row_deferred');
          continue;
        }

        logger.warn(
          { code, target: meta, custCode, batchId, crosswalk: !!crosswalk },
          'import.promote.row_failed'
        );
        // Mark the failed row(s) REJECTED in a SEPARATE transaction so the
        // failure persists even though the row-level promote rolled back.
        const reason =
          crosswalk ??
          (code === 'P2002' ? `duplicate ${(meta ?? []).join(', ')}` : `promote failed (${code})`);
        try {
          await prisma.importRow.updateMany({
            where: { id: { in: g.rowIds } },
            data: {
              state: ImportRowState.REJECTED,
              issues: [{ field: '_promote', message: reason }] as Prisma.InputJsonValue,
              reviewedById: me.id,
              reviewedAt: new Date(),
            },
          });
        } catch (e) {
          logger.error({ err: (e as Error).message?.slice(0, 80), batchId }, 'import.mark_failed');
        }
        failures.push({ custCode, rowIds: g.rowIds, reason });
      }
    }

    // RK-3: rows leave CLEAN as they are promoted or rejected, so ONE grouped count
    // yields both the work remaining and the authoritative totals.
    //
    // The counters are DERIVED from the row states rather than incremented per
    // slice, which makes them self-healing. Incrementing loses count whenever a
    // slice commits its rows but dies before updating the batch — an interrupted
    // UAT load did exactly that and reported 294 promoted against 299 rows actually
    // promoted, understating a load the operator has to trust.
    const stateCounts = await prisma.importRow.groupBy({
      by: ['state'],
      where: { batchId },
      _count: { _all: true },
    });
    const countOf = (s: ImportRowState) => stateCounts.find((c) => c.state === s)?._count._all ?? 0;
    const remaining = countOf(ImportRowState.CLEAN);
    const done = remaining === 0;

    // GUARDED by our own token: if this slice ran long and the batch was taken over,
    // the new owner is authoritative and we must not write status, counters, or the
    // lease. Our committed rows are already durable and their counters are derived,
    // so the new owner's next slice reports them correctly.
    const finalize = await prisma.importBatch.updateMany({
      where: { id: batchId, promoteLeaseBy: leaseToken },
      data: {
        // Stay PROMOTING while work remains — that state now means "in progress or
        // interrupted, resumable". Only the slice that clears the last CLEAN row
        // finalises the batch.
        status: done ? 'PROMOTED' : 'PROMOTING',
        promotedRows: countOf(ImportRowState.PROMOTED),
        rejectedRows: countOf(ImportRowState.REJECTED),
        // Done → release outright. Otherwise hold a SHORT grace so the batch still
        // reads as "in progress" until this run comes back (it returns immediately,
        // carrying the token), while an abandoned run frees it in seconds.
        promoteLeaseBy: done ? null : leaseToken,
        promoteLeaseUntil: done ? null : new Date(Date.now() + PROMOTE_HANDOFF_GRACE_MS),
      },
    });
    if (finalize.count === 0) {
      logger.warn({ batchId }, 'import.promote.lease_lost');
    }

    // F-19: per-batch summary audit log. Without this, "what happened in last
    // week's import?" requires SQL spelunking. The row carries the actor, the
    // counts, and the failure list (codes only — no embedded values).
    // DG-06/07: the swallow stays — the durable record of this slice is the
    // ImportBatch counters written just above plus every ImportRow's own
    // PROMOTED/REJECTED state, and throwing here would abort a slice whose
    // customer rows are already committed, sending the batch down the catch
    // path that releases the lease. The loss is already logged, which is what
    // makes keeping it defensible.
    await writeAudit(null, env, {
      action: 'IMPORT',
      entityType: 'ImportBatch',
      entityId: batchId,
      after: {
        kind: 'CUSTOMER',
        totalGroups: groups.size,
        groupsInSlice: processedGroups,
        promoted,
        failed: failures.length,
        deferred,
        remaining,
        final: done,
        failureCustCodes: failures.map((f) => f.custCode).slice(0, 100),
      } as unknown as Prisma.InputJsonValue,
      // One audit row per slice: a resumed load leaves a complete, ordered trail
      // instead of a single summary that hides how the batch actually landed.
      reason: done ? 'customer_master_promote' : 'customer_master_promote_slice',
    }).catch((e) => {
      logger.warn({ err: (e as Error).message?.slice(0, 80) }, 'import.audit_failed');
    });

    // Only the FINAL slice revalidates. An intermediate slice revalidating would
    // re-render the batch page (and re-run its queries) after every pass — dozens of
    // wasted round trips during a big load, slowing the very loop it interrupts. The
    // button reports its own progress meanwhile, and refreshes when the loop ends.
    if (done) {
      revalidatePath('/import');
      revalidatePath(`/import/${batchId}`); // otherwise the detail page keeps the stale READY view + a live Promote button
    }
    return {
      promoted,
      failed: failures.length,
      deferred,
      remaining,
      done,
      // Only hand the token back while the run should continue, and only if we still
      // hold the batch — a lost lease must stop the run, not let it fight the new owner.
      ...(done || finalize.count === 0 ? {} : { leaseToken }),
    };
  } catch (err) {
    // Release the lease so the batch is never stranded (final-hunt #23). The status
    // stays PROMOTING, which under RK-3 means "interrupted, resumable" rather than a
    // dead end — the work already committed by earlier slices is kept, and the
    // Steward (or the expiring lease) can pick it up again. Marking it FAILED here
    // would throw away a half-finished master load.
    // Guard on status=PROMOTING so we never clobber a batch another action moved on.
    // Guarded by our token for the same reason as the success path: if the batch was
    // already taken over, releasing here would clear the NEW owner's lease.
    await prisma.importBatch
      .updateMany({
        where: { id: batchId, status: 'PROMOTING', promoteLeaseBy: leaseToken },
        data: { promoteLeaseBy: null, promoteLeaseUntil: null },
      })
      .catch(() => {});
    logger.error({ err: (err as Error).message?.slice(0, 120), batchId }, 'import.promote_aborted');
    throw err;
  }
}

// helper to format counter-style code if NMWC code is missing in input
export { formatCustomerCode };
