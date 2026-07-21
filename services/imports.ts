'use server';

import { prisma } from '@/lib/db';
import { Role, ImportRowState, type Prisma } from '@prisma/client';
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
  return String(v ?? '').trim().toLowerCase();
}
function uc(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

// QA-012: hard cap on uploaded xlsx (zip-bomb defense)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

export async function uploadAccountMasterAction(
  formData: FormData
): SafeAction<{ batchId: string; clean: number; issues: number }> {
  return runAction(() => uploadAccountMasterCore(formData));
}

async function uploadAccountMasterCore(
  formData: FormData
): Promise<{ batchId: string; clean: number; issues: number }> {
  const me = await requireSteward();
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
      const wantsReset = String(row.reset_password ?? row.resetPassword ?? '')
        .trim()
        .toLowerCase() === 'yes';
      // QA-011: role changes must be EXPLICITLY requested via change_role column.
      const wantsRoleChange = String(row.change_role ?? row.changeRole ?? '')
        .trim()
        .toLowerCase() === 'yes';
      const supUsername = lc(row.supervisor_username ?? row.supervisorUsername ?? '');
      const routeCode = uc(row.route_code ?? row.routeCode ?? '');
      const regionCodesRaw = String(row.region_codes ?? row.regionCodes ?? '').trim();
      const email = String(row.email ?? '').trim() || null;
      const phone = String(row.phone ?? '').trim() || null;

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
      if (passwordRaw && passwordRaw.length < 12) {
        issues.push({ sheet: 'Users', row: sheetRow, message: 'password must be 12+ chars' });
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
        issues.push({ sheet: 'Users', row: sheetRow, message: 'cannot change your own role via import' });
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
          await prisma.auditLog.createMany({
            data: displacedOwners.map((u) => ({
              actorId: me.id,
              action: 'REASSIGN' as const,
              entityType: 'User',
              entityId: u.id,
              before: { ownedRouteCode: routeCode } as unknown as Prisma.InputJsonValue,
              after: { ownedRouteCode: null } as unknown as Prisma.InputJsonValue,
              reason: `route ${routeCode} reassigned to ${username} via import`,
            })),
          });
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
      if (!existing || wantsRoleChange) update.role = role;

      const data: Prisma.UserCreateInput = {
        username,
        passwordHash,
        fullName,
        role,
        email,
        phone,
      };
      if (supervisorId) data.supervisor = { connect: { id: supervisorId } };
      if (ownedRouteId) data.ownedRoute = { connect: { id: ownedRouteId } };

      try {
        const user = await prisma.user.upsert({
          where: { username },
          update,
          create: data,
        });
        // Audit any sensitive change
        if (existing && wantsReset) {
          await prisma.auditLog.create({
            data: {
              actorId: me.id,
              action: 'UPDATE',
              entityType: 'User',
              entityId: user.id,
              reason: 'password_reset_via_import',
            },
          });
        }
        if (existing && wantsRoleChange && existing.role !== role) {
          await prisma.auditLog.create({
            data: {
              actorId: me.id,
              action: 'UPDATE',
              entityType: 'User',
              entityId: user.id,
              before: { role: existing.role } as unknown as Prisma.InputJsonValue,
              after: { role } as unknown as Prisma.InputJsonValue,
              reason: 'role_change_via_import',
            },
          });
        }

        // Manager region assignments
        if (role === Role.MANAGER && regionCodesRaw) {
          const codes = regionCodesRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
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
  await prisma.auditLog
    .create({
      data: {
        actorId: me.id,
        action: 'IMPORT',
        entityType: 'ImportBatch',
        entityId: batch.id,
        after: {
          kind: 'ACCOUNT',
          clean: cleanCount,
          issues: issues.length,
        } as unknown as Prisma.InputJsonValue,
        reason: 'account_master_upload',
      },
    })
    .catch(() => undefined);

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
    const crNorm = normalizeCR(
      String(row.cr_no ?? row['CR NO'] ?? '').trim() || null
    );
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
      issues.push({ field: 'phone', message: `duplicate phone in this file (also rows ${phoneOtherRows.join(', ')})` });
    }
    if (phone && (masterPhones.get(phone) ?? []).some((code) => code !== custCode)) {
      issues.push({ field: 'phone', message: 'phone already exists in master — review in /duplicates' });
    }
    const crOtherRows = crNorm
      ? (crsInFile.get(crNorm) ?? []).filter((e) => e.code !== custCode).map((e) => e.row)
      : [];
    if (crOtherRows.length > 0) {
      issues.push({ field: 'cr_no', message: `duplicate CR in this file (also rows ${crOtherRows.join(', ')})` });
    }
    if (crNorm && (masterCrs.get(crNorm) ?? []).some((code) => code !== custCode)) {
      issues.push({ field: 'cr_no', message: 'CR already exists in master — review in /duplicates' });
    }
    // F-12: strict whitelist on payment terms — silently defaulting `Crdit`
    // to CASH ate the field-lock semantics for credit customers.
    // `paymentTermsPresent` records whether the sheet EXPLICITLY stated a
    // value: the Temix-refresh lane must distinguish "column absent — keep
    // the customer's current terms" from "Temix says CASH" (an absent column
    // silently flipping CREDIT customers to CASH was an adversarial-review
    // CONFIRMED finding). Legacy create/full-upsert paths keep the CASH
    // default unchanged.
    const ptRaw = String(row.payment_terms ?? row['PAYMENT TERMS'] ?? '').trim().toUpperCase();
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
        issues.push({ field, message: 'cell starts with a spreadsheet formula trigger; remove it' });
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
        issues.push({ field: 'credit_limit', message: `expected a non-negative number, got "${creditRaw}"` });
      } else {
        creditLimit = Math.round(n * 1000) / 1000;
      }
    }
    let paymentTermDays: number | null = null;
    const termRaw = String(row.payment_term_days ?? row['PAYMENT TERM DAYS'] ?? '').trim();
    if (termRaw) {
      const n = Number(termRaw);
      if (!Number.isInteger(n) || n < 0 || n > 365) {
        issues.push({ field: 'payment_term_days', message: `expected whole days 0-365, got "${termRaw}"` });
      } else {
        paymentTermDays = n;
      }
    }

    const parsed = {
      custCode,
      custName,
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

export async function promoteCustomerBatchAction(
  formData: FormData
): SafeAction<{ promoted: number; failed: number }> {
  return runAction(() => promoteCustomerBatchCore(formData));
}

async function promoteCustomerBatchCore(
  formData: FormData
): Promise<{ promoted: number; failed: number }> {
  const me = await requireSteward();
  const batchId = String(formData.get('batchId') ?? '');
  if (!batchId) throw new ValidationError({ batchId: 'required' });
  // F-07: claim the batch atomically. updateMany returns count=1 only for the
  // first promote of a READY batch — subsequent re-clicks (or two Stewards)
  // see count=0 and surface a clear conflict instead of interleaving upserts.
  const claim = await prisma.importBatch.updateMany({
    where: { id: batchId, status: 'READY' },
    data: { status: 'PROMOTING' },
  });
  if (claim.count === 0) {
    const cur = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    throw new ValidationError({
      batchId: `Batch is in state ${cur?.status ?? '<missing>'} — only READY batches can be promoted.`,
    });
  }
  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: batchId } });
  if (batch.kind !== 'CUSTOMER') throw new ValidationError({ batchId: 'not a customer import' });

  const cleanRows = await prisma.importRow.findMany({
    where: { batchId, state: ImportRowState.CLEAN },
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

  // Build region+route caches and ensure UNASSIGNED route exists
  let unassignedRoute = await prisma.route.findUnique({ where: { code: 'UNASSIGNED' } });
  if (!unassignedRoute) {
    let unassignedRegion = await prisma.region.findUnique({ where: { code: 'UNASSIGNED' } });
    if (!unassignedRegion) {
      unassignedRegion = await prisma.region.create({
        data: { code: 'UNASSIGNED', name: 'Unassigned' },
      });
    }
    unassignedRoute = await prisma.route.create({
      data: { code: 'UNASSIGNED', name: 'Unassigned', regionId: unassignedRegion.id },
    });
  }

  // QA-019: each customer's promotion (parent + branches + row state) runs
  // in its own transaction so a partial failure leaves no half-state.
  // F-03: per-row failures now mark the row as REJECTED with the error
  // message in `issues`, and the action returns a `{ promoted, failed }`
  // tuple that the UI surfaces in the toast — no more silent swallow.
  let promoted = 0;
  const failures: Array<{ custCode: string; rowIds: string[]; reason: string }> = [];
  for (const [custCode, g] of groups) {
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
    }> = [];
    const groupResolveErrors: string[] = [];
    for (const [bi, p] of g.parsed.entries()) {
      // F-17: refuse to silently auto-create unknown regions/routes. Phantom
      // regions invented by typos are the source of CHAIN-09 (an unscoped
      // Manager later falls into them). Only Existing region/route codes
      // resolve; everything else falls back to UNASSIGNED with a flag in
      // the audit log so the Steward can fix.
      const region = p.regionCode
        ? await prisma.region.findUnique({ where: { code: p.regionCode.toUpperCase() } })
        : null;
      if (p.regionCode && !region) {
        groupResolveErrors.push(`region "${p.regionCode}" not found`);
      }
      const route = p.routeCode
        ? await prisma.route.findUnique({ where: { code: p.routeCode.toUpperCase() } })
        : null;
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
        address:
          p.address ??
          [p.branchName, p.regionCode].filter(Boolean).join(', ') ??
          'Address pending',
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
      if (seenBranchCodes.has(r.branchCode)) { dupBranchCode = r.branchCode; break; }
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
            issues: [{ field: '_promote', message: `duplicate branch_code ${dupBranchCode} within this customer` }] as Prisma.InputJsonValue,
            reviewedById: me.id,
            reviewedAt: new Date(),
          },
        })
        .catch(() => undefined);
      continue;
    }

    try {
      let refreshedRow = false;
      await prisma.$transaction(async (tx) => {
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

        const isRefresh = !!existing && !existing.deletedAt && !!first.temixCode;
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
              paymentTerms: first.paymentTermsPresent ? pt : undefined,
              primaryPhone: first.phone ?? undefined,
              primaryPhoneNorm: first.phone ?? undefined,
              contactPerson: first.contactPerson ?? undefined,
              crNumber: first.crNumber ?? undefined,
              crNumberNorm: first.crNumber ? normalizeCR(first.crNumber) : undefined,
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
                lastEditedById: me.id,
              },
              create: {
                branchCode: r.branchCode,
                branchName: r.branchName,
                regionId: r.regionId,
                routeId: r.routeId,
                address: r.address,
                customerId,
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
      });
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
      logger.warn(
        { code, target: meta, custCode, batchId, crosswalk: !!crosswalk },
        'import.promote.row_failed'
      );
      // Mark the failed row(s) REJECTED in a SEPARATE transaction so the
      // failure persists even though the row-level promote rolled back.
      const reason =
        crosswalk ??
        (code === 'P2002'
          ? `duplicate ${(meta ?? []).join(', ')}`
          : `promote failed (${code})`);
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

  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: 'PROMOTED',
      promotedRows: promoted,
      rejectedRows: failures.reduce((acc, f) => acc + f.rowIds.length, 0),
    },
  });

  // F-19: per-batch summary audit log. Without this, "what happened in last
  // week's import?" requires SQL spelunking. The row carries the actor, the
  // counts, and the failure list (codes only — no embedded values).
  await prisma.auditLog
    .create({
      data: {
        actorId: me.id,
        action: 'IMPORT',
        entityType: 'ImportBatch',
        entityId: batchId,
        after: {
          kind: 'CUSTOMER',
          totalGroups: groups.size,
          promoted,
          failed: failures.length,
          failureCustCodes: failures.map((f) => f.custCode).slice(0, 100),
        } as unknown as Prisma.InputJsonValue,
        reason: 'customer_master_promote',
      },
    })
    .catch((e) => {
      logger.warn({ err: (e as Error).message?.slice(0, 80) }, 'import.audit_failed');
    });

  revalidatePath('/import');
  revalidatePath(`/import/${batchId}`); // the batch detail page shows the now-stale READY view + a live Promote button otherwise
  return { promoted, failed: failures.length };
}

// helper to format counter-style code if NMWC code is missing in input
export { formatCustomerCode };
