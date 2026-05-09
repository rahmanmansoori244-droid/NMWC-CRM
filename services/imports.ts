'use server';

import { prisma } from '@/lib/db';
import { Role, ImportRowState, type Prisma } from '@prisma/client';
import { auth } from '@/lib/auth';
import { ForbiddenError, ValidationError, RateLimitError } from '@/lib/errors';
import { revalidatePath } from 'next/cache';
import { parseWorkbook } from '@/lib/excel';
import { normalizePhone, isValidPhoneFormat } from '@/lib/phone';
import { normalizeCR } from '@/lib/cr';
import { formatCustomerCode, formatBranchCode } from '@/lib/codes';
import { checkLimit } from '@/lib/rate-limit';
import bcrypt from 'bcryptjs';
import { logger } from '@/lib/logger';

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

const VALID_ROLES: Role[] = [Role.SALESMAN, Role.SUPERVISOR, Role.MANAGER, Role.STEWARD, Role.VIEWER];

function lc(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}
function uc(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

// QA-012: hard cap on uploaded xlsx (zip-bomb defense)
const MAX_IMPORT_BYTES = 5 * 1024 * 1024; // 5 MB

export async function uploadAccountMasterAction(formData: FormData) {
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
    const sortedRows = [...usersSheet.rows].sort((a, b) => {
      const ra = uc(a.role);
      const rb = uc(b.role);
      const order = ['MANAGER', 'STEWARD', 'SUPERVISOR', 'SALESMAN', 'VIEWER'];
      return order.indexOf(ra) - order.indexOf(rb);
    });
    for (const [i, row] of sortedRows.entries()) {
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
          row: i + 2,
          message: 'username, full_name, role required',
        });
        continue;
      }
      if (!VALID_ROLES.includes(roleStr as Role)) {
        issues.push({
          sheet: 'Users',
          row: i + 2,
          message: `role "${roleStr}" not one of ${VALID_ROLES.join(', ')}`,
        });
        continue;
      }
      if (passwordRaw && passwordRaw.length < 12) {
        issues.push({ sheet: 'Users', row: i + 2, message: 'password must be 12+ chars' });
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
        issues.push({ sheet: 'Users', row: i + 2, message: 'cannot change your own role via import' });
        continue;
      }
      // (b) New MANAGER / STEWARD via import — refuse outright. Forces the
      // Manager-driven /users UI for any admin-tier creation.
      if (!targetExisting && (role === Role.MANAGER || role === Role.STEWARD)) {
        issues.push({
          sheet: 'Users',
          row: i + 2,
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
          row: i + 2,
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
            row: i + 2,
            message: `supervisor "${supUsername}" not found`,
          });
          continue;
        }
        supervisorId = sup.id;
      }

      let ownedRouteId: string | null = null;
      if (role === Role.SALESMAN) {
        if (!routeCode) {
          issues.push({ sheet: 'Users', row: i + 2, message: 'salesman needs route_code' });
          continue;
        }
        const route = await prisma.route.findUnique({ where: { code: routeCode } });
        if (!route) {
          issues.push({
            sheet: 'Users',
            row: i + 2,
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
              row: i + 2,
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
            row: i + 2,
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
        supervisor: supervisorId ? { connect: { id: supervisorId } } : { disconnect: true },
        ownedRoute: ownedRouteId ? { connect: { id: ownedRouteId } } : { disconnect: true },
      };
      // Only rotate password / role when explicitly authorised
      if (wantsReset) update.passwordHash = passwordHash;
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
        issues.push({ sheet: 'Users', row: i + 2, message: (err as Error).message });
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

export async function uploadCustomerMasterAction(formData: FormData) {
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
  const phonesInFile = new Map<string, number[]>();
  const crsInFile = new Map<string, number[]>();
  for (const [i, row] of sheet.rows.entries()) {
    const phoneNorm = normalizePhone(
      String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
    );
    if (phoneNorm) {
      const a = phonesInFile.get(phoneNorm) ?? [];
      a.push(i + 2);
      phonesInFile.set(phoneNorm, a);
    }
    const crNorm = normalizeCR(
      String(row.cr_no ?? row['CR NO'] ?? '').trim() || null
    );
    if (crNorm) {
      const a = crsInFile.get(crNorm) ?? [];
      a.push(i + 2);
      crsInFile.set(crNorm, a);
    }
  }
  // Cross-check against the live master in one query each.
  const phoneList = [...phonesInFile.keys()];
  const crList = [...crsInFile.keys()];
  const masterPhones = phoneList.length
    ? new Set(
        (
          await prisma.customer.findMany({
            where: { primaryPhoneNorm: { in: phoneList }, deletedAt: null },
            select: { primaryPhoneNorm: true },
          })
        )
          .map((c) => c.primaryPhoneNorm)
          .filter((p): p is string => !!p)
      )
    : new Set<string>();
  const masterCrs = crList.length
    ? new Set(
        (
          await prisma.customer.findMany({
            where: { crNumberNorm: { in: crList }, deletedAt: null },
            select: { crNumberNorm: true },
          })
        )
          .map((c) => c.crNumberNorm)
          .filter((p): p is string => !!p)
      )
    : new Set<string>();

  for (const [i, row] of sheet.rows.entries()) {
    const issues: { field: string; message: string }[] = [];
    // F-05: stripHtml on every text field at parse time so nothing hostile
    // reaches the master. Then re-screen for spreadsheet formula prefixes.
    const custCode = stripHtml(
      row.cust_code ?? row.custcode ?? row.CUSTCODE ?? row.code ?? row.Code
    ).trim();
    const custName = stripHtml(row.cust_name ?? row['CUST NAME'] ?? row.name);
    const phoneRaw = String(row.phone ?? '').trim();
    const phone = normalizePhone(
      String(row.phone ?? row.PHONE ?? row['Primary Phone'] ?? '').trim() || null
    );
    const crNorm = normalizeCR(String(row.cr_no ?? row['CR NO'] ?? '').trim() || null);

    if (!custCode) issues.push({ field: 'cust_code', message: 'required' });
    if (!custName) issues.push({ field: 'cust_name', message: 'required' });
    if (phoneRaw && !isValidPhoneFormat(phoneRaw)) {
      issues.push({ field: 'phone', message: 'invalid format' });
    }
    if (phone && phonesInFile.get(phone)!.length > 1) {
      issues.push({ field: 'phone', message: `duplicate phone in this file (also rows ${phonesInFile.get(phone)!.filter((r) => r !== i + 2).join(', ')})` });
    }
    if (phone && masterPhones.has(phone)) {
      issues.push({ field: 'phone', message: 'phone already exists in master — review in /duplicates' });
    }
    if (crNorm && crsInFile.get(crNorm)!.length > 1) {
      issues.push({ field: 'cr_no', message: `duplicate CR in this file (also rows ${crsInFile.get(crNorm)!.filter((r) => r !== i + 2).join(', ')})` });
    }
    if (crNorm && masterCrs.has(crNorm)) {
      issues.push({ field: 'cr_no', message: 'CR already exists in master — review in /duplicates' });
    }
    // F-12: strict whitelist on payment terms — silently defaulting `Crdit`
    // to CASH ate the field-lock semantics for credit customers.
    const ptRaw = String(row.payment_terms ?? row['PAYMENT TERMS'] ?? '').trim().toUpperCase();
    let paymentTerms = 'CASH';
    if (ptRaw && ptRaw !== 'CASH' && ptRaw !== 'CREDIT') {
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

export async function promoteCustomerBatchAction(formData: FormData) {
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
      const effectiveRegionId = (region ?? unassignedRoute!).id;
      const effectiveRouteId = (route ?? unassignedRoute!).id;
      resolvedBranches.push({
        branchCode: p.branchCode
          ? p.branchCode.toUpperCase()
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

    try {
      await prisma.$transaction(async (tx) => {
        const customer = await tx.customer.upsert({
          where: { nmwcCode: custCode },
          update: {
            legalName: first.custName,
            paymentTerms: first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH',
            primaryPhone: first.phone,
            primaryPhoneNorm: first.phone,
            contactPerson: first.contactPerson,
            crNumber: first.crNumber,
            crNumberNorm: normalizeCR(first.crNumber),
            lastEditedById: me.id,
          },
          create: {
            nmwcCode: custCode,
            legalName: first.custName,
            paymentTerms: first.paymentTerms === 'CREDIT' ? 'CREDIT' : 'CASH',
            primaryPhone: first.phone,
            primaryPhoneNorm: first.phone,
            contactPerson: first.contactPerson,
            crNumber: first.crNumber,
            crNumberNorm: normalizeCR(first.crNumber),
            createdById: me.id,
            lastEditedById: me.id,
            importBatchId: batchId,
          },
        });
        for (const r of resolvedBranches) {
          await tx.branch.upsert({
            where: { branchCode: r.branchCode },
            update: {
              branchName: r.branchName,
              regionId: r.regionId,
              routeId: r.routeId,
              address: r.address,
              customerId: customer.id,
              lastEditedById: me.id,
            },
            create: {
              branchCode: r.branchCode,
              branchName: r.branchName,
              regionId: r.regionId,
              routeId: r.routeId,
              address: r.address,
              customerId: customer.id,
              createdById: me.id,
              lastEditedById: me.id,
            },
          });
        }
        await tx.importRow.updateMany({
          where: { id: { in: g.rowIds } },
          data: { state: ImportRowState.PROMOTED, reviewedById: me.id, reviewedAt: new Date() },
        });
      });
      promoted += g.rowIds.length;
      if (groupResolveErrors.length > 0) {
        // F-17: surface the phantom-region warning in the row's issues so the
        // Steward can fix the reference data and re-run the import. Row stays
        // PROMOTED (the customer landed) but with a visible warning.
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
      logger.warn(
        { code, target: meta, custCode, batchId },
        'import.promote.row_failed'
      );
      // Mark the failed row(s) REJECTED in a SEPARATE transaction so the
      // failure persists even though the row-level promote rolled back.
      const reason =
        code === 'P2002'
          ? `duplicate ${(meta ?? []).join(', ')}`
          : `promote failed (${code})`;
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
  return { promoted, failed: failures.length };
}

// helper to format counter-style code if NMWC code is missing in input
export { formatCustomerCode };
